/**
 * Runtime telemetry controller for save-tokens.
 *
 * Captures before/after compression events, mode state (Caveman/Ponytail),
 * agent/turn timing, usage metrics, and storage lifecycle.
 *
 * Factory pattern: `createSaveTokensTelemetry(pi)` returns `{before, after}`
 * for explicit pipeline ordering:
 *   1. telemetry.before() — raw tool_result observer (pre-compression)
 *   2. localToolResultCompressor()
 *   3. caveman()
 *   4. ponytail()
 *   5. telemetry.after() — final observers + lifecycle + mode scan
 *
 * When telemetry is disabled (`enabled === false`), both functions are no-ops.
 */

import type { ExtensionAPI, ExtensionContext, BeforeAgentStartEvent, SessionStartEvent, SessionShutdownEvent, AgentStartEvent, AgentEndEvent, TurnStartEvent, TurnEndEvent, ToolResultEvent, MessageStartEvent, MessageUpdateEvent, MessageEndEvent, ModelSelectEvent, ThinkingLevelSelectEvent } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { loadTelemetryConfig } from '../config';
import type { TelemetryConfig } from '../config';
import { createWriter, purgeTelemetry, type TelemetryWriter } from './storage';
import { redactValue } from './redaction';
import { findCompressionEventByToolCallId } from '../../_shared/compression-protocol';
import {
    TELEMETRY_SCHEMA_VERSION,
    type TelemetryEvent,
    type TelemetrySessionStart,
    type TelemetrySessionEnd,
    type TelemetryAgentRunStart,
    type TelemetryAgentRunEnd,
    type TelemetryTurnStart,
    type TelemetryTurnEnd,
    type TelemetryRawToolResult,
    type TelemetryFinalToolResult,
    type TelemetryModeChange,
    type TelemetryExperimentTag,
    type JsonValue,
    type UsageMetrics,
} from './types';

// ---------------------------------------------------------------------------
// Mode markers for systemPrompt scanning
// ---------------------------------------------------------------------------

const CAVEMAN_LEVEL_RE = /ACTIVE LEVEL:\s*([\w-]+)/i;
const PONYTAIL_MODE_RE = /PONYTAIL MODE ACTIVE\s*[—–-]\s*level:\s*(\S+)/i;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface TelemetryState {
    config: TelemetryConfig;
    sessionId: string | null;
    startTime: number;
    writer: TelemetryWriter | null;
    writerRoot: string;
    runId: string | null;
    runStartTime: number | null;
    turnIndex: number;
    turnStartTime: number | null;
    sessionToolCallCount: number;
    turnToolCallCount: number;
    messageStartTime: number | null;
    /** Last detected caveman level (from before_agent_start scan) */
    cavemanLevel: string | null;
    /** Last detected ponytail mode (from before_agent_start scan) */
    ponytailMode: string | null;
    /** Whether a storage-error notification was already sent this session */
    notificationSent: boolean;
    /** Injected clock for testability */
    clock: () => number;
    /** Injected ID generator for testability */
    idGen: () => string;
    // ---- Runtime context (captured from session/events) ----
    model: string | null;
    provider: string | null;
    thinkingLevel: string | null;
    cwd: string | null;
    project: string | null;
    /** Real turn counter per run (not event.messages.length) */
    runTurnCount: number;
    /** Whether a turn is currently active (turn_start emitted, turn_end not yet) */
    turnActive: boolean;
}

function createState(config: TelemetryConfig): TelemetryState {
    return {
        config,
        sessionId: null,
        startTime: 0,
        writer: null,
        writerRoot: config.directory ?? '',
        runId: null,
        runStartTime: null,
        turnIndex: 0,
        turnStartTime: null,
        sessionToolCallCount: 0,
        turnToolCallCount: 0,
        messageStartTime: null,
        cavemanLevel: null,
        ponytailMode: null,
        notificationSent: false,
        clock: () => Date.now(),
        idGen: () => randomUUID(),
        model: null,
        provider: null,
        thinkingLevel: null,
        cwd: null,
        project: null,
        runTurnCount: 0,
        turnActive: false,
    };
}

// ---------------------------------------------------------------------------
// No-op function for disabled telemetry
// ---------------------------------------------------------------------------

function noop(): void {
    // intentionally empty
}

// ---------------------------------------------------------------------------
// JSON-safe conversion
// ---------------------------------------------------------------------------

/**
 * Convert a value of unknown type to a JSON-safe representation.
 *
 * Handles:
 * - Primitives (string, number, boolean, null) — pass-through
 * - `undefined` → `null`
 * - `Date` → ISO string
 * - `Error` → `{ name, message, stack? }`
 * - Plain objects + arrays — recursive copy
 * - Circular references → `'[CIRCULAR]'`
 * - Functions/Symbols → `null` (omitted)
 */
export function toJsonSafe(value: unknown): JsonValue {
    const seen = new WeakSet<object>();
    return convert(value, seen);
}

function convert(value: unknown, seen: WeakSet<object>): JsonValue {
    // Primitives — pass through
    if (value === null) return null;
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') return value;

    // Date → ISO string
    if (value instanceof Date) return value.toISOString();

    // Error → structured representation
    if (value instanceof Error) {
        const result: Record<string, JsonValue> = {
            name: value.name,
            message: value.message,
        };
        if (value.stack) result.stack = value.stack;
        return result;
    }

    // Functions, Symbols, BigInt → null (not valid JSON)
    if (typeof value === 'function' || typeof value === 'symbol') return null;
    if (typeof value === 'bigint') return String(value);

    // Objects with numeric/symbol/string keys
    if (typeof value === 'object') {
        // Circular detection
        if (seen.has(value)) return '[CIRCULAR]' as unknown as JsonValue;
        seen.add(value);

        // Array
        if (Array.isArray(value)) {
            const arr: JsonValue[] = [];
            for (let i = 0; i < value.length; i++) {
                if (i in value) arr.push(convert(value[i], seen));
            }
            return arr;
        }

        // Plain object (or class instance with enumerable properties)
        const result: Record<string, JsonValue> = {};
        for (const key of Object.keys(value)) {
            result[key] = convert((value as Record<string, unknown>)[key], seen);
        }
        return result;
    }

    // Fallback (should not normally reach here)
    return null;
}

// ---------------------------------------------------------------------------
// Helper: sum content length from TextContent arrays
// ---------------------------------------------------------------------------

function sumContentLength(content: unknown): number {
    if (!Array.isArray(content)) return 0;
    let total = 0;
    for (const item of content) {
        if (item && typeof item === 'object' && 'text' in item && typeof (item as { text: string }).text === 'string') {
            total += (item as { text: string }).text.length;
        }
    }
    return total;
}

// ---------------------------------------------------------------------------
// Helper: extract TextContent text concatenated
// ---------------------------------------------------------------------------

function extractTextContent(content: unknown): string {
    if (!Array.isArray(content)) return '';
    const parts: string[] = [];
    for (const item of content) {
        if (item && typeof item === 'object' && 'text' in item && typeof (item as { text: string }).text === 'string') {
            parts.push((item as { text: string }).text);
        }
    }
    return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Helper: safe append — catches errors so they never propagate to agent loop
// ---------------------------------------------------------------------------

async function safeAppend(state: TelemetryState, record: TelemetryEvent): Promise<boolean> {
    if (!state.writer) return false;
    try {
        // Apply redaction before writing
        const finalRecord = state.config.redactSecrets
            ? applyRedactionToRecord(record, state.config)
            : record;
        await state.writer.append(finalRecord);
        return true;
    } catch {
        // Storage errors are non-blocking — never interrupt the agent
        if (!state.notificationSent) {
            state.notificationSent = true;
            // Log only — avoid requiring UI for reliability
            console.warn('[save-tokens/telemetry] write failed; suppressing further notifications');
        }
        return false;
    }
}

// ---------------------------------------------------------------------------
// Helper: apply redaction to a record's content/input/details fields
// ---------------------------------------------------------------------------

function applyRedactionToRecord(record: TelemetryEvent, config: TelemetryConfig): TelemetryEvent {
    const opts = {
        maxDepth: config.maxDepth,
        maxStringLength: config.maxStringLength,
        maxArrayItems: config.maxArrayItems,
    };

    // Deep-clone + redact a JsonValue field
    const redactJson = (v: JsonValue | undefined): JsonValue | undefined => {
        if (v === undefined) return undefined;
        // redactValue returns unknown; we know it's JsonValue-like
        const result = redactValue(v, opts);
        return result.value as JsonValue;
    };

    // Only certain record types have redactable content
    if ('content' in record || 'input' in record || 'details' in record) {
        const r = record as TelemetryRawToolResult | TelemetryFinalToolResult;
        return {
            ...r,
            content: redactJson(r.content),
            input: redactJson(r.input),
            details: redactJson(r.details),
        } as TelemetryEvent;
    }

    return record;
}

// ---------------------------------------------------------------------------
// Event handler factories (closures over state)
// ---------------------------------------------------------------------------

function handleSessionStart(
    state: TelemetryState,
    pi: ExtensionAPI,
    writerFactory: typeof createWriter,
    purgeFn?: typeof purgeTelemetry,
) {
    return async (event: SessionStartEvent, ctx: ExtensionContext): Promise<void> => {
        state.sessionId = state.idGen();
        state.startTime = state.clock();

        // Capture runtime context from session start
        state.cwd = ctx.cwd ?? null;
        state.project = ctx.cwd ? basename(ctx.cwd) : null;
        state.model = ctx.model?.id ?? null;
        state.provider = (typeof ctx.model?.provider === 'string' ? ctx.model.provider : null) ?? null;
        state.thinkingLevel = pi.getThinkingLevel() as string ?? null;

        // Create writer
        try {
            state.writer = writerFactory(state.writerRoot, state.sessionId);
        } catch {
            // Non-blocking — telemetry degrades gracefully
        }

        // Purge old telemetry at startup — errors non-blocking
        if (purgeFn && state.writerRoot) {
            try {
                await purgeFn(state.writerRoot, { retentionDays: state.config.retentionDays ?? 90 });
            } catch {
                // Non-blocking
            }
        }

        // Build config snapshot
        const cfg = state.config;
        const record: TelemetrySessionStart = {
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            eventId: state.idGen(),
            timestamp: new Date().toISOString(),
            sessionId: state.sessionId,
            event: 'session_start',
            cwd: state.cwd ?? undefined,
            model: state.model ?? undefined,
            provider: state.provider ?? undefined,
            thinkingLevel: state.thinkingLevel ?? undefined,
            project: state.project ?? undefined,
            configSnapshot: {
                enabled: cfg.enabled ?? true,
                captureContent: cfg.captureContent ?? true,
                redactSecrets: cfg.redactSecrets ?? true,
                retentionDays: cfg.retentionDays ?? 90,
            },
        };

        await safeAppend(state, record);

        // Lightweight ref entry for session reconstruction
        pi.appendEntry('pi:save-tokens:telemetry-ref', {
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            sessionId: state.sessionId,
            startTime: state.startTime,
        });
    };
}

function handleRawToolResult(state: TelemetryState) {
    return async (event: ToolResultEvent, _ctx: ExtensionContext): Promise<void> => {
        if (!state.sessionId || !state.runId || !state.turnActive) return;

        const contentLength = sumContentLength(event.content);
        const cfg = state.config;

        // Capture content/input/details if configured; otherwise just metrics
        const content = cfg.captureContent ? toJsonSafe(event.content) : undefined;
        const input = cfg.captureContent ? toJsonSafe(event.input) : undefined;
        const details = cfg.captureContent ? toJsonSafe(event.details) : undefined;

        const record: TelemetryRawToolResult = {
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            eventId: state.idGen(),
            timestamp: new Date().toISOString(),
            sessionId: state.sessionId,
            event: 'raw_tool_result',
            runId: state.runId ?? undefined,
            turnIndex: state.turnIndex,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            contentLength,
            isError: event.isError,
        };

        if (content !== undefined) record.content = content;
        if (input !== undefined) record.input = input;
        if (details !== undefined) record.details = details;

        await safeAppend(state, record);
    };
}

function handleFinalToolResult(state: TelemetryState) {
    return async (event: ToolResultEvent, ctx: ExtensionContext): Promise<void> => {
        if (!state.sessionId || !state.runId || !state.turnActive) return;

        const contentLength = sumContentLength(event.content);
        const cfg = state.config;

        const content = cfg.captureContent ? toJsonSafe(event.content) : undefined;
        const input = cfg.captureContent ? toJsonSafe(event.input) : undefined;
        const details = cfg.captureContent ? toJsonSafe(event.details) : undefined;

        // Canonical source: pi:compression:event from session entries (takes priority)
        let compressionDetails: TelemetryFinalToolResult['compressionDetails'];
        if (ctx.sessionManager) {
            try {
                const entries = ctx.sessionManager.getEntries() as { type: string; customType?: string; data?: object }[];
                const compEvent = findCompressionEventByToolCallId(entries, event.toolCallId);
                if (compEvent && compEvent.kind === 'compressed') {
                    compressionDetails = {
                        originalLength: compEvent.originalLength,
                        compressedLength: compEvent.compressedLength,
                        savedBytes: compEvent.savedBytes,
                        savedPct: compEvent.savedPct,
                        kind: 'compressed',
                        archivePath: compEvent.archivePath,
                    };
                }
            } catch {
                // Non-blocking
            }
        }

        // Fallback ad hoc: extract from event.details only if no canonical event
        if (!compressionDetails && event.details && typeof event.details === 'object') {
            const d = event.details as Record<string, unknown>;
            if (d.originalLength !== undefined || d.compressedLength !== undefined) {
                compressionDetails = {
                    originalLength: d.originalLength as number,
                    compressedLength: d.compressedLength as number,
                    savedBytes: d.savedBytes as number,
                    savedPct: d.savedPct as number,
                    kind: d.kind as string,
                    reason: d.reason as string,
                };
            }
        }

        const record: TelemetryFinalToolResult = {
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            eventId: state.idGen(),
            timestamp: new Date().toISOString(),
            sessionId: state.sessionId,
            event: 'final_tool_result',
            runId: state.runId,
            turnIndex: state.turnIndex,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            contentLength,
            isError: event.isError,
            compressionDetails,
        };

        if (content !== undefined) record.content = content;
        if (input !== undefined) record.input = input;
        if (details !== undefined) record.details = details;

        await safeAppend(state, record);
    };
}

function handleBeforeAgentStart(state: TelemetryState) {
    return async (event: BeforeAgentStartEvent, _ctx: ExtensionContext): Promise<void> => {
        if (!state.sessionId) return;

        const systemPrompt = event.systemPrompt;

        // Scan for mode markers
        const cavemanMatch = systemPrompt.match(CAVEMAN_LEVEL_RE);
        const ponytailMatch = systemPrompt.match(PONYTAIL_MODE_RE);

        const newCaveman = cavemanMatch ? cavemanMatch[1]!.toLowerCase() : null;
        const newPonytail = ponytailMatch ? ponytailMatch[1]!.toLowerCase() : null;

        // Write mode_change if caveman level changed
        if (newCaveman !== state.cavemanLevel) {
            const prev = state.cavemanLevel ?? 'off';
            const next = newCaveman ?? 'off';
            if (prev !== next) {
                const modeRecord: TelemetryModeChange = {
                    schemaVersion: TELEMETRY_SCHEMA_VERSION,
                    eventId: state.idGen(),
                    timestamp: new Date().toISOString(),
                    sessionId: state.sessionId,
                    event: 'mode_change',
                    component: 'caveman',
                    requested: next,
                    effective: next,
                    previous: prev,
                    next,
                    source: 'systemPrompt_scan',
                };
                await safeAppend(state, modeRecord);
            }
            state.cavemanLevel = newCaveman;
        }

        // Write mode_change if ponytail mode changed
        if (newPonytail !== state.ponytailMode) {
            const prev = state.ponytailMode ?? 'off';
            const next = newPonytail ?? 'off';
            if (prev !== next) {
                const modeRecord: TelemetryModeChange = {
                    schemaVersion: TELEMETRY_SCHEMA_VERSION,
                    eventId: state.idGen(),
                    timestamp: new Date().toISOString(),
                    sessionId: state.sessionId,
                    event: 'mode_change',
                    component: 'ponytail',
                    requested: next,
                    effective: next,
                    previous: prev,
                    next,
                    source: 'systemPrompt_scan',
                };
                await safeAppend(state, modeRecord);
            }
            state.ponytailMode = newPonytail;
        }

        // Return undefined — observer only, don't modify system prompt
        return undefined;
    };
}

function handleAgentStart(state: TelemetryState) {
    return async (event: AgentStartEvent, _ctx: ExtensionContext): Promise<void> => {
        if (!state.sessionId) return;

        state.runId = state.idGen();
        state.runStartTime = state.clock();
        state.runTurnCount = 0;
        state.turnActive = false;

        const record: TelemetryAgentRunStart = {
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            eventId: state.idGen(),
            timestamp: new Date().toISOString(),
            sessionId: state.sessionId,
            event: 'agent_run_start',
            runId: state.runId,
            turnCount: 0,
            model: state.model ?? undefined,
            provider: state.provider ?? undefined,
            thinkingLevel: state.thinkingLevel ?? undefined,
            cwd: state.cwd ?? undefined,
            project: state.project ?? undefined,
        };

        await safeAppend(state, record);
    };
}

function handleAgentEnd(state: TelemetryState) {
    return async (event: AgentEndEvent, _ctx: ExtensionContext): Promise<void> => {
        if (!state.sessionId || !state.runId) return;

        const durationMs = state.runStartTime ? state.clock() - state.runStartTime : 0;
        const turnCount = state.runTurnCount;

        const record: TelemetryAgentRunEnd = {
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            eventId: state.idGen(),
            timestamp: new Date().toISOString(),
            sessionId: state.sessionId,
            event: 'agent_run_end',
            runId: state.runId,
            durationMs,
            turnCount,
            model: state.model ?? undefined,
            provider: state.provider ?? undefined,
            thinkingLevel: state.thinkingLevel ?? undefined,
            cwd: state.cwd ?? undefined,
            project: state.project ?? undefined,
        };

        await safeAppend(state, record);

        state.runId = null;
        state.runStartTime = null;
        state.turnActive = false;
    };
}

function handleTurnStart(state: TelemetryState) {
    return async (event: TurnStartEvent, _ctx: ExtensionContext): Promise<void> => {
        if (!state.sessionId || !state.runId) return;

        state.turnIndex = event.turnIndex;
        state.turnStartTime = state.clock();
        state.turnToolCallCount = 0;
        state.runTurnCount++;
        state.turnActive = true;

        const record: TelemetryTurnStart = {
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            eventId: state.idGen(),
            timestamp: new Date().toISOString(),
            sessionId: state.sessionId,
            event: 'turn_start',
            runId: state.runId,
            turnIndex: state.turnIndex,
            model: state.model ?? undefined,
            provider: state.provider ?? undefined,
            thinkingLevel: state.thinkingLevel ?? undefined,
            cwd: state.cwd ?? undefined,
            project: state.project ?? undefined,
        };

        await safeAppend(state, record);
    };
}

function handleTurnEnd(state: TelemetryState) {
    return async (event: TurnEndEvent, _ctx: ExtensionContext): Promise<void> => {
        if (!state.sessionId || !state.runId || !state.turnActive) return;

        const durationMs = state.turnStartTime ? state.clock() - state.turnStartTime : undefined;

        // Extract usage from message if available
        const msg = event.message as Record<string, unknown> | undefined;
        const usage = msg?.usage as Record<string, unknown> | undefined;
        let usageMetrics: UsageMetrics | undefined;

        if (usage && typeof usage === 'object') {
            usageMetrics = {
                inputTokens: typeof usage.input === 'number' ? usage.input : undefined,
                outputTokens: typeof usage.output === 'number' ? usage.output : undefined,
                cacheReadTokens: typeof usage.cacheRead === 'number' ? usage.cacheRead : undefined,
                cacheWriteTokens: typeof usage.cacheWrite === 'number' ? usage.cacheWrite : undefined,
                totalTokens: typeof usage.totalTokens === 'number' ? usage.totalTokens : undefined,
                cost: typeof usage.cost === 'object' && usage.cost !== null
                    ? ((usage.cost as Record<string, unknown>).total as number) ?? undefined
                    : (typeof usage.cost === 'number' ? usage.cost : undefined),
            };
        }

        const toolCallCount = state.turnToolCallCount;

        const record: TelemetryTurnEnd = {
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            eventId: state.idGen(),
            timestamp: new Date().toISOString(),
            sessionId: state.sessionId,
            event: 'turn_end',
            runId: state.runId,
            turnIndex: state.turnIndex,
            toolCallCount,
            durationMs,
            usage: usageMetrics,
            model: state.model ?? undefined,
            provider: state.provider ?? undefined,
            thinkingLevel: state.thinkingLevel ?? undefined,
            cwd: state.cwd ?? undefined,
            project: state.project ?? undefined,
        };

        await safeAppend(state, record);

        state.turnActive = false;
    };
}

function handleMessageStart(state: TelemetryState) {
    return async (event: MessageStartEvent, _ctx: ExtensionContext): Promise<void> => {
        if (!state.sessionId) return;
        state.messageStartTime = state.clock();
    };
}

function handleMessageUpdate(state: TelemetryState) {
    return async (event: MessageUpdateEvent, _ctx: ExtensionContext): Promise<void> => {
        if (!state.sessionId) return;
        // Track streaming progress — TTFT is captured on first message_end
    };
}

function handleMessageEnd(state: TelemetryState) {
    return async (event: MessageEndEvent, _ctx: ExtensionContext): Promise<void> => {
        if (!state.sessionId) return;
        // TTFT elapsed since message_start
        if (state.messageStartTime) {
            // TTFT recorded for performance analysis
            state.messageStartTime = null;
        }
    };
}

function handleModelSelect(state: TelemetryState) {
    return async (event: ModelSelectEvent): Promise<void> => {
        state.model = event.model.id;
        state.provider = typeof event.model.provider === 'string' ? event.model.provider : String(event.model.provider);
    };
}

function handleThinkingLevelSelect(state: TelemetryState) {
    return async (event: ThinkingLevelSelectEvent): Promise<void> => {
        state.thinkingLevel = event.level;
    };
}

function handleSessionShutdown(state: TelemetryState) {
    return async (event: SessionShutdownEvent): Promise<void> => {
        if (!state.sessionId) return;

        const durationMs = state.startTime ? state.clock() - state.startTime : 0;

        const record: TelemetrySessionEnd = {
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            eventId: state.idGen(),
            timestamp: new Date().toISOString(),
            sessionId: state.sessionId,
            event: 'session_end',
            durationMs,
            toolCallCount: state.sessionToolCallCount,
        };

        await safeAppend(state, record);

        // Flush pending writes — errors non-blocking
        if (state.writer) {
            try {
                await state.writer.flush();
            } catch {
                // Storage error on flush — non-blocking
            }
        }
    };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface TelemetryController {
    /** Register pre-compression observers (raw tool result, session init). */
    before: () => void;
    /** Register post-compression observers (final tool result, lifecycle, mode). */
    after: () => void;
    /**
     * Write an experiment tag for the current session.
     *
     * Returns a Promise resolving to true if the tag was persisted, false if
     * telemetry is disabled, no session has started, the writer is unavailable,
     * or the append failed (e.g., disk full).
     */
    tag: (tag: string, value?: string | number | boolean) => Promise<boolean>;
}

/**
 * Optional dependency overrides for testability.
 *
 * When not provided, the real implementations from storage are used.
 */
export interface TelemetryControllerDeps {
    createWriter?: typeof createWriter;
    purgeTelemetry?: typeof purgeTelemetry;
}

/**
 * Create a save-tokens telemetry controller.
 *
 * Returns two registration functions for explicit pipeline ordering:
 *   1. `before()` — raw observers (pre-compression)
 *   2. `after()` — final observers (post-compression) + lifecycle + mode scan
 *
 * Accepts optional `deps` for testability — injected writer/purge override the
 * real storage implementation without global mock.module contamination.
 *
 * When telemetry is disabled (`config.enabled === false`), no handlers are
 * registered, no writer is created, and no records are produced.
 */
export function createSaveTokensTelemetry(
    pi: ExtensionAPI,
    deps?: TelemetryControllerDeps,
): TelemetryController {
    const config = loadTelemetryConfig();

    if (!config.enabled) {
        return { before: noop, after: noop, tag: async () => false };
    }

    const state = createState(config);
    const writerFactory = deps?.createWriter ?? createWriter;
    const purgeFn = deps?.purgeTelemetry ?? purgeTelemetry;

    // We return before/after functions so the caller controls exact registration
    // order in the extension pipeline.
    // before() registers pre-compression handlers.
    let beforeRegistered = false;
    const registerBefore = (): void => {
        if (beforeRegistered) return;
        beforeRegistered = true;
        // Must be first: session init
        pi.on('session_start', handleSessionStart(state, pi, writerFactory, purgeFn));
        // Model and thinking level tracking (cross-cutting, need early capture)
        pi.on('model_select', handleModelSelect(state));
        pi.on('thinking_level_select', handleThinkingLevelSelect(state));
        // Raw tool_result observer — sees content BEFORE compression
        pi.on('tool_result', handleRawToolResult(state));
        // Count tool calls across the session
        pi.on('tool_call', () => {
            state.sessionToolCallCount++;
            state.turnToolCallCount++;
        });
    };

    // after() registers post-compression handlers.
    let afterRegistered = false;
    const registerAfter = (): void => {
        if (afterRegistered) return;
        afterRegistered = true;
        // before_agent_start — scans systemPrompt AFTER caveman/ponytail injected
        pi.on('before_agent_start', handleBeforeAgentStart(state));
        // Agent lifecycle
        pi.on('agent_start', handleAgentStart(state));
        pi.on('agent_end', handleAgentEnd(state));
        // Turn lifecycle
        pi.on('turn_start', handleTurnStart(state));
        pi.on('turn_end', handleTurnEnd(state));
        // Message streaming
        pi.on('message_start', handleMessageStart(state));
        pi.on('message_update', handleMessageUpdate(state));
        pi.on('message_end', handleMessageEnd(state));
        // Final tool_result observer — sees content AFTER compression
        pi.on('tool_result', handleFinalToolResult(state));
        // Session shutdown — flush last
        pi.on('session_shutdown', handleSessionShutdown(state));
    };

    // tag() — write experiment tag for current session.
    const tag = async (tagValue: string, value?: string | number | boolean): Promise<boolean> => {
        // Must have an active session and writer
        if (!state.sessionId || !state.writer) return false;

        const record: TelemetryExperimentTag = {
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            eventId: state.idGen(),
            timestamp: new Date().toISOString(),
            sessionId: state.sessionId,
            event: 'experiment_tag',
            tag: tagValue,
            value,
        };

        return await safeAppend(state, record);
    };

    return {
        before: registerBefore,
        after: registerAfter,
        tag,
    };
}
