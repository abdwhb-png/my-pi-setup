import type {
    SubagentDelegationResponse,
    SubagentDelegationUpdate,
} from "pi-subagents/delegation";

import type { RunSnapshot } from "./state-machine";

export interface SddDelegationActivityContext {
    readonly runId: string;
    readonly taskId: string;
    readonly requestId: string;
    readonly stage: string;
    readonly attempt: number;
    readonly agent: string;
    readonly model?: string;
}

export interface SddWorkflowObserver {
    onSnapshot?(snapshot: RunSnapshot): void;
    onDelegationPrepared?(context: SddDelegationActivityContext): void;
    onDelegationStarted?(
        context: SddDelegationActivityContext,
        event: Pick<SubagentDelegationResponse, "version" | "requestId">,
    ): void;
    onDelegationUpdate?(
        context: SddDelegationActivityContext,
        event: SubagentDelegationUpdate,
    ): void;
    onDelegationFinished?(
        context: SddDelegationActivityContext,
        response: SubagentDelegationResponse,
    ): void;
}
