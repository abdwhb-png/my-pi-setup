import { isAbsolute } from "node:path";
import {
    SubagentIntegration,
    type RunCompletion,
    type IntegrationOptions,
    type EventBus,
    type RunRef,
    type ChildResult,
    type DelegationWorkflow,
} from "../_shared/subagents/index.ts";
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

export type EventBusLike = EventBus;

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
    ref?: RunRef;
    unsubscribe?: () => void;
    state: "running" | "completed" | "failed" | "stopped";
    terminal?: Exclude<OwnedTerminalCompletion, { kind: "unrelated" }>;
};

const TERMINAL_RUN_CACHE_LIMIT = 32;
const VERIFICATION_CHILD_TIMEOUT_MS = 30 * 60 * 1_000;

export type VerificationCoordinatorDependencies = Readonly<{
    childTimeoutMs?: number;
    integration?: SubagentIntegration;
    integrationOptions?: Omit<IntegrationOptions, "sourceExtension">;
}>;

export function buildVerificationWorkflow(
    nodes: readonly VerificationDelegationNode[],
    timeoutMs = VERIFICATION_CHILD_TIMEOUT_MS,
): DelegationWorkflow {
    const item = (node: VerificationDelegationNode) => ({
        key: node.outputName,
        agent: node.agent,
        task: node.task,
        context: "fresh" as const,
        artifacts: true,
        timeoutMs,
        result: { kind: "structured" as const, schema: node.schema },
        extensionBindings: {
            [TOOL_GROUPS_CHILD_POLICY_BINDING]: {
                allowedTools: [...READONLY_VERIFIER_TOOLS, "structured_output"],
            },
        },
        acceptance: false,
    });
    const verifiers = nodes
        .filter((node) => node.role === "verifier")
        .map(item);
    const architect = nodes
        .filter((node) => node.role === "architect")
        .map(item);
    return { stages: [verifiers, ...(architect.length ? [architect] : [])] };
}

function successfulResult(result: ChildResult): boolean {
    return result.status === "completed" && result.value?.kind === "structured";
}

function failureReason(
    completion: RunCompletion,
    result?: ChildResult,
): string {
    return (
        result?.error ??
        completion.error ??
        `Verification run ${completion.runId} failed.`
    );
}

function malformedCompletion(
    reason: string,
): Exclude<OwnedTerminalCompletion, { kind: "unrelated" }> {
    return { kind: "failure", failureKind: "malformed", reason };
}

function terminalFromCompletion(
    run: CoordinatorRun,
    completion: RunCompletion,
): Exclude<OwnedTerminalCompletion, { kind: "unrelated" }> {
    const results = completion.steps;
    const expectedKeys = run.nodes.map((node) => node.outputName);
    const expectedKeySet = new Set(expectedKeys);
    if (expectedKeySet.size !== expectedKeys.length) {
        return malformedCompletion(
            "Verification contains duplicate expected workflow keys.",
        );
    }

    const byKey = new Map<string, ChildResult>();
    for (const result of results) {
        const key = result.key;
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
    const failedVerifier = run.nodes.some(
        (node) =>
            node.role === "verifier" &&
            byKey.has(node.outputName) &&
            !successfulResult(byKey.get(node.outputName)!),
    );
    const missingKeys = run.nodes
        .filter(
            (node) =>
                !byKey.has(node.outputName) &&
                !(node.role === "architect" && failedVerifier),
        )
        .map((node) => node.outputName);
    if (missingKeys.length > 0) {
        return malformedCompletion(
            completion.error ??
                `Verification omitted workflow key(s): ${missingKeys.join(", ")}.`,
        );
    }

    const outputs: Record<string, unknown> = {};
    const verifierNodes = run.nodes.filter((node) => node.role === "verifier");
    const architectNode = run.nodes.find((node) => node.role === "architect");
    for (const node of verifierNodes) {
        const result = byKey.get(node.outputName);
        if (
            result &&
            successfulResult(result) &&
            result.value?.kind === "structured"
        )
            outputs[node.outputName] = result.value.value;
    }
    for (const node of verifierNodes) {
        const result = byKey.get(node.outputName);
        if (!result || !successfulResult(result)) {
            const reason = failureReason(completion, result);
            return {
                kind: "failure",
                failureKind:
                    completion.status === "timed_out" ||
                    result?.status === "timed_out"
                        ? "timeout"
                        : "failed",
                reason,
                ...(Object.keys(outputs).length > 0
                    ? { completedStructuredOutputs: outputs }
                    : {}),
            };
        }
    }
    if (architectNode) {
        const result = byKey.get(architectNode.outputName);
        if (!result || !successfulResult(result)) {
            const reason = failureReason(completion, result);
            return {
                kind: "failure",
                failureKind:
                    completion.status === "timed_out" ||
                    result?.status === "timed_out"
                        ? "timeout"
                        : "failed",
                reason,
                completedStructuredOutputs: outputs,
                failedAdvisoryOutputName: architectNode.outputName,
            };
        }
        outputs[architectNode.outputName] =
            result.value?.kind === "structured"
                ? result.value.value
                : undefined;
    }
    return { kind: "complete", structuredOutputs: outputs };
}

export function createVerificationCoordinator(
    events: EventBusLike,
    dependencies: VerificationCoordinatorDependencies = {},
) {
    const childTimeoutMs =
        dependencies.childTimeoutMs ?? VERIFICATION_CHILD_TIMEOUT_MS;
    const ownsIntegration = dependencies.integration === undefined;
    const integration =
        dependencies.integration ??
        new SubagentIntegration(events, {
            sourceExtension: "brainstorm-forcer",
            ...dependencies.integrationOptions,
        });
    const runs = new Map<string, CoordinatorRun>();
    const terminalRunIds: string[] = [];
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

    function processCompletion(completion: RunCompletion): boolean {
        const run = runs.get(completion.runId);
        if (!run || run.state !== "running") return false;
        const terminal = terminalFromCompletion(run, completion);
        run.terminal = terminal;
        run.state = terminal.kind === "complete" ? "completed" : "failed";
        run.unsubscribe?.();
        retainTerminalRun(completion.runId);
        for (const handler of completionHandlers) {
            handler({ runId: completion.runId, terminal });
        }
        return true;
    }

    async function monitor(runId: string, run: CoordinatorRun): Promise<void> {
        run.ref ??= await integration.reference(runId);
        if (disposed || runs.get(runId) !== run) return;
        run.unsubscribe = integration.subscribe((event) => {
            if (event.kind === "terminal") processCompletion(event.completion);
            else
                processCompletion({
                    runId,
                    status: "failed",
                    steps: [],
                    error: event.error.message,
                });
        }, run.ref);
        if (run.state !== "running") run.unsubscribe();
    }

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
            const ref = await integration.start({
                ...buildVerificationWorkflow(input.nodes, childTimeoutMs),
                cwd: input.cwd,
                context: "fresh",
                artifacts: true,
            });
            const { runId } = ref;
            const run: CoordinatorRun = {
                nodes: input.nodes,
                state: "running",
                ref,
            };
            runs.set(runId, run);
            await monitor(runId, run);
            return { runId };
        },
        async attach(
            runId: string,
            nodes: readonly AttachedVerificationNode[],
        ): Promise<void> {
            if (disposed)
                throw new Error("Verification coordinator is disposed.");
            if (!runId.trim() || nodes.length === 0)
                throw new Error(
                    "Restored verification requires a run id and expected nodes.",
                );
            if (runs.has(runId)) return;
            const run: CoordinatorRun = { nodes, state: "running" };
            runs.set(runId, run);
            try {
                await monitor(runId, run);
                if (run.state === "running")
                    await integration.inspect(run.ref!);
            } catch (error) {
                run.unsubscribe?.();
                if (runs.get(runId) === run) runs.delete(runId);
                throw error;
            }
        },
        async stop(runId: string): Promise<boolean> {
            const run = runs.get(runId);
            if (!run || run.state !== "running") return false;
            if (!run.ref) return false;
            try {
                await integration.control(run.ref, { kind: "stop" });
            } catch {
                return false;
            }
            if (runs.get(runId) !== run || run.state !== "running")
                return false;
            run.state = "stopped";
            run.unsubscribe?.();
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
            for (const run of runs.values()) run.unsubscribe?.();
            runs.clear();
            terminalRunIds.length = 0;
            completionHandlers.clear();
            if (ownsIntegration) integration.dispose();
        },
    };
}
