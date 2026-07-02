export const COMPRESSION_EVENT_ENTRY_TYPE = "pi:compression:event";

export type CompressionSkippedReason = "non_text_content" | "no_change" | "not_smaller";
export type CompressionFailedReason = "service_error";
export type CompressionKind = "compressed" | "skipped" | "failed";

export interface CompressionDetails {
  originalLength: number;
  compressedLength: number;
  savedBytes: number;
  savedPct: number;
}

export interface CompressionEventBase {
  kind: CompressionKind;
  toolCallId: string;
  toolName: string;
  timestamp: number;
  originalLength: number;
  subject?: string;
}

export interface CompressionCompressedEvent extends CompressionEventBase {
  kind: "compressed";
  compressedLength: number;
  savedBytes: number;
  savedPct: number;
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

export function appendCompressionEvent(pi: AppendEntryApi, payload: CompressionEventPayload): void {
  pi.appendEntry(COMPRESSION_EVENT_ENTRY_TYPE, payload);
}

function isCompressionEventPayload(data: CompressionEntry["data"]): data is CompressionEventPayload {
  if (!data || typeof data !== "object") return false;
  if (!("toolCallId" in data) || !("toolName" in data) || !("timestamp" in data) || !("kind" in data) || !("originalLength" in data)) {
    return false;
  }
  return typeof data.toolCallId === "string"
    && typeof data.toolName === "string"
    && typeof data.timestamp === "number"
    && typeof data.originalLength === "number"
    && (data.kind === "compressed" || data.kind === "skipped" || data.kind === "failed");
}

export function listCompressionEvents(entries: ReadonlyArray<CompressionEntry>): CompressionEventPayload[] {
  const latestByToolCallId = new Map<string, CompressionEventPayload>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== COMPRESSION_EVENT_ENTRY_TYPE) continue;
    if (!isCompressionEventPayload(entry.data)) continue;
    latestByToolCallId.set(entry.data.toolCallId, entry.data);
  }
  return Array.from(latestByToolCallId.values()).toSorted((a, b) => a.timestamp - b.timestamp);
}

export function findCompressionEventByToolCallId(
  entries: ReadonlyArray<CompressionEntry>,
  toolCallId: string,
): CompressionEventPayload | null {
  return listCompressionEvents(entries).find((entry) => entry.toolCallId === toolCallId) ?? null;
}

export function getLatestCompressionEvent(
  entries: ReadonlyArray<CompressionEntry>,
  toolName?: string,
): CompressionEventPayload | null {
  const filtered = toolName
    ? listCompressionEvents(entries).filter((entry) => entry.toolName === toolName)
    : listCompressionEvents(entries);
  return filtered.length > 0 ? filtered[filtered.length - 1] : null;
}