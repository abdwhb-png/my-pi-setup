import {
    SubagentRpcClient,
    type SubagentAsyncCompletion,
    type SubagentRpcClientOptions,
    type SubagentRpcEventBus,
} from "../_shared/subagents/rpc-client";
import {
    buildResearchDelegation,
    parseResearchResult,
    type BrainstormResearchInput,
    type BrainstormResearchResult,
} from "./research";

const RESEARCH_CHILD_TIMEOUT_MS = 15 * 60 * 1_000;
const EARLY_COMPLETION_LIMIT = 16;

export type ResearchEventBus = SubagentRpcEventBus;

export type ResearchRunnerInput = Readonly<{
    ownerRunId: string;
    cwd: string;
    input: BrainstormResearchInput;
    signal?: AbortSignal;
}>;

export type ResearchRunnerReceipt = Readonly<{
    runId: string;
    agent: string;
}>;

export type ResearchRunnerCompletion = Readonly<{
    runId: string;
    terminal:
        | Readonly<{ kind: "complete"; result: BrainstormResearchResult }>
        | Readonly<{ kind: "failure"; reason: string }>;
}>;

export type ResearchRunnerDependencies = Readonly<{
    childTimeoutMs?: number;
    rpc?: SubagentRpcClient;
    rpcOptions?: Omit<SubagentRpcClientOptions, "sourceExtension">;
}>;

function asyncRunId(value: {
    details?: Record<string, unknown>;
}): string | undefined {
    const candidate = value.details?.asyncId;
    return typeof candidate === "string" && candidate.trim()
        ? candidate
        : undefined;
}

function completionFailureReason(completion: SubagentAsyncCompletion): string {
    const result = completion.results?.[0];
    for (const candidate of [
        result?.error,
        result?.output,
        completion.summary,
        completion.state,
    ]) {
        if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
    return `Native research run ${completion.id} failed.`;
}

export function createResearchRunner(
    events: ResearchEventBus,
    dependencies: ResearchRunnerDependencies = {},
) {
    const childTimeoutMs =
        dependencies.childTimeoutMs ?? RESEARCH_CHILD_TIMEOUT_MS;
    const ownsRpc = dependencies.rpc === undefined;
    const rpc =
        dependencies.rpc ??
        new SubagentRpcClient(events, {
            sourceExtension: "brainstorm-forcer",
            ...dependencies.rpcOptions,
        });
    const active = new Map<string, string>();
    const completed = new Set<string>();
    const earlyCompletions = new Map<string, SubagentAsyncCompletion>();
    const completionHandlers = new Set<
        (completion: ResearchRunnerCompletion) => void
    >();
    let disposed = false;

    function publish(completion: ResearchRunnerCompletion): void {
        if (completed.has(completion.runId)) return;
        completed.add(completion.runId);
        active.delete(completion.runId);
        earlyCompletions.delete(completion.runId);
        for (const handler of completionHandlers) handler(completion);
    }

    function processCompletion(completion: SubagentAsyncCompletion): boolean {
        const agent = active.get(completion.id);
        if (!agent || completed.has(completion.id)) return false;
        const result = completion.results?.find(
            (candidate) => candidate.agent === agent,
        );
        if (
            completion.success !== true ||
            !result ||
            result.success === false ||
            (typeof result.status === "string" && result.status !== "completed")
        ) {
            publish({
                runId: completion.id,
                terminal: {
                    kind: "failure",
                    reason: completionFailureReason(completion),
                },
            });
            return true;
        }
        try {
            publish({
                runId: completion.id,
                terminal: {
                    kind: "complete",
                    result: parseResearchResult(result.structuredOutput),
                },
            });
        } catch (error) {
            publish({
                runId: completion.id,
                terminal: {
                    kind: "failure",
                    reason:
                        error instanceof Error ? error.message : String(error),
                },
            });
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
            input: ResearchRunnerInput,
        ): Promise<ResearchRunnerReceipt> {
            if (disposed) throw new Error("Research runner is disposed.");
            const delegation = buildResearchDelegation(input.input);
            const response = await rpc.spawn(
                {
                    agent: delegation.agent,
                    task: delegation.task,
                    context: delegation.context,
                    cwd: input.cwd,
                    artifacts: false,
                    timeoutMs: childTimeoutMs,
                    outputSchema: delegation.schema,
                },
                { signal: input.signal },
            );
            const runId = asyncRunId(response);
            if (!runId) {
                throw new Error(
                    "Native Brainstorm research launch did not return an async run id.",
                );
            }
            active.set(runId, delegation.agent);
            const early = earlyCompletions.get(runId);
            if (early) processCompletion(early);
            return { runId, agent: delegation.agent };
        },
        async stop(runId: string): Promise<void> {
            await rpc.stop({ id: runId });
            active.delete(runId);
            earlyCompletions.delete(runId);
        },
        onComplete(
            handler: (completion: ResearchRunnerCompletion) => void,
        ): () => void {
            completionHandlers.add(handler);
            return () => completionHandlers.delete(handler);
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            unsubscribeCompletion();
            active.clear();
            earlyCompletions.clear();
            completionHandlers.clear();
            if (ownsRpc) rpc.dispose();
        },
    };
}
