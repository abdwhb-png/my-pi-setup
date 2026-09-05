export const THINK_TELEMETRY_SCHEMA_VERSION = 1 as const;
export const THINK_AUDIT_BOUNDS = {
    days: 30,
    limit: 100,
    maxInputChars: 50_000,
} as const;

export type ThinkTelemetryOrigin = "think_execute" | "think_batch_execute";
export type ThinkTelemetryDecision = "allowed" | "blocked";
export type ThinkTelemetryOutcome =
    | "blocked"
    | "succeeded"
    | "failed"
    | "aborted";

export interface ThinkTelemetryEvent {
    schemaVersion: typeof THINK_TELEMETRY_SCHEMA_VERSION;
    eventId: string;
    timestamp: string;
    sessionId: string;
    origin: ThinkTelemetryOrigin;
    toolCallId: string;
    cwd: string;
    project: string;
    sequence: number;
    decision: ThinkTelemetryDecision;
    outcome: ThinkTelemetryOutcome;
    command?: string;
    commandLength: number;
    groupId?: string;
    patternId?: string;
    reason?: string;
    error?: string;
}
