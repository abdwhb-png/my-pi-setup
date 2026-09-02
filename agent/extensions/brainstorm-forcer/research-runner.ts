import { randomUUID } from "node:crypto";
import type { SubagentDelegationRequest } from "pi-subagents/delegation";
import {
    DelegationClient,
    type DelegationClientOptions,
} from "../_shared/subagents/delegation-client";
import {
    buildResearchDelegation,
    parseResearchResult,
    type BrainstormResearchInput,
    type BrainstormResearchResult,
} from "./research";

const RESEARCH_CHILD_TIMEOUT_MS = 15 * 60 * 1_000;
const RESEARCH_DEADLINE_GRACE_MS = 5_000;

export interface ResearchEventBus {
    on(event: string, handler: (data: unknown) => void): (() => void) | void;
    emit(event: string, data: unknown): void;
}

export type ResearchRunnerInput = Readonly<{
    ownerRunId: string;
    cwd: string;
    input: BrainstormResearchInput;
    signal?: AbortSignal;
}>;

export type ResearchRunnerDependencies = Readonly<{
    childTimeoutMs?: number;
    deadlineGraceMs?: number;
    createDeadlineSignal?: DelegationClientOptions["createDeadlineSignal"];
}>;

export function createResearchRunner(
    events: ResearchEventBus,
    dependencies: ResearchRunnerDependencies = {},
) {
    const childTimeoutMs =
        dependencies.childTimeoutMs ?? RESEARCH_CHILD_TIMEOUT_MS;
    const deadlineGraceMs =
        dependencies.deadlineGraceMs ?? RESEARCH_DEADLINE_GRACE_MS;
    const client = new DelegationClient(
        {
            on(event, handler) {
                return events.on(event, handler) ?? (() => undefined);
            },
            emit(event, data) {
                events.emit(event, data);
            },
        },
        { createDeadlineSignal: dependencies.createDeadlineSignal },
    );

    return {
        async run(
            input: ResearchRunnerInput,
        ): Promise<BrainstormResearchResult> {
            const delegation = buildResearchDelegation(input.input);
            const attemptId = randomUUID();
            const nodeId = `research-${input.input.domain}-${attemptId}`;
            const requestId = `${input.ownerRunId}:${nodeId}`;
            const request: SubagentDelegationRequest = {
                requestId,
                ownerRunId: input.ownerRunId,
                nodeId,
                agent: delegation.agent,
                task: delegation.task,
                context: delegation.context,
                cwd: input.cwd,
                artifacts: false,
                timeoutMs: childTimeoutMs,
                result: {
                    kind: "structured",
                    schema: delegation.schema,
                },
            };
            const response = await client.run(request, {
                signal: input.signal,
                deadlineMs: childTimeoutMs + deadlineGraceMs,
            });
            if (
                response.status !== "completed" ||
                response.agent !== delegation.agent ||
                response.exitCode !== 0 ||
                response.result?.kind !== "structured"
            ) {
                throw new Error(
                    response.error ??
                        `Brainstorm research returned an invalid terminal result from ${response.agent ?? "unknown agent"} (${response.status}).`,
                );
            }
            return parseResearchResult(response.result.value);
        },
        dispose(): void {
            client.dispose();
        },
    };
}
