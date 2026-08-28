export const SAFE_BASH_TELEMETRY_SCHEMA_VERSION = 1 as const;
export const SAFE_BASH_AUDIT_BOUNDS = {
    days: 365,
    limit: 500,
} as const;

export type SafeBashDecision = "allowed" | "blocked";
export type SafeBashOutcome = "blocked" | "succeeded" | "failed" | "aborted";

export interface SafeBashTelemetryEvent {
    schemaVersion: typeof SAFE_BASH_TELEMETRY_SCHEMA_VERSION;
    eventId: string;
    timestamp: string;
    sessionId: string;
    toolCallId: string;
    cwd: string;
    project: string;
    sequence: number;
    decision: SafeBashDecision;
    outcome: SafeBashOutcome;
    command?: string;
    commandLength: number;
    groupId?: string;
    patternId?: string;
    reason?: string;
    error?: string;
}
