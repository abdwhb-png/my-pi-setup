import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { SubagentDelegationRequest } from "pi-subagents/delegation";
import {
    registerExternalRun,
    unregisterExternalRun,
} from "pi-subagents/external-runs";
import {
    DelegationClient,
    DelegationDeadlineError,
    type DelegationClientOptions,
} from "../_shared/subagents/delegation-client";
import {
    ARCHITECT_AGENT,
    VERIFICATION_DOMAINS,
    VERIFICATION_OUTCOMES,
    VERIFIER_AGENT_ALLOWLIST,
    type VerificationDomain,
    type VerificationOutcome,
    type VerificationPlanNode,
} from "./verification";

export interface EventBusLike {
    on(event: string, handler: (data: unknown) => void): (() => void) | void;
    emit(event: string, data: unknown): void;
}

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

/** Durable metadata only. Active foreground attempts live in one extension context. */
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
    /** Fleet indexes current sessions by their persisted session-file path. */
    sessionFile: string;
    cwd: string;
    label: string;
    nodes: readonly VerificationDelegationNode[];
}>;

export type VerificationCoordinatorCompletion = Readonly<{
    runId: string;
    terminal: Exclude<OwnedTerminalCompletion, { kind: "unrelated" }>;
}>;

type CoordinatorRun = {
    input: VerificationCoordinatorInput;
    externalRunSessionId: string;
    state: "running" | "completed" | "failed" | "stopped";
    activeRequestIds: Set<string>;
    terminal?: Exclude<OwnedTerminalCompletion, { kind: "unrelated" }>;
};

const TERMINAL_RUN_CACHE_LIMIT = 32;

/** Matches pi-subagents' documented 30-minute foreground default, explicitly. */
const VERIFICATION_CHILD_TIMEOUT_MS = 30 * 60 * 1_000;
/** Lets the child publish its terminal event before local recovery owns cleanup. */
const VERIFICATION_DEADLINE_GRACE_MS = 5_000;

export type VerificationCoordinatorDependencies = Readonly<{
    registerExternalRun?: typeof registerExternalRun;
    unregisterExternalRun?: typeof unregisterExternalRun;
    /** Test seam; production uses the bounded child timeout above. */
    childTimeoutMs?: number;
    /** Test seam; must retain a positive local grace beyond the child timeout. */
    deadlineGraceMs?: number;
    /** Test seam for a deterministic DelegationClient deadline signal. */
    createDeadlineSignal?: DelegationClientOptions["createDeadlineSignal"];
}>;

function structuredResult(response: {
    result?:
        | { kind: "text"; text: string }
        | { kind: "structured"; value: unknown };
}): unknown {
    return response.result?.kind === "structured"
        ? response.result.value
        : undefined;
}

function renderDependentTask(
    task: string,
    outputs: Readonly<Record<string, unknown>>,
): string {
    let rendered = task;
    for (const [name, value] of Object.entries(outputs)) {
        rendered = rendered.replaceAll(
            `{outputs.${name}}`,
            JSON.stringify(value),
        );
    }
    return rendered;
}

/** Runs Brainstorm leaves through the public 0.50 structured delegation API. */
export function createVerificationCoordinator(
    events: EventBusLike,
    dependencies: VerificationCoordinatorDependencies = {},
) {
    const registerFleetRun =
        dependencies.registerExternalRun ?? registerExternalRun;
    const unregisterFleetRun =
        dependencies.unregisterExternalRun ?? unregisterExternalRun;
    const childTimeoutMs =
        dependencies.childTimeoutMs ?? VERIFICATION_CHILD_TIMEOUT_MS;
    const deadlineGraceMs =
        dependencies.deadlineGraceMs ?? VERIFICATION_DEADLINE_GRACE_MS;
    const client = new DelegationClient(
        {
            on(event, handler) {
                return events.on(event, handler) ?? (() => undefined);
            },
            emit(event, data) {
                events.emit(event, data);
            },
        },
        {
            createDeadlineSignal: dependencies.createDeadlineSignal,
        },
    );
    const runs = new Map<string, CoordinatorRun>();
    const completionHandlers = new Set<
        (completion: VerificationCoordinatorCompletion) => void
    >();
    const terminalRunIds: string[] = [];
    let disposed = false;

    function retainTerminalRun(runId: string): void {
        terminalRunIds.push(runId);
        while (terminalRunIds.length > TERMINAL_RUN_CACHE_LIMIT) {
            const expiredRunId = terminalRunIds.shift();
            if (expiredRunId) runs.delete(expiredRunId);
        }
    }

    function publishCompletion(
        runId: string,
        terminal: Exclude<OwnedTerminalCompletion, { kind: "unrelated" }>,
    ): void {
        const run = runs.get(runId);
        if (!run || run.terminal) return;
        run.terminal = terminal;
        run.state = terminal.kind === "complete" ? "completed" : "failed";
        unregisterFleetRun(run.externalRunSessionId, runId);
        retainTerminalRun(runId);
        for (const handler of completionHandlers) handler({ runId, terminal });
    }

    async function runNode(
        runId: string,
        node: VerificationDelegationNode,
        cwd: string,
        outputs: Readonly<Record<string, unknown>>,
    ): Promise<unknown> {
        const run = runs.get(runId);
        if (!run || run.state !== "running") {
            throw new Error(`Verification run ${runId} is not active.`);
        }
        const requestId = `${runId}:${node.outputName}:${randomUUID()}`;
        const request: SubagentDelegationRequest = {
            requestId,
            ownerRunId: runId,
            nodeId: node.outputName,
            agent: node.agent,
            task: renderDependentTask(node.task, outputs),
            context: "fresh",
            cwd,
            artifacts: true,
            timeoutMs: childTimeoutMs,
            result: { kind: "structured", schema: node.schema },
        };
        run.activeRequestIds.add(requestId);
        try {
            const response = await client.run(request, {
                deadlineMs: childTimeoutMs + deadlineGraceMs,
            });
            const value = structuredResult(response);
            if (response.status !== "completed" || value === undefined) {
                const error = new Error(
                    response.error ??
                        `Delegation ${requestId} ended with ${response.status}.`,
                );
                Object.assign(error, { delegationStatus: response.status });
                throw error;
            }
            return value;
        } finally {
            run.activeRequestIds.delete(requestId);
        }
    }

    async function execute(runId: string): Promise<void> {
        const run = runs.get(runId);
        if (!run) return;
        const verifierNodes = run.input.nodes.filter(
            (node) => node.role === "verifier",
        );
        const architectNodes = run.input.nodes.filter(
            (node) => node.role === "architect",
        );
        const outputs: Record<string, unknown> = {};
        try {
            const settled = await Promise.allSettled(
                verifierNodes.map(async (node) => ({
                    node,
                    value: await runNode(runId, node, run.input.cwd, outputs),
                })),
            );
            for (const item of settled) {
                if (item.status === "fulfilled") {
                    outputs[item.value.node.outputName] = item.value.value;
                }
            }
            const rejected = settled.find(
                (item): item is PromiseRejectedResult =>
                    item.status === "rejected",
            );
            if (rejected) throw rejected.reason;

            for (const node of architectNodes) {
                outputs[node.outputName] = await runNode(
                    runId,
                    node,
                    run.input.cwd,
                    outputs,
                );
            }
            if (run.state === "running") {
                publishCompletion(runId, {
                    kind: "complete",
                    structuredOutputs: outputs,
                });
            }
        } catch (error) {
            if (run.state !== "running") return;
            const reason =
                error instanceof Error ? error.message : String(error);
            const delegationStatus =
                error instanceof Error && "delegationStatus" in error
                    ? String(error.delegationStatus)
                    : undefined;
            const failedArchitect = architectNodes.find(
                (node) => !Object.hasOwn(outputs, node.outputName),
            );
            publishCompletion(runId, {
                kind: "failure",
                failureKind:
                    error instanceof DelegationDeadlineError ||
                    delegationStatus === "timed_out"
                        ? "timeout"
                        : "failed",
                reason,
                ...(Object.keys(outputs).length > 0
                    ? { completedStructuredOutputs: outputs }
                    : {}),
                ...(failedArchitect &&
                Object.keys(outputs).length === verifierNodes.length
                    ? { failedAdvisoryOutputName: failedArchitect.outputName }
                    : {}),
            });
        }
    }

    function stop(runId: string): boolean {
        const run = runs.get(runId);
        if (!run || run.state !== "running") return false;
        run.state = "stopped";
        const activeRequestIds = [...run.activeRequestIds];
        run.activeRequestIds.clear();
        for (const requestId of activeRequestIds)
            client.cancelAndDetach(requestId);
        unregisterFleetRun(run.externalRunSessionId, runId);
        retainTerminalRun(runId);
        return true;
    }

    return {
        start(input: VerificationCoordinatorInput) {
            if (disposed)
                throw new Error("Verification coordinator is disposed.");
            if (!input.nodes.length)
                throw new Error("Verification requires at least one node.");
            if (!isAbsolute(input.sessionFile))
                throw new Error(
                    "Verification requires an absolute persisted session file.",
                );
            const runId = `verification-${randomUUID()}`;
            const run: CoordinatorRun = {
                input,
                externalRunSessionId: input.sessionFile,
                state: "running",
                activeRequestIds: new Set(),
            };
            registerFleetRun({
                id: runId,
                sessionId: run.externalRunSessionId,
                source: "brainstorm-forcer",
                label: input.label,
                state: "running",
                startedAt: Date.now(),
                currentAction: `Running ${input.nodes.length} verification node(s)`,
            });
            runs.set(runId, run);
            void execute(runId);
            return { runId };
        },
        stop,
        status(runId: string) {
            const run = runs.get(runId);
            return run
                ? {
                      state: run.state,
                      activeRequests: run.activeRequestIds.size,
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
            for (const [runId, run] of runs) {
                if (run.state === "running") stop(runId);
                unregisterFleetRun(run.externalRunSessionId, runId);
            }
            runs.clear();
            terminalRunIds.length = 0;
            completionHandlers.clear();
            client.dispose();
        },
    };
}
