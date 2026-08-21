import type {
    SubagentDelegationRequest,
    SubagentDelegationResponse,
    SubagentDelegationStarted,
    SubagentDelegationUpdate,
    SubagentDelegationUsage,
    SubagentDelegationValue,
} from "pi-subagents/delegation";

export type SddDelegationRequest = SubagentDelegationRequest;
export type SddDelegationStarted = SubagentDelegationStarted;
export type SddDelegationUpdate = SubagentDelegationUpdate;
export type SddDelegationStatus = SubagentDelegationResponse["status"];

/**
 * Durable SDD-owned terminal boundary.
 *
 * `version`, `output`, and the legacy evidence fields remain optional only so
 * snapshots written by the 0.40 integration stay readable. New 0.50 responses
 * are normalized from `result` and `usage` by DelegationClient.
 */
export interface SddDelegationResponse {
    version?: 1;
    requestId: string;
    ownerRunId?: string;
    nodeId?: string;
    status: SddDelegationStatus;
    error?: string;
    runId?: string;
    agent?: string;
    model?: string;
    thinking?: string;
    exitCode?: number;
    launchContractDigest?: string;
    result?: SubagentDelegationValue;
    usage?: SubagentDelegationUsage;
    output?: string;
    outputPath?: string;
    sessionFile?: string;
    acceptance?: {
        status: string;
        evidenceStatus?: string;
        explicit: boolean;
    };
    turns?: number;
    toolCount?: number;
    durationMs?: number;
    tokens?: number;
    warnings?: string[];
}

export function delegationOutput(
    response: SddDelegationResponse,
): string | undefined {
    if (response.result?.kind === "text") return response.result.text;
    if (response.result?.kind === "structured") {
        return JSON.stringify(response.result.value);
    }
    return response.output;
}

export function delegationUsage(response: SddDelegationResponse): {
    durationMs?: number;
    tokens?: number;
    toolCount?: number;
} {
    if (!response.usage) {
        return {
            ...(response.durationMs === undefined
                ? {}
                : { durationMs: response.durationMs }),
            ...(response.tokens === undefined
                ? {}
                : { tokens: response.tokens }),
            ...(response.toolCount === undefined
                ? {}
                : { toolCount: response.toolCount }),
        };
    }
    return {
        durationMs: response.usage.durationMs,
        tokens:
            response.usage.input +
            response.usage.output +
            response.usage.cacheRead +
            response.usage.cacheWrite,
        toolCount: response.usage.toolCalls,
    };
}
