export const COMPRESSION_EVENT_ENTRY_TYPE = "pi:compression:event";

export type CompressionSkippedReason =
    | "non_text_content"
    | "no_change"
    | "not_smaller"
    | "not_shorter"
    | "unsupported_tool"
    | "no_output";
export type CompressionFailedReason =
    | "invalid_backend"
    | "service_error"
    | "timeout"
    | "aborted"
    | "http_error"
    | `http_${number}`
    | "invalid_response"
    | "invalid_json";
export type CompressionKind = "compressed" | "skipped" | "failed";

/**
 * Native engine metrics normalized by the selected backend adapter.
 * Mirrors `CompressionBackendResult.metrics` in save-tokens/tool-results/types.ts.
 */
export interface CompressionBackendMetrics {
    tokensBefore?: number;
    tokensAfter?: number;
    tokensSaved?: number;
    compressionRatio?: number;
    transforms?: string[];
    ccrHashes?: string[];
}

export interface CompressionDetails {
    originalLength: number;
    compressedLength: number;
    savedBytes: number;
    savedPct: number;
    archivePath?: string;
    /** UTF-8 byte length of the original output (truthful byte metric). */
    originalUtf8Bytes?: number;
    /** UTF-8 byte length of the compressed output (truthful byte metric). */
    compressedUtf8Bytes?: number;
    /** Conservative local token estimate of the original output. */
    estimatedTokensBefore?: number;
    /** Conservative local token estimate of the compressed output. */
    estimatedTokensAfter?: number;
}

export interface CompressionEventBase {
    kind: CompressionKind;
    toolCallId: string;
    toolName: string;
    timestamp: number;
    originalLength: number;
    subject?: string;
    /** Selected backend id (headroom | edgee) — Task 10 telemetry. */
    backend?: string;
    /** Verified backend engine version (crate version or upstream pin). */
    backendVersion?: string;
    /** Backend call latency in ms, measured by the policy layer. */
    latencyMs?: number;
    /** Tokenizer family selected by the engine registry, when factual. */
    tokenizer?: string;
    /** Native engine metrics normalized by the adapter, when present. */
    nativeMetrics?: CompressionBackendMetrics;
    /** UTF-8 byte length of the original output. */
    originalUtf8Bytes?: number;
    /** UTF-8 byte length of the compressed output. */
    compressedUtf8Bytes?: number;
    /** Conservative local token estimate of the original output. */
    estimatedTokensBefore?: number;
    /** Conservative local token estimate of the compressed output. */
    estimatedTokensAfter?: number;
}

export interface CompressionCompressedEvent extends CompressionEventBase {
    kind: "compressed";
    compressedLength: number;
    savedBytes: number;
    savedPct: number;
    archivePath?: string;
}

export interface CompressionSkippedEvent extends CompressionEventBase {
    kind: "skipped";
    reason: CompressionSkippedReason;
}

export interface CompressionFailedEvent extends CompressionEventBase {
    kind: "failed";
    reason: CompressionFailedReason;
}

export type CompressionEventPayload =
    | CompressionCompressedEvent
    | CompressionSkippedEvent
    | CompressionFailedEvent;

interface AppendEntryApi {
    appendEntry: (customType: string, data?: CompressionEventPayload) => void;
}

interface CompressionEntry {
    type: string;
    customType?: string;
    data?: object;
}

export function appendCompressionEvent(
    pi: AppendEntryApi,
    payload: CompressionEventPayload,
): void {
    pi.appendEntry(COMPRESSION_EVENT_ENTRY_TYPE, payload);
}

function isCompressionEventPayload(
    data: CompressionEntry["data"],
): data is CompressionEventPayload {
    if (!data || typeof data !== "object") return false;
    if (
        !("toolCallId" in data) ||
        !("toolName" in data) ||
        !("timestamp" in data) ||
        !("kind" in data) ||
        !("originalLength" in data)
    ) {
        return false;
    }
    return (
        typeof data.toolCallId === "string" &&
        typeof data.toolName === "string" &&
        typeof data.timestamp === "number" &&
        typeof data.originalLength === "number" &&
        (data.kind === "compressed" ||
            data.kind === "skipped" ||
            data.kind === "failed")
    );
}

export function listCompressionEvents(
    entries: ReadonlyArray<CompressionEntry>,
): CompressionEventPayload[] {
    const latestByToolCallId = new Map<string, CompressionEventPayload>();
    for (const entry of entries) {
        if (
            entry.type !== "custom" ||
            entry.customType !== COMPRESSION_EVENT_ENTRY_TYPE
        )
            continue;
        if (!isCompressionEventPayload(entry.data)) continue;
        latestByToolCallId.set(entry.data.toolCallId, entry.data);
    }
    return Array.from(latestByToolCallId.values()).toSorted(
        (a, b) => a.timestamp - b.timestamp,
    );
}

export function findCompressionEventByToolCallId(
    entries: ReadonlyArray<CompressionEntry>,
    toolCallId: string,
): CompressionEventPayload | null {
    return (
        listCompressionEvents(entries).find(
            (entry) => entry.toolCallId === toolCallId,
        ) ?? null
    );
}

export function getLatestCompressionEvent(
    entries: ReadonlyArray<CompressionEntry>,
    toolName?: string,
): CompressionEventPayload | null {
    const filtered = toolName
        ? listCompressionEvents(entries).filter(
              (entry) => entry.toolName === toolName,
          )
        : listCompressionEvents(entries);
    return filtered.length > 0 ? filtered[filtered.length - 1] : null;
}
