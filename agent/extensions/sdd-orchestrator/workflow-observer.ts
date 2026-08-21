import type {
    SddDelegationResponse,
    SddDelegationStarted,
    SddDelegationUpdate,
} from "./delegation-contract.ts";
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
        event: SddDelegationStarted,
    ): void;
    onDelegationUpdate?(
        context: SddDelegationActivityContext,
        event: SddDelegationUpdate,
    ): void;
    onDelegationFinished?(
        context: SddDelegationActivityContext,
        response: SddDelegationResponse,
    ): void;
}
