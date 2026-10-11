import {
    SubagentIntegration,
    type RunCompletion,
    type IntegrationOptions,
    type EventBus,
    type RunRef,
} from "../_shared/subagents/index.ts";
import {
    buildResearchDelegation,
    parseResearchResult,
    type BrainstormResearchInput,
    type BrainstormResearchResult,
} from "./research";

const RESEARCH_CHILD_TIMEOUT_MS = 15 * 60 * 1_000;

export type ResearchEventBus = EventBus;

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
    integration?: SubagentIntegration;
    integrationOptions?: Omit<IntegrationOptions, "sourceExtension">;
}>;

type ActiveResearch = { agent: string; ref: RunRef; unsubscribe?: () => void };

function completionFailureReason(completion: RunCompletion): string {
    return (
        completion.steps[0]?.error ??
        completion.error ??
        `Research run ${completion.runId} failed.`
    );
}

export function createResearchRunner(
    events: ResearchEventBus,
    dependencies: ResearchRunnerDependencies = {},
) {
    const childTimeoutMs =
        dependencies.childTimeoutMs ?? RESEARCH_CHILD_TIMEOUT_MS;
    const ownsIntegration = dependencies.integration === undefined;
    const integration =
        dependencies.integration ??
        new SubagentIntegration(events, {
            sourceExtension: "brainstorm-forcer",
            ...dependencies.integrationOptions,
        });
    const active = new Map<string, ActiveResearch>();
    const completed = new Set<string>();
    const completionHandlers = new Set<
        (completion: ResearchRunnerCompletion) => void
    >();
    let disposed = false;

    function publish(completion: ResearchRunnerCompletion): void {
        if (completed.has(completion.runId)) return;
        completed.add(completion.runId);
        active.get(completion.runId)?.unsubscribe?.();
        active.delete(completion.runId);
        for (const handler of completionHandlers) handler(completion);
    }

    function processCompletion(completion: RunCompletion): boolean {
        const agent = active.get(completion.runId)?.agent;
        if (!agent || completed.has(completion.runId)) return false;
        const result = completion.steps.find(
            (candidate) => candidate.agent === agent,
        );
        if (
            completion.status !== "completed" ||
            !result ||
            (typeof result.status === "string" && result.status !== "completed")
        ) {
            publish({
                runId: completion.runId,
                terminal: {
                    kind: "failure",
                    reason: completionFailureReason(completion),
                },
            });
            return true;
        }
        try {
            publish({
                runId: completion.runId,
                terminal: {
                    kind: "complete",
                    result: parseResearchResult(
                        result.value?.kind === "structured"
                            ? result.value.value
                            : undefined,
                    ),
                },
            });
        } catch (error) {
            publish({
                runId: completion.runId,
                terminal: {
                    kind: "failure",
                    reason:
                        error instanceof Error ? error.message : String(error),
                },
            });
        }
        return true;
    }

    return {
        async start(
            input: ResearchRunnerInput,
        ): Promise<ResearchRunnerReceipt> {
            if (disposed) throw new Error("Research runner is disposed.");
            const delegation = buildResearchDelegation(input.input);
            const ref = await integration.start(
                {
                    agent: delegation.agent,
                    task: delegation.task,
                    context: delegation.context,
                    cwd: input.cwd,
                    artifacts: false,
                    timeoutMs: childTimeoutMs,
                    result: { kind: "structured", schema: delegation.schema },
                },
                { signal: input.signal },
            );
            const { runId } = ref;
            const run: ActiveResearch = {
                agent: delegation.agent,
                ref,
            };
            active.set(runId, run);
            run.unsubscribe = integration.subscribe((event) => {
                if (event.kind === "terminal")
                    processCompletion(event.completion);
                else
                    processCompletion({
                        runId: ref.runId,
                        status: "failed",
                        steps: [],
                        error: event.error.message,
                    });
            }, ref);
            if (!active.has(runId)) run.unsubscribe?.();
            return { runId, agent: delegation.agent };
        },
        async stop(runId: string): Promise<void> {
            const run = active.get(runId);
            await integration.control(
                run?.ref ?? (await integration.reference(runId)),
                { kind: "stop" },
            );
            run?.unsubscribe?.();
            active.delete(runId);
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
            for (const run of active.values()) run.unsubscribe?.();
            active.clear();
            completionHandlers.clear();
            if (ownsIntegration) integration.dispose();
        },
    };
}
