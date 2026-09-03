import { isAbsolute } from "node:path";
import {
    SubagentRpcClient,
    type SubagentAsyncCompletion,
    type SubagentRpcClientOptions,
    type SubagentRpcEventBus,
} from "../_shared/subagents/rpc-client";
import { TOOL_GROUPS_CHILD_POLICY_BINDING } from "../_shared/tool-groups/types";
import {
    ARCHITECT_AGENT,
    READONLY_VERIFIER_TOOLS,
    VERIFICATION_DOMAINS,
    VERIFICATION_OUTCOMES,
    VERIFIER_AGENT_ALLOWLIST,
    type VerificationDomain,
    type VerificationOutcome,
    type VerificationPlanNode,
} from "./verification";

export type EventBusLike = SubagentRpcEventBus;

type PendingVerificationStepBase = Readonly<{
    outputName: string;
    agent: string;
    claimIds: readonly string[];
    evidenceIds: readonly string[];
}>;

export type PendingVerificationStep = Readonly<
    | (PendingVerificationStepBase & {
          role: "verifier";
          domain: VerificationDomain;
          outcome: VerificationOutcome;
      })
    | (PendingVerificationStepBase & { role: "architect" })
>;

export type PendingVerificationRun = Readonly<{
    runId: string;
    ownerSessionId: string;
    ownerSessionFile: string;
    brainstormRunId: string;
    claimIds: readonly string[];
    startedAt: string;
    expectedSteps: readonly PendingVerificationStep[];
}>;

export type OwnedTerminalCompletion =
    | {
          kind: "complete";
          structuredOutputs: Readonly<Record<string, unknown>>;
      }
    | { kind: "unrelated" }
    | {
          kind: "failure";
          failureKind: "failed" | "malformed" | "timeout";
          reason: string;
          completedStructuredOutputs?: Readonly<Record<string, unknown>>;
          failedAdvisoryOutputName?: string;
      };

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function strings(value: unknown, pattern?: RegExp): value is readonly string[] {
    return (
        Array.isArray(value) &&
        value.every(
            (item) =>
                typeof item === "string" &&
                item.trim().length > 0 &&
                (pattern === undefined || pattern.test(item)),
        )
    );
}

function unique(values: readonly string[]): boolean {
    return new Set(values).size === values.length;
}

export function isPendingVerificationRun(
    value: unknown,
): value is PendingVerificationRun {
    const pending = record(value);
    if (
        !pending ||
        typeof pending.runId !== "string" ||
        !pending.runId.trim() ||
        typeof pending.ownerSessionId !== "string" ||
        !pending.ownerSessionId.trim() ||
        typeof pending.ownerSessionFile !== "string" ||
        !isAbsolute(pending.ownerSessionFile) ||
        typeof pending.brainstormRunId !== "string" ||
        !pending.brainstormRunId.trim() ||
        typeof pending.startedAt !== "string" ||
        !pending.startedAt.trim() ||
        !strings(pending.claimIds, /^CL-\d+$/) ||
        pending.claimIds.length === 0 ||
        !unique(pending.claimIds) ||
        !Array.isArray(pending.expectedSteps) ||
        pending.expectedSteps.length === 0
    ) {
        return false;
    }
    const claimIds = pending.claimIds;
    const outputNames = new Set<string>();
    let architectCount = 0;
    for (const rawStep of pending.expectedSteps) {
        const step = record(rawStep);
        if (
            !step ||
            typeof step.outputName !== "string" ||
            !step.outputName.trim() ||
            outputNames.has(step.outputName) ||
            typeof step.agent !== "string" ||
            !strings(step.claimIds, /^CL-\d+$/) ||
            step.claimIds.length === 0 ||
            !unique(step.claimIds) ||
            !step.claimIds.every((id) => claimIds.includes(id)) ||
            !strings(step.evidenceIds, /^EV-\d+$/) ||
            !unique(step.evidenceIds)
        ) {
            return false;
        }
        outputNames.add(step.outputName);
        if (step.role === "verifier") {
            if (
                !VERIFIER_AGENT_ALLOWLIST.includes(step.agent) ||
                !VERIFICATION_DOMAINS.includes(
                    step.domain as VerificationDomain,
                ) ||
                !VERIFICATION_OUTCOMES.includes(
                    step.outcome as VerificationOutcome,
                )
            ) {
                return false;
            }
            continue;
        }
        if (step.role !== "architect" || step.agent !== ARCHITECT_AGENT) {
            return false;
        }
        architectCount += 1;
    }
    return architectCount <= 1;
}

export type VerificationDelegationNode = VerificationPlanNode;

export type VerificationCoordinatorInput = Readonly<{
    ownerRunId: string;
    sessionId: string;
    sessionFile: string;
    cwd: string;
    label: string;
    nodes: readonly VerificationDelegationNode[];
}>;

export type VerificationCoordinatorCompletion = Readonly<{
    runId: string;
    terminal: Exclude<OwnedTerminalCompletion, { kind: "unrelated" }>;
}>;

export type AttachedVerificationNode = Readonly<{
    role: "verifier" | "architect";
    outputName: string;
}>;

type CoordinatorRun = {
    nodes: readonly AttachedVerificationNode[];
    state: "running" | "completed" | "failed" | "stopped";
    terminal?: Exclude<OwnedTerminalCompletion, { kind: "unrelated" }>;
};

const TERMINAL_RUN_CACHE_LIMIT = 32;
const EARLY_COMPLETION_LIMIT = 16;
const VERIFICATION_CHILD_TIMEOUT_MS = 30 * 60 * 1_000;

export type VerificationCoordinatorDependencies = Readonly<{
    childTimeoutMs?: number;
    rpc?: SubagentRpcClient;
    rpcOptions?: Omit<SubagentRpcClientOptions, "sourceExtension">;
}>;

function workflowItem(
    node: VerificationDelegationNode,
    timeoutMs: number,
): Record<string, unknown> {
    return {
        key: node.outputName,
        agent: node.agent,
        task: node.task,
        context: "fresh",
        artifacts: true,
        timeoutMs,
        outputSchema: node.schema,
        extensionBindings: {
            [TOOL_GROUPS_CHILD_POLICY_BINDING]: {
                allowedTools: [...READONLY_VERIFIER_TOOLS, "structured_output"],
            },
        },
        acceptance: false,
    };
}

export function buildVerificationWorkflowScript(
    nodes: readonly VerificationDelegationNode[],
    timeoutMs = VERIFICATION_CHILD_TIMEOUT_MS,
): string {
    const verifiers = nodes.filter((node) => node.role === "verifier");
    const architect = nodes.find((node) => node.role === "architect");
    const lines = [
        `const verifierItems = ${JSON.stringify(verifiers.map((node) => workflowItem(node, timeoutMs)))};`,
        "const verifierResults = await runs.all(verifierItems);",
        "for (let index = 0; index < verifierResults.length; index += 1) {",
        "  if (!verifierResults[index].ok) return { verifierResults };",
        "}",
    ];
    if (architect) {
        lines.push(
            `let architectTask = ${JSON.stringify(architect.task)};`,
            "for (let index = 0; index < verifierResults.length; index += 1) {",
            '  const marker = "{outputs." + verifierItems[index].key + "}";',
            "  architectTask = architectTask.replaceAll(marker, JSON.stringify(verifierResults[index].structuredOutput));",
            "}",
            `const architectResult = await runs.run(${JSON.stringify(architect.outputName)}, ${JSON.stringify(
                { ...workflowItem(architect, timeoutMs), task: undefined },
            )
                .replace('"task":undefined,', "")
                .replace(',"task":undefined', "")});`,
            "return { verifierResults, architectResult };",
        );
        const architectItem = JSON.stringify({
            ...workflowItem(architect, timeoutMs),
            task: "__ARCHITECT_TASK__",
        }).replace('"__ARCHITECT_TASK__"', "architectTask");
        lines[lines.length - 2] =
            `const architectResult = await runs.run(${JSON.stringify(architect.outputName)}, ${architectItem});`;
    } else {
        lines.push("return { verifierResults }; ");
    }
    return lines.join("\n");
}

function asyncRunId(value: {
    details?: Record<string, unknown>;
}): string | undefined {
    const candidate = value.details?.asyncId;
    return typeof candidate === "string" && candidate.trim()
        ? candidate
        : undefined;
}

function successfulResult(result: Record<string, unknown>): boolean {
    return (
        result.success !== false &&
        result.status !== "failed" &&
        result.status !== "stopped" &&
        result.status !== "timed_out" &&
        Object.hasOwn(result, "structuredOutput")
    );
}

function failureReason(
    completion: SubagentAsyncCompletion,
    result?: Record<string, unknown>,
): string {
    for (const candidate of [
        result?.error,
        result?.output,
        completion.summary,
        completion.state,
    ]) {
        if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
    return `Native verification run ${completion.id} failed.`;
}

function malformedCompletion(
    reason: string,
): Exclude<OwnedTerminalCompletion, { kind: "unrelated" }> {
    return { kind: "failure", failureKind: "malformed", reason };
}

function terminalFromCompletion(
    run: CoordinatorRun,
    completion: SubagentAsyncCompletion,
): Exclude<OwnedTerminalCompletion, { kind: "unrelated" }> {
    const results = completion.results ?? [];
    const expectedKeys = run.nodes.map((node) => node.outputName);
    const expectedKeySet = new Set(expectedKeys);
    if (expectedKeySet.size !== expectedKeys.length) {
        return malformedCompletion(
            "Verification contains duplicate expected workflow keys.",
        );
    }

    const byKey = new Map<string, Record<string, unknown>>();
    for (const result of results) {
        const key = result.workflowKey;
        if (typeof key !== "string" || !expectedKeySet.has(key)) {
            return malformedCompletion(
                "Verification returned an unexpected workflow key.",
            );
        }
        if (byKey.has(key)) {
            return malformedCompletion(
                `Verification returned duplicate workflow key "${key}".`,
            );
        }
        byKey.set(key, result);
    }
    const missingKeys = expectedKeys.filter((key) => !byKey.has(key));
    if (missingKeys.length > 0) {
        return malformedCompletion(
            `Verification omitted workflow key(s): ${missingKeys.join(", ")}.`,
        );
    }

    const outputs: Record<string, unknown> = {};
    const verifierNodes = run.nodes.filter((node) => node.role === "verifier");
    const architectNode = run.nodes.find((node) => node.role === "architect");
    for (const node of verifierNodes) {
        const result = byKey.get(node.outputName);
        if (!result || !successfulResult(result)) {
            const reason = failureReason(completion, result);
            return {
                kind: "failure",
                failureKind:
                    completion.timedOut === true || /timed?\s*out/i.test(reason)
                        ? "timeout"
                        : "failed",
                reason,
                ...(Object.keys(outputs).length > 0
                    ? { completedStructuredOutputs: outputs }
                    : {}),
            };
        }
        outputs[node.outputName] = result.structuredOutput;
    }
    if (architectNode) {
        const result = byKey.get(architectNode.outputName);
        if (!result || !successfulResult(result)) {
            const reason = failureReason(completion, result);
            return {
                kind: "failure",
                failureKind:
                    completion.timedOut === true || /timed?\s*out/i.test(reason)
                        ? "timeout"
                        : "failed",
                reason,
                completedStructuredOutputs: outputs,
                failedAdvisoryOutputName: architectNode.outputName,
            };
        }
        outputs[architectNode.outputName] = result.structuredOutput;
    }
    return { kind: "complete", structuredOutputs: outputs };
}

export function createVerificationCoordinator(
    events: EventBusLike,
    dependencies: VerificationCoordinatorDependencies = {},
) {
    const childTimeoutMs =
        dependencies.childTimeoutMs ?? VERIFICATION_CHILD_TIMEOUT_MS;
    const ownsRpc = dependencies.rpc === undefined;
    const rpc =
        dependencies.rpc ??
        new SubagentRpcClient(events, {
            sourceExtension: "brainstorm-forcer",
            ...dependencies.rpcOptions,
        });
    const runs = new Map<string, CoordinatorRun>();
    const terminalRunIds: string[] = [];
    const earlyCompletions = new Map<string, SubagentAsyncCompletion>();
    const completionHandlers = new Set<
        (completion: VerificationCoordinatorCompletion) => void
    >();
    let disposed = false;

    function retainTerminalRun(runId: string): void {
        terminalRunIds.push(runId);
        while (terminalRunIds.length > TERMINAL_RUN_CACHE_LIMIT) {
            const expiredRunId = terminalRunIds.shift();
            if (expiredRunId) runs.delete(expiredRunId);
        }
    }

    function processCompletion(completion: SubagentAsyncCompletion): boolean {
        const run = runs.get(completion.id);
        if (!run || run.state !== "running") return false;
        const terminal = terminalFromCompletion(run, completion);
        run.terminal = terminal;
        run.state = terminal.kind === "complete" ? "completed" : "failed";
        earlyCompletions.delete(completion.id);
        retainTerminalRun(completion.id);
        for (const handler of completionHandlers) {
            handler({ runId: completion.id, terminal });
        }
        return true;
    }

    const unsubscribeCompletion = rpc.onAsyncComplete((completion) => {
        if (processCompletion(completion)) return;
        if (earlyCompletions.size >= EARLY_COMPLETION_LIMIT) {
            const oldest = earlyCompletions.keys().next().value;
            if (typeof oldest === "string") earlyCompletions.delete(oldest);
        }
        earlyCompletions.set(completion.id, completion);
    });

    return {
        async start(
            input: VerificationCoordinatorInput,
        ): Promise<{ runId: string }> {
            if (disposed)
                throw new Error("Verification coordinator is disposed.");
            if (!input.nodes.length)
                throw new Error("Verification requires at least one node.");
            if (!isAbsolute(input.sessionFile))
                throw new Error(
                    "Verification requires an absolute persisted session file.",
                );
            const response = await rpc.spawn({
                workflowScript: buildVerificationWorkflowScript(
                    input.nodes,
                    childTimeoutMs,
                ),
                cwd: input.cwd,
                context: "fresh",
                artifacts: true,
                mission: false,
            });
            const runId = asyncRunId(response);
            if (!runId) {
                throw new Error(
                    "Native Brainstorm verification launch did not return an async run id.",
                );
            }
            runs.set(runId, { nodes: input.nodes, state: "running" });
            const early = earlyCompletions.get(runId);
            if (early) processCompletion(early);
            return { runId };
        },
        attach(
            runId: string,
            nodes: readonly AttachedVerificationNode[],
        ): void {
            if (disposed)
                throw new Error("Verification coordinator is disposed.");
            if (!runId.trim() || nodes.length === 0)
                throw new Error(
                    "Restored verification requires a run id and expected nodes.",
                );
            if (runs.has(runId)) return;
            runs.set(runId, { nodes, state: "running" });
            const early = earlyCompletions.get(runId);
            if (early) processCompletion(early);
        },
        async stop(runId: string): Promise<boolean> {
            const run = runs.get(runId);
            if (!run || run.state !== "running") return false;
            const result = await rpc.stop({ id: runId });
            if (result.isError === true) return false;
            if (runs.get(runId) !== run || run.state !== "running")
                return false;
            run.state = "stopped";
            earlyCompletions.delete(runId);
            retainTerminalRun(runId);
            return true;
        },
        status(runId: string) {
            const run = runs.get(runId);
            return run
                ? {
                      state: run.state,
                      activeRequests: run.state === "running" ? 1 : 0,
                      terminal: run.terminal,
                  }
                : undefined;
        },
        onComplete(
            handler: (completion: VerificationCoordinatorCompletion) => void,
        ): () => void {
            completionHandlers.add(handler);
            return () => completionHandlers.delete(handler);
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            unsubscribeCompletion();
            runs.clear();
            terminalRunIds.length = 0;
            earlyCompletions.clear();
            completionHandlers.clear();
            if (ownsRpc) rpc.dispose();
        },
    };
}
