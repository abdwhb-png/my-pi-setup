import type {
    SubagentDelegationRequest,
    SubagentDelegationStarted,
    SubagentDelegationUpdate,
    SubagentDelegationStatus,
    SubagentDelegationValue,
    SubagentDelegationUsage,
} from "pi-subagents/delegation";

export type DelegationRequest = SubagentDelegationRequest;
export type DelegationStarted = SubagentDelegationStarted;
export type DelegationUpdate = SubagentDelegationUpdate;
export type DelegationStatus = SubagentDelegationStatus;
export type DelegationValue = SubagentDelegationValue;
export type DelegationUsage = SubagentDelegationUsage;

export interface DelegationResponse {
    requestId: string;
    ownerRunId?: string;
    nodeId?: string;
    status: DelegationStatus;
    error?: string;
    runId?: string;
    agent?: string;
    model?: string;
    thinking?: string;
    exitCode?: number;
    launchContractDigest?: string;
    result?: DelegationValue;
    usage?: DelegationUsage;
}
