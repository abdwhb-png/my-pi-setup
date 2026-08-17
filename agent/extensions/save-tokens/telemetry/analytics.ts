/**
 * Pure analytics engine for save-tokens telemetry.
 *
 * Provides reusable scan/filter/aggregate/export primitives consumed
 * by future Pi commands (/save-tokens-stats, /save-tokens-export).
 *
 * Design constraints:
 * - Observation-only: API names use "observed"/"group", never "impact" or "cause".
 * - No Pi runtime dependency: pure functions operating on TelemetryEvent arrays.
 * - Streaming-aware: delegates all I/O to readTelemetryFile from storage.ts.
 *
 * Pipeline:
 *   1. scanTelemetryArchive    → raw TelemetryEvent[] + diagnostics
 *   2. filterAndAnnotate       → AnnotatedEvent[] (mode/tag resolved, filtered)
 *   3. aggregateGroups         → AggregateRow[] (one per comparative group)
 *   4. exportJson / exportCsv  → string
 */

import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  readTelemetryFile,
  isValidCalendarDate,
} from "./storage";
import type { TelemetryEvent, TelemetryModeChange, TelemetryExperimentTag, TelemetryTurnEnd, TelemetryFinalToolResult, TelemetrySessionEnd, TelemetryAgentRunEnd } from "./types";

// ---------------------------------------------------------------------------
// Export version
// ---------------------------------------------------------------------------

/** Version tag embedded in every JSON export for compatibility tracking. */
export const ANALYTICS_EXPORT_VERSION = 1;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Filter/query parameters for scan + filter pipeline. */
export interface ScanOptions {
  /** Archive root directory. */
  root: string;
  /** Inclusive start date (YYYY-MM-DD). */
  from?: string;
  /** Inclusive end date (YYYY-MM-DD). */
  to?: string;
}

/** Filter parameters applied after scan (on annotated events). */
export interface FilterOptions {
  /** Only events with this provider (from runtime context). */
  provider?: string;
  /** Only events with this model name. */
  model?: string;
  /** Only events from this project (cwd). */
  project?: string;
  /** Only events with this thinking level. */
  thinkingLevel?: string;
  /** Filter caveman mode: "on" (any non-off), "off", or a specific value. */
  caveman?: string;
  /** Filter ponytail mode: "on" (any non-off), "off", or a specific value. */
  ponytail?: string;
  /** Only events with this effective experiment tag. */
  experimentTag?: string;
}

/** Diagnostics collected during archive scanning. */
export interface ScanDiagnostics {
  /** Number of date directories that don't match YYYY-MM-DD. */
  invalidDates: number;
  /** Number of symlinks skipped (directories and files). */
  symlinksSkipped: number;
  /** Number of non-regular files skipped (FIFO, device, socket). */
  nonRegularFilesSkipped: number;
  /** Number of malformed/unschema JSON lines encountered. */
  malformedRecords: number;
  /** Number of duplicate eventId records dropped. */
  duplicateEventIds: number;
  /** Total JSONL files scanned. */
  totalFilesScanned: number;
  /** Total unique session IDs encountered. */
  totalSessionsScanned: number;
  /** Total raw events returned before dedup. */
  totalEventsScanned: number;
}

/** Raw scan result: deduplicated + sorted events plus diagnostics. */
export interface ScanResult {
  records: TelemetryEvent[];
  diagnostics: ScanDiagnostics;
}

/** A single event annotated with its effective mode/tag state at event time. */
export interface AnnotatedEvent {
  event: TelemetryEvent;
  cavemanMode: string;
  ponytailMode: string;
  experimentTag: string | undefined;
  // Convenience denormalized fields for aggregation:
  sessionId: string;
  runId: string | undefined;
  turnIndex: number | undefined;
  provider: string | undefined;
  model: string | undefined;
  project: string | undefined;
  thinkingLevel: string | undefined;
}

/** Result of filterAndAnnotate. */
export interface FilterAndAnnotateResult {
  annotated: AnnotatedEvent[];
}

/** Compression aggregate sub-row. */
export interface CompressionAggregate {
  compressedCount: number;
  skippedCount: number;
  failedCount: number;
  /** Sum of original output UTF-16 code units (chars) across observed results. */
  originalChars: number;
  /** Sum of final output UTF-16 code units (chars) across observed results. */
  finalChars: number;
  /** Char-derived savings (historical name retained; NOT bytes). */
  savedBytes: number;
  /** Global ratio: savedBytes / originalChars * 100, or 0 if no chars. */
  savingsPct: number;
}

/** One aggregate row for a comparative group. */
export interface AggregateRow {
  /** Stable group key: observed_off_off | observed_caveman_only | observed_ponytail_only | observed_combined */
  groupKey: string;
  sessionCount: number;
  runCount: number;
  turnCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  sessionDurationMs: number;
  runDurationMs: number;
  turnDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
  observedCompression: CompressionAggregate;
}

/** Full analytics result with query metadata and diagnostics. */
export interface AnalyticsResult {
  query: ScanOptions & FilterOptions;
  diagnostics: ScanDiagnostics;
  rows: AggregateRow[];
}

// ---------------------------------------------------------------------------
// 1. scanTelemetryArchive
// ---------------------------------------------------------------------------

/**
 * Scan the telemetry archive root for JSONL files, read them via
 * readTelemetryFile, deduplicate by eventId, and sort chronologically.
 *
 * Safety:
 * - Uses lstat to skip symlinks (directories and files).
 * - Skips non-.jsonl files.
 * - Skips date directories that fail isValidCalendarDate.
 * - Counts malformed/duplicate records in diagnostics.
 *
 * @returns deduplicated, sorted records + diagnostics. Never throws on
 *          individual file errors (counted in malformedRecords).
 */
export async function scanTelemetryArchive(
  options: ScanOptions,
): Promise<ScanResult> {
  // ── Validate from/to dates ──────────────────────────────────────────
  if (options.from !== undefined) {
    if (!isValidCalendarDate(options.from)) {
      throw new Error(`Invalid "from" date: "${options.from}" (expected valid YYYY-MM-DD)`);
    }
  }
  if (options.to !== undefined) {
    if (!isValidCalendarDate(options.to)) {
      throw new Error(`Invalid "to" date: "${options.to}" (expected valid YYYY-MM-DD)`);
    }
  }
  if (options.from !== undefined && options.to !== undefined && options.from > options.to) {
    throw new Error(
      `Invalid date range: "from" (${options.from}) is after "to" (${options.to})`,
    );
  }

  const diag: ScanDiagnostics = {
    invalidDates: 0,
    symlinksSkipped: 0,
    nonRegularFilesSkipped: 0,
    malformedRecords: 0,
    duplicateEventIds: 0,
    totalFilesScanned: 0,
    totalSessionsScanned: 0,
    totalEventsScanned: 0,
  };

  const root = options.root;

  // Collect all session files to read: { dateStr, sessionId }
  const sessionFiles: Array<{ dateStr: string; sessionId: string }> = [];

  try {
    const dateEntries = await readdir(root);
    for (const dateEntry of dateEntries) {
      const datePath = join(root, dateEntry);

      // lstat — do not follow symlinks
      let dateStat;
      try {
        dateStat = await lstat(datePath);
      } catch {
        diag.symlinksSkipped++;
        continue;
      }

      // Symlinked directory → skip entirely (check BEFORE isDirectory,
      // because lstat on a symlink returns isDirectory=false)
      if (dateStat.isSymbolicLink()) {
        diag.symlinksSkipped++;
        continue;
      }

      if (!dateStat.isDirectory()) {
        continue; // skip files at root level
      }

      // Skip known internal metadata directories (e.g. exports/ created by
      // the default export path — see commands.ts resolveExportPath).
      if (dateEntry === "exports") {
        continue;
      }

      // Validate calendar date
      if (!isValidCalendarDate(dateEntry)) {
        diag.invalidDates++;
        continue;
      }

      // Date range filter (from/to inclusive)
      if (options.from && dateEntry < options.from) continue;
      if (options.to && dateEntry > options.to) continue;

      // List session files
      let sessionEntries;
      try {
        sessionEntries = await readdir(datePath);
      } catch {
        continue; // can't read directory
      }

      for (const sessionEntry of sessionEntries) {
        if (!sessionEntry.endsWith(".jsonl")) continue;

        const sessionPath = join(datePath, sessionEntry);

        // lstat each session file, skip symlinks and non-regular files
        try {
          const sessionStat = await lstat(sessionPath);
          if (sessionStat.isSymbolicLink()) {
            diag.symlinksSkipped++;
            continue;
          }
          if (!sessionStat.isFile()) {
            diag.nonRegularFilesSkipped++;
            continue;
          }
        } catch {
          diag.symlinksSkipped++;
          continue;
        }

        const sessionId = sessionEntry.slice(0, -6); // remove ".jsonl"
        sessionFiles.push({ dateStr: dateEntry, sessionId });
      }
    }
  } catch {
    // root doesn't exist or can't be read → empty result
  }

  diag.totalFilesScanned = sessionFiles.length;

  // Read all session files
  const allRecords: TelemetryEvent[] = [];
  const sessionIds = new Set<string>();

  for (const sf of sessionFiles) {
    try {
      const result = await readTelemetryFile(root, sf.dateStr, sf.sessionId);
      diag.malformedRecords += result.invalidLines;
      for (const record of result.records) {
        allRecords.push(record);
        sessionIds.add(record.sessionId);
      }
    } catch {
      diag.malformedRecords++;
    }
  }

  diag.totalEventsScanned = allRecords.length;
  diag.totalSessionsScanned = sessionIds.size;

  // Deduplicate by eventId (keep first occurrence)
  const seen = new Set<string>();
  const deduped: TelemetryEvent[] = [];
  for (const record of allRecords) {
    if (seen.has(record.eventId)) {
      diag.duplicateEventIds++;
    } else {
      seen.add(record.eventId);
      deduped.push(record);
    }
  }

  // Sort by timestamp, then stable by insertion order
  deduped.sort((a, b) => {
    const tsCmp = a.timestamp.localeCompare(b.timestamp);
    if (tsCmp !== 0) return tsCmp;
    return 0; // stable: preserve insertion order for same timestamp
  });

  return { records: deduped, diagnostics: diag };
}

// ---------------------------------------------------------------------------
// 2. filterAndAnnotate — mode/tag reconstruction + filtering
// ---------------------------------------------------------------------------

/** Resolve the effective filter value for caveman/ponytail. */
function modeMatches(effectiveValue: string, filterValue: string): boolean {
  if (filterValue === "on") return effectiveValue !== "off";
  if (filterValue === "off") return effectiveValue === "off";
  return effectiveValue === filterValue;
}

/**
 * Walk events chronologically, reconstructing caveman mode, ponytail mode,
 * experiment tag, and runtime context (provider/model/project/thinkingLevel)
 * state. Events are annotated with the effective state at the time of the
 * event.
 *
 * **Precondition:** `records` must be sorted chronologically (ascending
 * timestamp). scanTelemetryArchive guarantees this; callers constructing
 * synthetic test data must sort before passing.
 *
 * Mode reconstruction:
 * - Default: caveman=off, ponytail=off (reset per session)
 * - mode_change with component="caveman": sets cavemanMode = next
 * - mode_change with component="ponytail": sets ponytailMode = next
 * - Mode changes apply to the mode_change event itself AND subsequent events.
 *
 * Experiment tag:
 * - experiment_tag: sets experimentTag for subsequent events in same session.
 *
 * Runtime context reconstruction (per session, chronological):
 * - Events that carry TelemetryRuntimeContext fields (session_start,
 *   agent_run_start/end, turn_start/end) update the accumulated state.
 * - Events that lack these fields (raw_tool_result, final_tool_result,
 *   mode_change, experiment_tag, session_end) inherit the accumulated state.
 * - A field is only updated when the event explicitly provides a non-undefined
 *   value; this preserves context across events that omit the field.
 * - When a model or provider changes mid-session (e.g. second agent run with
 *   different model), only subsequent events see the new value; earlier events
 *   retain the old context.
 *
 * Filters:
 * - provider/model/project/thinkingLevel: checked against accumulated runtime
 *   state (not raw event fields), so tool results and compression events are
 *   correctly included when filtering.
 * - caveman/ponytail: checked against effective mode at event time.
 * - experimentTag: checked against effective experiment tag at event time.
 */
export function filterAndAnnotate(
  records: TelemetryEvent[],
  options: FilterOptions,
): FilterAndAnnotateResult {
  const annotated: AnnotatedEvent[] = [];

  // Per-session state (mode + runtime context)
  interface SessionState {
    cavemanMode: string;
    ponytailMode: string;
    experimentTag: string | undefined;
    provider: string | undefined;
    model: string | undefined;
    project: string | undefined;
    thinkingLevel: string | undefined;
  }

  const sessionState = new Map<string, SessionState>();

  function getState(sessionId: string): SessionState {
    let s = sessionState.get(sessionId);
    if (!s) {
      s = {
        cavemanMode: "off",
        ponytailMode: "off",
        experimentTag: undefined,
        provider: undefined,
        model: undefined,
        project: undefined,
        thinkingLevel: undefined,
      };
      sessionState.set(sessionId, s);
    }
    return s;
  }

  for (const event of records) {
    const state = getState(event.sessionId);

    // Update mode state BEFORE annotating this event (mode_change affects itself)
    if (event.event === "mode_change") {
      const mc = event as TelemetryModeChange;
      if (mc.component === "caveman") {
        state.cavemanMode = mc.next;
      } else if (mc.component === "ponytail") {
        state.ponytailMode = mc.next;
      }
    }

    if (event.event === "experiment_tag") {
      const et = event as TelemetryExperimentTag;
      state.experimentTag = et.tag;
    }

    // Update runtime context from events that carry TelemetryRuntimeContext.
    // Only update when a field is explicitly provided (not undefined), so
    // accumulated state is preserved for events that lack these fields
    // (raw_tool_result, final_tool_result, mode_change, experiment_tag,
    // session_end).
    const rtCtx = event as {
      provider?: string;
      model?: string;
      thinkingLevel?: string;
      cwd?: string;
      project?: string;
    };
    if (rtCtx.provider !== undefined) state.provider = rtCtx.provider;
    if (rtCtx.model !== undefined) state.model = rtCtx.model;
    if (rtCtx.thinkingLevel !== undefined) state.thinkingLevel = rtCtx.thinkingLevel;
    if (rtCtx.project !== undefined) state.project = rtCtx.project;
    else if (rtCtx.cwd !== undefined) state.project = rtCtx.cwd;

    // Apply filters using accumulated runtime state (not raw event fields).
    // This ensures tool results and compression events are correctly included
    // when filtering by provider/model/project.
    if (options.provider !== undefined && state.provider !== options.provider) continue;
    if (options.model !== undefined && state.model !== options.model) continue;
    if (options.project !== undefined && state.project !== options.project) continue;
    if (options.thinkingLevel !== undefined && state.thinkingLevel !== options.thinkingLevel) continue;
    if (options.caveman !== undefined && !modeMatches(state.cavemanMode, options.caveman)) continue;
    if (options.ponytail !== undefined && !modeMatches(state.ponytailMode, options.ponytail)) continue;
    if (options.experimentTag !== undefined && state.experimentTag !== options.experimentTag) continue;

    // Extract runId / turnIndex
    const runCtx = event as { runId?: string; turnIndex?: number };

    annotated.push({
      event,
      cavemanMode: state.cavemanMode,
      ponytailMode: state.ponytailMode,
      experimentTag: state.experimentTag,
      sessionId: event.sessionId,
      runId: runCtx.runId,
      turnIndex: runCtx.turnIndex,
      provider: state.provider,
      model: state.model,
      project: state.project,
      thinkingLevel: state.thinkingLevel,
    });
  }

  return { annotated };
}

// ---------------------------------------------------------------------------
// 3. aggregateGroups — comparative grouping
// ---------------------------------------------------------------------------

/** Determine the comparative group key from effective modes. */
function groupKey(cavemanMode: string, ponytailMode: string): string {
  const cmOn = cavemanMode !== "off";
  const ptOn = ponytailMode !== "off";

  if (cmOn && ptOn) return "observed_combined";
  if (cmOn && !ptOn) return "observed_caveman_only";
  if (!cmOn && ptOn) return "observed_ponytail_only";
  return "observed_off_off";
}

/** All four group keys in stable order. */
const ALL_GROUP_KEYS = [
  "observed_off_off",
  "observed_caveman_only",
  "observed_ponytail_only",
  "observed_combined",
] as const;

function emptyRow(key: string): AggregateRow {
  return {
    groupKey: key,
    sessionCount: 0,
    runCount: 0,
    turnCount: 0,
    toolCallCount: 0,
    toolErrorCount: 0,
    sessionDurationMs: 0,
    runDurationMs: 0,
    turnDurationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
    observedCompression: {
      compressedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      originalChars: 0,
      finalChars: 0,
      savedBytes: 0,
      savingsPct: 0,
    },
  };
}

/**
 * Aggregate annotated events into one row per comparative group.
 *
 * Metrics collected:
 * - Session, run, turn counts
 * - Tool call and error counts
 * - Duration (session + run)
 * - Usage (tokens + cost)
 * - Compression (counts by kind, bytes, savings pct)
 *
 * All groups always present in output, even if zero members.
 */
/** Event types that carry measured observations (not purely administrative). */
const MEASUREMENT_EVENT_TYPES = new Set([
  "agent_run_start",
  "agent_run_end",
  "turn_start",
  "turn_end",
  "raw_tool_result",
  "final_tool_result",
  "session_end",
]);

export function aggregateGroups(annotated: AnnotatedEvent[]): { rows: AggregateRow[] } {
  const rows = new Map<string, AggregateRow>();
  for (const key of ALL_GROUP_KEYS) {
    rows.set(key, emptyRow(key));
  }

  // Session ID sets per group (for unique measured session counting)
  const measuredSessionSets = new Map<string, Set<string>>();
  for (const key of ALL_GROUP_KEYS) {
    measuredSessionSets.set(key, new Set());
  }

  // Tool error dedup: track composite (sessionId:toolCallId) already counted.
  // Composite prevents false dedup when same toolCallId appears in different sessions.
  const errorToolCallIds = new Set<string>();

  for (const ae of annotated) {
    const key = groupKey(ae.cavemanMode, ae.ponytailMode);
    const row = rows.get(key)!;

    if (MEASUREMENT_EVENT_TYPES.has(ae.event.event)) {
      measuredSessionSets.get(key)!.add(ae.sessionId);
    }

    switch (ae.event.event) {
      case "agent_run_start": {
        row.runCount++;
        break;
      }
      case "turn_end": {
        row.turnCount++;
        const te = ae.event as unknown as TelemetryTurnEnd;
        row.toolCallCount += te.toolCallCount ?? 0;
        if (te.durationMs !== undefined) {
          row.turnDurationMs += te.durationMs;
        }
        if (te.usage) {
          row.inputTokens += te.usage.inputTokens ?? 0;
          row.outputTokens += te.usage.outputTokens ?? 0;
          row.cacheReadTokens += te.usage.cacheReadTokens ?? 0;
          row.cacheWriteTokens += te.usage.cacheWriteTokens ?? 0;
          row.totalTokens += te.usage.totalTokens ?? 0;
          row.cost += te.usage.cost ?? 0;
        }
        break;
      }
      case "session_end": {
        const se = ae.event as unknown as TelemetrySessionEnd;
        row.sessionDurationMs += se.durationMs ?? 0;
        break;
      }
      case "agent_run_end": {
        const re = ae.event as unknown as TelemetryAgentRunEnd;
        row.runDurationMs += re.durationMs ?? 0;
        break;
      }
      case "final_tool_result": {
        const ftr = ae.event as unknown as TelemetryFinalToolResult;
        if (ftr.isError && !errorToolCallIds.has(`${ae.sessionId}:${ftr.toolCallId}`)) {
          errorToolCallIds.add(`${ae.sessionId}:${ftr.toolCallId}`);
          row.toolErrorCount++;
        }
        const cd = ftr.compressionDetails;
        if (cd) {
          const comp = row.observedCompression;
          comp.originalChars += cd.originalLength;
          comp.finalChars += cd.compressedLength;
          comp.savedBytes += cd.savedBytes;
          switch (cd.kind) {
            case "compressed":
              comp.compressedCount++;
              break;
            case "skipped":
              comp.skippedCount++;
              break;
            case "failed":
              comp.failedCount++;
              break;
            // unknown kind: still counted in bytes but not categorized
          }
        } else {
          // No compression details observed — count contentLength as both
          // original and final (no compression effect observed)
          const comp = row.observedCompression;
          comp.originalChars += ftr.contentLength;
          comp.finalChars += ftr.contentLength;
        }
        break;
      }
      case "raw_tool_result": {
        const rtr = ae.event as unknown as { isError?: boolean; toolCallId?: string };
        if (rtr.isError && rtr.toolCallId && !errorToolCallIds.has(`${ae.sessionId}:${rtr.toolCallId}`)) {
          errorToolCallIds.add(`${ae.sessionId}:${rtr.toolCallId}`);
          row.toolErrorCount++;
        }
        break;
      }
    }
  }

  // Finalize: set measured session counts and compute savings pct
  for (const key of ALL_GROUP_KEYS) {
    const row = rows.get(key)!;
    row.sessionCount = measuredSessionSets.get(key)!.size;

    // Global savings ratio (not average of percentages)
    const comp = row.observedCompression;
    if (comp.originalChars > 0) {
      comp.savingsPct = (comp.savedBytes / comp.originalChars) * 100;
    }
  }

  return { rows: ALL_GROUP_KEYS.map((k) => rows.get(k)!) };
}

// ---------------------------------------------------------------------------
// 4. Export helpers
// ---------------------------------------------------------------------------

type CsvColumnKey =
  | Exclude<keyof AggregateRow, "observedCompression">
  | `compression.${keyof CompressionAggregate}`;
type CsvFieldValue = string | number | boolean | null | undefined;

const CSV_COLUMNS: Array<{ key: CsvColumnKey; label: string }> = [
  { key: "groupKey", label: "groupKey" },
  { key: "sessionCount", label: "sessionCount" },
  { key: "runCount", label: "runCount" },
  { key: "turnCount", label: "turnCount" },
  { key: "toolCallCount", label: "toolCallCount" },
  { key: "toolErrorCount", label: "toolErrorCount" },
  { key: "sessionDurationMs", label: "sessionDurationMs" },
  { key: "runDurationMs", label: "runDurationMs" },
  { key: "turnDurationMs", label: "turnDurationMs" },
  { key: "inputTokens", label: "inputTokens" },
  { key: "outputTokens", label: "outputTokens" },
  { key: "cacheReadTokens", label: "cacheReadTokens" },
  { key: "cacheWriteTokens", label: "cacheWriteTokens" },
  { key: "totalTokens", label: "totalTokens" },
  { key: "cost", label: "cost" },
  { key: "compression.compressedCount", label: "compression_compressedCount" },
  { key: "compression.skippedCount", label: "compression_skippedCount" },
  { key: "compression.failedCount", label: "compression_failedCount" },
  { key: "compression.originalChars", label: "compression_originalChars" },
  { key: "compression.finalChars", label: "compression_finalChars" },
  { key: "compression.savedBytes", label: "compression_savedBytes" },
  { key: "compression.savingsPct", label: "compression_savingsPct" },
];

function escapeCsvField(value: CsvFieldValue): string {
  const str = value == null ? "" : String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Stable JSON stringify with sorted keys — deterministic output.
 * Recursively sorts object keys alphabetically.
 */
function stableStringify(value: unknown, space: number): string {
  const seen = new WeakSet<object>();

  function serialize(val: unknown): unknown {
    if (val === null || typeof val !== "object") return val;
    if (seen.has(val as object)) return "[Circular]";
    seen.add(val as object);

    if (Array.isArray(val)) {
      return val.map(serialize);
    }

    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(val as Record<string, unknown>).sort();
    for (const k of keys) {
      sorted[k] = serialize((val as Record<string, unknown>)[k]);
    }
    return sorted;
  }

  const serialized = serialize(value) as Record<string, unknown>;
  // Put exportVersion first, then sorted keys
  const withVersion: Record<string, unknown> = { exportVersion: ANALYTICS_EXPORT_VERSION };
  for (const k of Object.keys(serialized).sort()) {
    withVersion[k] = serialized[k];
  }

  return JSON.stringify(withVersion, null, space);
}

/**
 * Export analytics result as deterministic, versioned JSON string.
 * Keys sorted alphabetically, exportVersion embedded.
 */
export function exportJson(result: AnalyticsResult): string {
  return stableStringify(result, 2);
}

/**
 * Export analytics result as CSV string.
 * Header row + one data row per group. Properly escapes commas, quotes, newlines.
 * Column order is stable and deterministic.
 */
export function exportCsv(result: AnalyticsResult): string {
  const header = CSV_COLUMNS.map((c) => c.label).join(",");
  const dataRows = result.rows.map((row) => {
    // Convert row to flat record for column access
    const flat: Record<CsvColumnKey, CsvFieldValue> = {
      groupKey: row.groupKey,
      sessionCount: row.sessionCount,
      runCount: row.runCount,
      turnCount: row.turnCount,
      toolCallCount: row.toolCallCount,
      toolErrorCount: row.toolErrorCount,
      sessionDurationMs: row.sessionDurationMs,
      runDurationMs: row.runDurationMs,
      turnDurationMs: row.turnDurationMs,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      totalTokens: row.totalTokens,
      cost: row.cost,
      "compression.compressedCount": row.observedCompression.compressedCount,
      "compression.skippedCount": row.observedCompression.skippedCount,
      "compression.failedCount": row.observedCompression.failedCount,
      "compression.originalChars": row.observedCompression.originalChars,
      "compression.finalChars": row.observedCompression.finalChars,
      "compression.savedBytes": row.observedCompression.savedBytes,
      "compression.savingsPct": row.observedCompression.savingsPct,
    };
    return CSV_COLUMNS.map((c) => escapeCsvField(flat[c.key])).join(",");
  });

  return header + "\n" + dataRows.join("\n") + (dataRows.length > 0 ? "\n" : "");
}
