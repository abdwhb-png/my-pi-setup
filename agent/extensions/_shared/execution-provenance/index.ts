import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
    ExtensionAPI,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
    clearSandboxExecutionContexts,
    mergeSandboxContextForFailure,
    sandboxExecutionContextFromDetails,
} from "../sandbox-runtime/execution-context.ts";
import {
    hostExecution,
    unknownExecution,
    type ExecutionProvenance,
} from "./types.ts";
export {
    hostExecution,
    unknownExecution,
    type ExecutionObserver,
    type ExecutionProvenance,
} from "./types.ts";

const KEY = Symbol.for("pi.execution-provenance.v1");
const CONTEXT_RECEIPT = Symbol.for("pi.execution-provenance.context.v1");
interface Registry {
    records: Map<string, ExecutionProvenance>;
}
function registry(): Registry {
    const globals = globalThis as typeof globalThis & { [KEY]?: Registry };
    return (globals[KEY] ??= { records: new Map() });
}

export function recordExecution(
    id: string,
    execution: ExecutionProvenance,
): void {
    registry().records.set(id, { ...execution });
}

export function withExecutionError(
    error: unknown,
    execution: ExecutionProvenance,
): Error {
    const result = error instanceof Error ? error : new Error(String(error));
    Object.defineProperty(result, "execution", {
        value: { ...execution },
        configurable: true,
    });
    return result;
}

export async function executeOnHost<T>(
    id: string,
    run: () => Promise<T>,
): Promise<T> {
    recordExecution(id, { ...hostExecution(), outcome: "pending" });
    try {
        const result = await run();
        recordExecution(id, hostExecution());
        return result;
    } catch (error) {
        recordExecution(id, { ...hostExecution(), outcome: "failed" });
        throw error;
    }
}

export function executionFromDetails(
    details: unknown,
): ExecutionProvenance | undefined {
    if (!details || typeof details !== "object" || !("execution" in details))
        return;
    return parseExecutionProvenance(details.execution);
}

export function parseExecutionProvenance(
    value: unknown,
): ExecutionProvenance | undefined {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (
        ![
            record.status,
            record.profile,
            record.backend,
            record.tmpNamespace,
            record.phase,
            record.outcome,
        ].every((member) => typeof member === "string")
    )
        return;
    if (
        !["sandboxed", "unsandboxed", "unknown"].includes(
            String(record.status),
        ) ||
        ![
            "bash-general",
            "think-strict",
            "analysis-strict",
            "none",
            "unknown",
        ].includes(String(record.profile)) ||
        !["zerobox", "local", "host", "unknown"].includes(
            String(record.backend),
        ) ||
        !["host", "lease-private", "unknown"].includes(
            String(record.tmpNamespace),
        ) ||
        ![
            "setup",
            "process",
            "source",
            "analysis",
            "policy",
            "cleanup",
        ].includes(String(record.phase)) ||
        ![
            "pending",
            "succeeded",
            "failed",
            "aborted",
            "timed-out",
            "blocked",
        ].includes(String(record.outcome)) ||
        (record.shellProfile !== undefined &&
            (typeof record.shellProfile !== "string" ||
                !["isolated", "integrated", "host"].includes(
                    record.shellProfile,
                ))) ||
        (record.hostCapability !== undefined &&
            (typeof record.hostCapability !== "string" ||
                !["editor", "dependencies", "dev-services"].includes(
                    record.hostCapability,
                ))) ||
        (record.exitCode !== undefined &&
            record.exitCode !== null &&
            !Number.isSafeInteger(record.exitCode))
    )
        return;
    // All members of the owned wire contract have been validated above.
    return {
        status: record.status,
        profile: record.profile,
        backend: record.backend,
        tmpNamespace: record.tmpNamespace,
        phase: record.phase,
        outcome: record.outcome,
        ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
        ...(record.shellProfile !== undefined
            ? { shellProfile: record.shellProfile }
            : {}),
        ...(record.hostCapability !== undefined
            ? { hostCapability: record.hostCapability }
            : {}),
    } as ExecutionProvenance;
}

export function resolveExecution(
    id: string,
    details?: unknown,
): ExecutionProvenance {
    return (
        executionFromDetails(details) ??
        registry().records.get(id) ??
        unknownExecution()
    );
}

export function mergeExecutionDetails(
    details: unknown,
    execution: ExecutionProvenance,
) {
    return {
        ...(details && typeof details === "object" && !Array.isArray(details)
            ? details
            : details === undefined
              ? {}
              : { originalDetails: details }),
        execution: { ...execution },
    };
}

function thinkReceipt(
    toolName: string,
    content: readonly { type: string; text?: string }[],
) {
    if (toolName !== "think_execute") return;
    const first = content[0];
    if (first?.type !== "text" || !first.text) return;
    try {
        const header: unknown = JSON.parse(first.text);
        if (
            !header ||
            typeof header !== "object" ||
            !("sourceExecution" in header) ||
            !("analysisExecution" in header)
        )
            return;
        const sourceExecution = parseExecutionProvenance(
            header.sourceExecution,
        );
        const analysisExecution = parseExecutionProvenance(
            header.analysisExecution,
        );
        if (sourceExecution && analysisExecution)
            return { sourceExecution, analysisExecution };
    } catch {
        /* Older and non-JSON results have no verified receipt. */
    }
}

function archiveContext(details: unknown): string {
    if (
        !details ||
        typeof details !== "object" ||
        !("outputArchive" in details)
    )
        return "";
    const archive = details.outputArchive;
    if (
        !archive ||
        typeof archive !== "object" ||
        !("kind" in archive) ||
        archive.kind !== "output-text"
    )
        return "";
    return `\nOutput archive: ${JSON.stringify({ kind: "output-text", sourceExecution: "sourceExecution" in archive ? (parseExecutionProvenance(archive.sourceExecution) ?? unknownExecution()) : unknownExecution(), storage: "storage" in archive ? (parseExecutionProvenance(archive.storage) ?? unknownExecution()) : unknownExecution() })}`;
}

function sandboxFailureContext(isError: boolean, details: unknown): string {
    if (!isError) return "";
    const context = sandboxExecutionContextFromDetails(details);
    return context
        ? `\nSandbox environment at dispatch (facts, not a causal diagnosis): ${JSON.stringify(context)}`
        : "";
}

/** Decorate a context copy, leaving persisted output and raw archives untouched. */
export function addExecutionContext(
    messages: AgentMessage[],
    entries: readonly SessionEntry[] = [],
): AgentMessage[] {
    const bashExecutions = new Map<number, ExecutionProvenance>();
    const pending = new Map<string, ExecutionProvenance[]>();
    for (const entry of entries) {
        if (
            entry.type === "custom" &&
            entry.customType === "pi.execution.user-bash.v1" &&
            entry.data &&
            typeof entry.data === "object" &&
            "command" in entry.data &&
            typeof entry.data.command === "string"
        ) {
            const execution = executionFromDetails(entry.data);
            if (execution)
                pending.set(entry.data.command, [
                    ...(pending.get(entry.data.command) ?? []),
                    execution,
                ]);
        } else if (
            entry.type === "message" &&
            entry.message.role === "bashExecution"
        ) {
            const candidates = pending.get(entry.message.command);
            // Overlapping identical commands cannot be attributed reliably through Pi's bash message schema.
            if (candidates?.length === 1)
                bashExecutions.set(entry.message.timestamp, candidates[0]);
            pending.delete(entry.message.command);
        }
    }
    return messages.map((message) => {
        if (Reflect.get(message, CONTEXT_RECEIPT) === true) return message;
        if (message.role === "bashExecution")
            return {
                ...message,
                [CONTEXT_RECEIPT]: true,
                output: `${message.output}\nExecution provenance: ${JSON.stringify(bashExecutions.get(message.timestamp) ?? unknownExecution())}`,
            };
        if (message.role !== "toolResult") return message;
        const details: unknown = message.details;
        if (
            details &&
            typeof details === "object" &&
            "sandboxContextReceiptVisible" in details &&
            details.sandboxContextReceiptVisible === true
        )
            return message;
        if (
            details &&
            typeof details === "object" &&
            "executionReceiptVisible" in details &&
            details.executionReceiptVisible === true
        )
            return message;
        // Think owns a JSON header with separate source and analysis executions.
        if (thinkReceipt(message.toolName, message.content)) {
            const context = sandboxFailureContext(message.isError, details);
            if (!context) return message;
            return {
                ...message,
                details: {
                    ...(details && typeof details === "object" ? details : {}),
                    sandboxContextReceiptVisible: true,
                },
                content: [
                    ...message.content,
                    { type: "text" as const, text: context.slice(1) },
                ],
            };
        }
        const execution = resolveExecution(message.toolCallId, details);
        return {
            ...message,
            details: {
                ...mergeExecutionDetails(details, execution),
                executionReceiptVisible: true,
            },
            content: [
                ...message.content,
                {
                    type: "text" as const,
                    text: `Execution provenance: ${JSON.stringify(execution)}${archiveContext(details)}${sandboxFailureContext(message.isError, details)}`,
                },
            ],
        };
    });
}

export function registerExecutionProvenance(pi: ExtensionAPI): void {
    pi.on("tool_result", (event) => {
        const think = thinkReceipt(event.toolName, event.content);
        if (think) {
            const details = {
                ...(event.details && typeof event.details === "object"
                    ? event.details
                    : {}),
                ...think,
            };
            return {
                details: mergeSandboxContextForFailure(
                    event.toolCallId,
                    details,
                    think.analysisExecution,
                    event.isError,
                ),
            };
        }
        const execution = resolveExecution(event.toolCallId, event.details);
        const settled =
            execution.outcome === "pending"
                ? {
                      ...execution,
                      outcome: event.isError
                          ? ("failed" as const)
                          : ("succeeded" as const),
                  }
                : execution;
        const details = mergeExecutionDetails(event.details, settled);
        return {
            details: mergeSandboxContextForFailure(
                event.toolCallId,
                details,
                settled,
                event.isError,
            ),
        };
    });
    pi.on("context", (event, ctx) => ({
        messages: addExecutionContext(
            event.messages,
            ctx.sessionManager.getBranch(),
        ),
    }));
    pi.on("agent_end", () => {
        registry().records.clear();
        clearSandboxExecutionContexts();
    });
    pi.on("session_start", () => {
        registry().records.clear();
        clearSandboxExecutionContexts();
    });
    pi.on("session_shutdown", () => {
        registry().records.clear();
        clearSandboxExecutionContexts();
    });
}
