/**
 * Versioned telemetry schema for save-tokens extension.
 *
 * Covers: session, agent run, turn, raw/final tool result, mode change,
 * experiment tag.
 *
 * Each record carries common identity: schemaVersion, eventId, timestamp ISO,
 * sessionId. runId / turnIndex added where semantically required.
 *
 * Experimental compression snapshot distinguishes config/demande/effective
 * for each compressor (Caveman, Ponytail) — pure observation, not causality.
 *
 * This schema is independent of the compression protocol in
 * ../_shared/compression-protocol.ts; it describes what was OBSERVED, not
 * what was appended to the session.
 */

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

export const TELEMETRY_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Event type discriminant
// ---------------------------------------------------------------------------

export type TelemetryEventType =
    | 'session_start'
    | 'session_end'
    | 'agent_run_start'
    | 'agent_run_end'
    | 'turn_start'
    | 'turn_end'
    | 'raw_tool_result'
    | 'final_tool_result'
    | 'mode_change'
    | 'experiment_tag';

// ---------------------------------------------------------------------------
// JSON-safe value type (for content, input, details payloads)
// ---------------------------------------------------------------------------

export type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Usage metrics
// ---------------------------------------------------------------------------

export interface UsageMetrics {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
    cost?: number;
}

// ---------------------------------------------------------------------------
// Compression details (observed compression effect on a tool result)
// ---------------------------------------------------------------------------

export interface CompressionDetails {
    originalLength: number;
    compressedLength: number;
    savedBytes: number;
    savedPct: number;
    archivePath?: string;
    kind?: string;
    reason?: string;
}

// ---------------------------------------------------------------------------
// Runtime context (composable — mix into events that need it)
// ---------------------------------------------------------------------------

export interface TelemetryRuntimeContext {
    provider?: string;
    model?: string;
    thinkingLevel?: string;
    cwd?: string;
    project?: string;
    experimentTag?: string;
}

// ---------------------------------------------------------------------------
// Common identity
// ---------------------------------------------------------------------------

export interface TelemetryIdentity {
    schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
    eventId: string;
    timestamp: string;
    sessionId: string;
}

// ---------------------------------------------------------------------------
// Base event (extends identity, adds optional run/turn context)
// ---------------------------------------------------------------------------

export interface TelemetryEventBase extends TelemetryIdentity {
    runId?: string;
    turnIndex?: number;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export interface TelemetrySessionStart extends TelemetryEventBase, TelemetryRuntimeContext {
    event: 'session_start';
    extensions?: string[];
    configSnapshot?: TelemetryConfigSnapshot;
}

export interface TelemetrySessionEnd extends TelemetryEventBase {
    event: 'session_end';
    durationMs: number;
    toolCallCount: number;
}

// ---------------------------------------------------------------------------
// Agent run
// ---------------------------------------------------------------------------

export interface TelemetryAgentRunStart extends TelemetryEventBase, TelemetryRuntimeContext {
    event: 'agent_run_start';
    runId: string;
    turnCount?: number;
}

export interface TelemetryAgentRunEnd extends TelemetryEventBase, TelemetryRuntimeContext {
    event: 'agent_run_end';
    runId: string;
    durationMs: number;
    turnCount: number;
}

// ---------------------------------------------------------------------------
// Turn
// ---------------------------------------------------------------------------

export interface TelemetryTurnStart extends TelemetryEventBase, TelemetryRuntimeContext {
    event: 'turn_start';
    runId: string;
    turnIndex: number;
}

export interface TelemetryTurnEnd extends TelemetryEventBase, TelemetryRuntimeContext {
    event: 'turn_end';
    runId: string;
    turnIndex: number;
    toolCallCount: number;
    durationMs?: number;
    usage?: UsageMetrics;
}

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

export interface TelemetryRawToolResult extends TelemetryEventBase {
    event: 'raw_tool_result';
    runId: string;
    turnIndex: number;
    toolCallId: string;
    toolName: string;
    contentLength: number;
    contentType?: string;
    isError?: boolean;
    content?: JsonValue;
    input?: JsonValue;
    details?: JsonValue;
}

export interface TelemetryFinalToolResult extends TelemetryEventBase {
    event: 'final_tool_result';
    runId: string;
    turnIndex: number;
    toolCallId: string;
    toolName: string;
    contentLength: number;
    contentType?: string;
    isError?: boolean;
    content?: JsonValue;
    input?: JsonValue;
    details?: JsonValue;
    compressors?: CompressionSnapshotField[];
    compressionDetails?: CompressionDetails;
}

// ---------------------------------------------------------------------------
// Mode change
// ---------------------------------------------------------------------------

export interface TelemetryModeChange extends TelemetryEventBase {
    event: 'mode_change';
    component: string;
    requested: string;
    effective?: string;
    previous: string;
    next: string;
    source?: string;
}

// ---------------------------------------------------------------------------
// Experiment tag
// ---------------------------------------------------------------------------

export interface TelemetryExperimentTag extends TelemetryEventBase {
    event: 'experiment_tag';
    tag: string;
    value?: string | number | boolean;
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export type TelemetryEvent =
    | TelemetrySessionStart
    | TelemetrySessionEnd
    | TelemetryAgentRunStart
    | TelemetryAgentRunEnd
    | TelemetryTurnStart
    | TelemetryTurnEnd
    | TelemetryRawToolResult
    | TelemetryFinalToolResult
    | TelemetryModeChange
    | TelemetryExperimentTag;

// ---------------------------------------------------------------------------
// Compression snapshot — experimental observation
// ---------------------------------------------------------------------------

export interface CompressionSnapshotField {
    compressor: 'local-compressor' | 'caveman' | 'ponytail';
    configured: Record<string, unknown>;
    requested: Record<string, unknown>;
    effective: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Config snapshot (lightweight, embedded in session_start)
// ---------------------------------------------------------------------------

export interface TelemetryConfigSnapshot {
    enabled: boolean;
    captureContent: boolean;
    redactSecrets: boolean;
    retentionDays: number;
}
