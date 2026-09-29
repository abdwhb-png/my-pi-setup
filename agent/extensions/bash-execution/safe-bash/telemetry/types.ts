import type { CommandScopeVerdict } from "../../../_shared/command-execution/guard.ts";
import type { CommandGuardPolicy } from "../../../_shared/command-execution/policy.ts";

export const SAFE_BASH_TELEMETRY_SCHEMA_VERSION = 2 as const;
export const SAFE_BASH_AUDIT_BOUNDS = {
    days: 365,
    limit: 500,
} as const;

export type SafeBashDecision = "allowed" | "blocked";
export type SafeBashOutcome = "blocked" | "succeeded" | "failed" | "aborted";
export type SafeBashOrigin = "safe_bash";

export interface SafeBashTelemetryEvent {
    schemaVersion: typeof SAFE_BASH_TELEMETRY_SCHEMA_VERSION;
    eventId: string;
    timestamp: string;
    sessionId: string;
    origin: SafeBashOrigin;
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
    /**
     * Effective guard policy for the matched group. Optional and additive: the
     * schema version stays put, and records written before this field simply
     * lack it.
     */
    policy?: CommandGuardPolicy;
    /** Scope verdict, when a `cwd-only` scope decided the outcome. */
    scopeVerdict?: CommandScopeVerdict;
    /** Resolved targets the scope inspected, bounded and redacted. */
    targets?: string[];
    /** Earlier blocked event that repeated this event's resolved target set. */
    repeatOfEventId?: string;
}
