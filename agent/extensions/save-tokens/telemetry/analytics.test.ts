/**
 * Tests for telemetry analytics engine.
 *
 * Covers:
 * - Safe scan (no symlinks, invalid dates, malformed records → diagnostics)
 * - Chronological mode/tag reconstruction from mode_change & experiment_tag
 * - Filtering (from/to date, provider, model, project, caveman, ponytail, experimentTag)
 * - Comparative group assignment (off/off, caveman-only, ponytail-only, combined)
 * - Aggregation (sessions, runs, turns, tool calls, errors, duration, usage, cost, compression)
 * - JSON and CSV export (deterministic, properly escaped)
 * - Deduplication by eventId
 * - Edge cases: empty archive, no mode changes, missing files, streaming errors
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  scanTelemetryArchive,
  filterAndAnnotate,
  aggregateGroups,
  exportJson,
  exportCsv,
  type AnnotatedEvent,
  type AnalyticsResult,
} from "./analytics";
import { TELEMETRY_SCHEMA_VERSION, type TelemetryEvent } from "./types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<TelemetryEvent> & Record<string, unknown>): TelemetryEvent {
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    eventId: "evt-" + Math.random().toString(36).slice(2, 8),
    timestamp: new Date().toISOString(),
    sessionId: "sess-test",
    event: "experiment_tag",
    tag: "test",
    ...overrides,
  } as TelemetryEvent;
}

function makeSessionStart(overrides: Record<string, unknown> = {}) {
  return makeEvent({ event: "session_start", ...overrides });
}

function makeSessionEnd(overrides: Record<string, unknown> = {}) {
  return makeEvent({ event: "session_end", durationMs: 1000, toolCallCount: 5, ...overrides });
}

function makeRunStart(overrides: Record<string, unknown> = {}) {
  return makeEvent({ event: "agent_run_start", runId: "run-1", ...overrides });
}

function makeRunEnd(overrides: Record<string, unknown> = {}) {
  return makeEvent({ event: "agent_run_end", runId: "run-1", durationMs: 500, turnCount: 2, ...overrides });
}

function makeTurnEnd(overrides: Record<string, unknown> = {}) {
  return makeEvent({
    event: "turn_end",
    runId: "run-1",
    turnIndex: 0,
    toolCallCount: 3,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.001 },
    ...overrides,
  });
}

function makeFinalToolResult(overrides: Record<string, unknown> = {}) {
  return makeEvent({
    event: "final_tool_result",
    runId: "run-1",
    turnIndex: 0,
    toolCallId: "tc-1",
    toolName: "read_file",
    contentLength: 500,
    ...overrides,
  });
}

function makeModeChange(overrides: Record<string, unknown> = {}) {
  return makeEvent({
    event: "mode_change",
    component: "caveman",
    requested: "full",
    previous: "off",
    next: "full",
    ...overrides,
  });
}

function makeExperimentTag(overrides: Record<string, unknown> = {}) {
  return makeEvent({ event: "experiment_tag", tag: "baseline", ...overrides });
}

/**
 * Create a temporary directory for I/O tests.
 */
async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "st-analytics-"));
}

/**
 * Write a telemetry JSONL file under root/YYYY-MM-DD/sessionId.jsonl.
 */
async function writeTelemetryFile(
  root: string,
  dateStr: string,
  sessionId: string,
  records: TelemetryEvent[],
): Promise<void> {
  const dir = join(root, dateStr);
  await mkdir(dir, { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(join(dir, `${sessionId}.jsonl`), lines, "utf-8");
}

// ===========================================================================
// 1. scanTelemetryArchive — safe scanning
// ===========================================================================

describe("scanTelemetryArchive", () => {
  it("returns empty records and empty diagnostics for missing root", async () => {
    const root = join(await tempDir(), "nonexistent");
    const result = await scanTelemetryArchive({ root });
    expect(result.records).toEqual([]);
    expect(result.diagnostics.invalidDates).toBe(0);
    expect(result.diagnostics.symlinksSkipped).toBe(0);
    expect(result.diagnostics.malformedRecords).toBe(0);
    expect(result.diagnostics.duplicateEventIds).toBe(0);
  });

  it("scans and reads a single session file", async () => {
    const root = await tempDir();
    const evt = makeSessionStart({ sessionId: "sess-a" });
    await writeTelemetryFile(root, "2026-07-18", "sess-a", [evt]);

    const result = await scanTelemetryArchive({ root });
    expect(result.records.length).toBe(1);
    expect(result.records[0].eventId).toBe(evt.eventId);
    expect(result.diagnostics.malformedRecords).toBe(0);
  });

  it("skips non-JSONL files", async () => {
    const root = await tempDir();
    const evt = makeSessionStart({ sessionId: "sess-a" });
    await writeTelemetryFile(root, "2026-07-18", "sess-a", [evt]);
    // Write a non-jsonl file
    const dateDir = join(root, "2026-07-18");
    await writeFile(join(dateDir, "notes.txt"), "hello", "utf-8");

    const result = await scanTelemetryArchive({ root });
    expect(result.records.length).toBe(1);
    expect(result.records[0].eventId).toBe(evt.eventId);
  });

  it("skips symlinked directories and files", async () => {
    const root = await tempDir();
    const realRoot = await tempDir();
    const evt = makeSessionStart({ sessionId: "sess-real" });
    await writeTelemetryFile(realRoot, "2026-07-18", "sess-real", [evt]);

    // Symlink the date directory
    await symlink(join(realRoot, "2026-07-18"), join(root, "2026-07-18"));

    const result = await scanTelemetryArchive({ root });
    // Symlinked directories are skipped entirely
    expect(result.diagnostics.symlinksSkipped).toBeGreaterThanOrEqual(1);
    // Records from symlinked paths are NOT read
    expect(result.records.length).toBe(0);
  });

  it("skips invalid date directory names", async () => {
    const root = await tempDir();
    // Create invalid date dir
    await mkdir(join(root, "not-a-date"));
    // Create valid date with file
    const evt = makeSessionStart({ sessionId: "sess-a" });
    await writeTelemetryFile(root, "2026-07-18", "sess-a", [evt]);

    const result = await scanTelemetryArchive({ root });
    expect(result.diagnostics.invalidDates).toBe(1);
    expect(result.records.length).toBe(1);
  });

  it("skips known metadata directory exports without incrementing invalidDates", async () => {
    const root = await tempDir();
    // Create exports/ directory (internal metadata, expected at root)
    await mkdir(join(root, "exports"));
    // Create valid date with file — scan must still work
    const evt = makeSessionStart({ sessionId: "sess-a" });
    await writeTelemetryFile(root, "2026-07-18", "sess-a", [evt]);

    const result = await scanTelemetryArchive({ root });
    expect(result.diagnostics.invalidDates).toBe(0);
    expect(result.records.length).toBe(1);
  });

  it("still counts arbitrary non-date directory as invalid when exports is present", async () => {
    const root = await tempDir();
    // exports → silently skipped
    await mkdir(join(root, "exports"));
    // not-a-date → must still increment invalidDates
    await mkdir(join(root, "not-a-date"));
    // Valid date with file
    const evt = makeSessionStart({ sessionId: "sess-a" });
    await writeTelemetryFile(root, "2026-07-18", "sess-a", [evt]);

    const result = await scanTelemetryArchive({ root });
    expect(result.diagnostics.invalidDates).toBe(1);
    expect(result.records.length).toBe(1);
  });

  it("deduplicates by eventId", async () => {
    const root = await tempDir();
    const evt1 = makeSessionStart({ eventId: "dup-1", sessionId: "sess-a" });
    const evt2 = makeSessionStart({ eventId: "dup-1", sessionId: "sess-b" });
    await writeTelemetryFile(root, "2026-07-18", "sess-a", [evt1]);
    await writeTelemetryFile(root, "2026-07-18", "sess-b", [evt2]);

    const result = await scanTelemetryArchive({ root });
    expect(result.records.length).toBe(1);
    expect(result.diagnostics.duplicateEventIds).toBe(1);
  });

  it("counts malformed JSON lines as malformed records", async () => {
    const root = await tempDir();
    const dir = join(root, "2026-07-18");
    await mkdir(dir, { recursive: true });
    // Write a line that isn't valid JSON
    await writeFile(join(dir, "sess-a.jsonl"), "not valid json\n", "utf-8");

    const result = await scanTelemetryArchive({ root });
    expect(result.diagnostics.malformedRecords).toBe(1);
  });

  it("sorts events by timestamp then stable file order", async () => {
    const root = await tempDir();
    const early = makeSessionStart({ timestamp: "2026-07-18T10:00:00.000Z", sessionId: "sess-a" });
    const late = makeSessionStart({ timestamp: "2026-07-18T11:00:00.000Z", sessionId: "sess-b" });
    await writeTelemetryFile(root, "2026-07-18", "sess-a", [early]);
    await writeTelemetryFile(root, "2026-07-18", "sess-b", [late]);

    const result = await scanTelemetryArchive({ root });
    expect(result.records.length).toBe(2);
    expect(result.records[0].timestamp).toBe("2026-07-18T10:00:00.000Z");
    expect(result.records[1].timestamp).toBe("2026-07-18T11:00:00.000Z");
  });

  it("respects from date filter during scan", async () => {
    const root = await tempDir();
    const day1 = makeSessionStart({ timestamp: "2026-07-17T10:00:00.000Z", sessionId: "sess-old" });
    const day2 = makeSessionStart({ timestamp: "2026-07-18T10:00:00.000Z", sessionId: "sess-new" });
    await writeTelemetryFile(root, "2026-07-17", "sess-old", [day1]);
    await writeTelemetryFile(root, "2026-07-18", "sess-new", [day2]);

    const result = await scanTelemetryArchive({ root, from: "2026-07-18" });
    expect(result.records.length).toBe(1);
    expect(result.records[0].sessionId).toBe("sess-new");
  });

  it("respects to date filter during scan", async () => {
    const root = await tempDir();
    const day1 = makeSessionStart({ timestamp: "2026-07-17T10:00:00.000Z", sessionId: "sess-old" });
    const day2 = makeSessionStart({ timestamp: "2026-07-18T10:00:00.000Z", sessionId: "sess-new" });
    await writeTelemetryFile(root, "2026-07-17", "sess-old", [day1]);
    await writeTelemetryFile(root, "2026-07-18", "sess-new", [day2]);

    const result = await scanTelemetryArchive({ root, to: "2026-07-17" });
    expect(result.records.length).toBe(1);
    expect(result.records[0].sessionId).toBe("sess-old");
  });
});

// ===========================================================================
// 2. filterAndAnnotate — mode reconstruction + filtering + annotation
// ===========================================================================

describe("filterAndAnnotate", () => {
  it("reconstructs default off/off modes when no mode_change events", () => {
    const records: TelemetryEvent[] = [
      makeSessionStart({ sessionId: "sess-a" }),
      makeTurnEnd({ sessionId: "sess-a" }),
    ];
    const result = filterAndAnnotate(records, {});
    expect(result.annotated.length).toBe(2);
    // All events should have caveman=off, ponytail=off (default)
    for (const ae of result.annotated) {
      expect(ae.cavemanMode).toBe("off");
      expect(ae.ponytailMode).toBe("off");
      expect(ae.experimentTag).toBeUndefined();
    }
  });

  it("mode_change affects subsequent events, not preceding ones", () => {
    const before = makeTurnEnd({ timestamp: "2026-07-18T09:00:00.000Z", sessionId: "sess-a" });
    const modeChange = makeModeChange({
      timestamp: "2026-07-18T09:30:00.000Z",
      component: "caveman",
      previous: "off",
      next: "full",
      sessionId: "sess-a",
    });
    const after = makeTurnEnd({ timestamp: "2026-07-18T10:00:00.000Z", sessionId: "sess-a" });

    const result = filterAndAnnotate([before, modeChange, after], {});
    expect(result.annotated[0].cavemanMode).toBe("off");
    expect(result.annotated[1].cavemanMode).toBe("full"); // mode_change itself sees the new mode
    expect(result.annotated[2].cavemanMode).toBe("full");
  });

  it("tracks caveman and ponytail modes independently", () => {
    const records: TelemetryEvent[] = [
      makeModeChange({
        timestamp: "2026-07-18T09:00:00.000Z",
        component: "caveman",
        previous: "off",
        next: "full",
        sessionId: "sess-a",
      }),
      makeModeChange({
        timestamp: "2026-07-18T09:30:00.000Z",
        component: "ponytail",
        previous: "off",
        next: "on",
        sessionId: "sess-a",
      }),
      makeTurnEnd({ timestamp: "2026-07-18T10:00:00.000Z", sessionId: "sess-a" }),
    ];
    const result = filterAndAnnotate(records, {});
    const last = result.annotated[result.annotated.length - 1];
    expect(last.cavemanMode).toBe("full");
    expect(last.ponytailMode).toBe("on");
  });

  it("multiple mode changes accumulate state correctly within same session", () => {
    const records: TelemetryEvent[] = [
      makeModeChange({
        timestamp: "2026-07-18T09:00:00.000Z",
        component: "caveman",
        previous: "off",
        next: "lite",
        sessionId: "sess-a",
      }),
      makeTurnEnd({ timestamp: "2026-07-18T09:30:00.000Z", sessionId: "sess-a" }),
      makeModeChange({
        timestamp: "2026-07-18T10:00:00.000Z",
        component: "caveman",
        previous: "lite",
        next: "ultra",
        sessionId: "sess-a",
      }),
      makeTurnEnd({ timestamp: "2026-07-18T10:30:00.000Z", sessionId: "sess-a" }),
    ];
    const result = filterAndAnnotate(records, {});
    expect(result.annotated[1].cavemanMode).toBe("lite");
    expect(result.annotated[3].cavemanMode).toBe("ultra");
  });

  it("mode state resets to off for each new session", () => {
    const records: TelemetryEvent[] = [
      makeModeChange({
        timestamp: "2026-07-18T09:00:00.000Z",
        component: "caveman",
        previous: "off",
        next: "full",
        sessionId: "sess-a",
      }),
      makeTurnEnd({ timestamp: "2026-07-18T09:30:00.000Z", sessionId: "sess-b" }),
    ];
    const result = filterAndAnnotate(records, {});
    // sess-b event should see default "off" since mode was set in sess-a
    const sessB = result.annotated.find((ae) => ae.sessionId === "sess-b")!;
    expect(sessB.cavemanMode).toBe("off");
  });

  it("experiment_tag sets tag for subsequent events in same session", () => {
    const records: TelemetryEvent[] = [
      makeExperimentTag({
        timestamp: "2026-07-18T09:00:00.000Z",
        tag: "baseline",
        sessionId: "sess-a",
      }),
      makeTurnEnd({ timestamp: "2026-07-18T09:30:00.000Z", sessionId: "sess-a" }),
    ];
    const result = filterAndAnnotate(records, {});
    expect(result.annotated[1].experimentTag).toBe("baseline");
  });

  it("experiment_tag does not leak across sessions", () => {
    const records: TelemetryEvent[] = [
      makeExperimentTag({
        timestamp: "2026-07-18T09:00:00.000Z",
        tag: "baseline",
        sessionId: "sess-a",
      }),
      makeTurnEnd({ timestamp: "2026-07-18T09:30:00.000Z", sessionId: "sess-b" }),
    ];
    const result = filterAndAnnotate(records, {});
    const sessB = result.annotated.find((ae) => ae.sessionId === "sess-b")!;
    expect(sessB.experimentTag).toBeUndefined();
  });

  it("filters by provider", () => {
    const records: TelemetryEvent[] = [
      makeTurnEnd({ provider: "openai", sessionId: "sess-a" }),
      makeTurnEnd({ provider: "anthropic", sessionId: "sess-b" }),
    ];
    const result = filterAndAnnotate(records, { provider: "openai" });
    expect(result.annotated.length).toBe(1);
    expect(result.annotated[0].provider).toBe("openai");
  });

  it("filters by model", () => {
    const records: TelemetryEvent[] = [
      makeTurnEnd({ model: "gpt-4", sessionId: "sess-a" }),
      makeTurnEnd({ model: "claude-3", sessionId: "sess-b" }),
    ];
    const result = filterAndAnnotate(records, { model: "gpt-4" });
    expect(result.annotated.length).toBe(1);
    expect(result.annotated[0].model).toBe("gpt-4");
  });

  it("filters by project (cwd)", () => {
    const records: TelemetryEvent[] = [
      makeTurnEnd({ project: "/home/proj-a", sessionId: "sess-a" }),
      makeTurnEnd({ project: "/home/proj-b", sessionId: "sess-b" }),
    ];
    const result = filterAndAnnotate(records, { project: "/home/proj-a" });
    expect(result.annotated.length).toBe(1);
  });

  it("filters by effective caveman mode", () => {
    const records: TelemetryEvent[] = [
      makeTurnEnd({ timestamp: "2026-07-18T09:00:00.000Z", sessionId: "sess-a" }),
      makeModeChange({
        timestamp: "2026-07-18T09:30:00.000Z",
        component: "caveman",
        previous: "off",
        next: "full",
        sessionId: "sess-a",
      }),
      makeTurnEnd({ timestamp: "2026-07-18T10:00:00.000Z", sessionId: "sess-a" }),
    ];
    // Filter to caveman=on (any non-off)
    const result = filterAndAnnotate(records, { caveman: "on" });
    expect(result.annotated.length).toBe(2); // mode_change + turn_end after it
  });

  it("filters by effective ponytail mode", () => {
    const records: TelemetryEvent[] = [
      makeTurnEnd({ timestamp: "2026-07-18T09:00:00.000Z", sessionId: "sess-a" }),
      makeModeChange({
        timestamp: "2026-07-18T09:30:00.000Z",
        component: "ponytail",
        previous: "off",
        next: "on",
        sessionId: "sess-a",
      }),
      makeTurnEnd({ timestamp: "2026-07-18T10:00:00.000Z", sessionId: "sess-a" }),
    ];
    const result = filterAndAnnotate(records, { ponytail: "on" });
    expect(result.annotated.length).toBe(2);
  });

  it("filters by experimentTag on annotated effective tag", () => {
    const records: TelemetryEvent[] = [
      makeExperimentTag({
        timestamp: "2026-07-18T09:00:00.000Z",
        tag: "baseline",
        sessionId: "sess-a",
      }),
      makeTurnEnd({ timestamp: "2026-07-18T09:30:00.000Z", sessionId: "sess-a" }),
    ];
    const result = filterAndAnnotate(records, { experimentTag: "baseline" });
    expect(result.annotated.length).toBe(2); // tag event + turn_end
  });

  it("events without runtime context (provider/model/project) are still annotated", () => {
    const records: TelemetryEvent[] = [makeSessionStart({ sessionId: "sess-a" })];
    const result = filterAndAnnotate(records, {});
    expect(result.annotated.length).toBe(1);
    expect(result.annotated[0].cavemanMode).toBe("off");
  });
});

// ===========================================================================
// 3. aggregateGroups — comparative grouping + metrics
// ===========================================================================

describe("aggregateGroups", () => {
  it("assigns events to off/off group when both modes are off", () => {
    const annotated: AnnotatedEvent[] = [
      {
        event: makeTurnEnd({ sessionId: "sess-a" }),
        cavemanMode: "off",
        ponytailMode: "off",
        experimentTag: undefined,
        sessionId: "sess-a",
        runId: "run-1",
        turnIndex: 0,
        provider: undefined,
        model: undefined,
        project: undefined,
        thinkingLevel: undefined,
      },
    ];
    const result = aggregateGroups(annotated);
    const offOff = result.rows.find((r) => r.groupKey === "observed_off_off")!;
    expect(offOff.sessionCount).toBe(1);
    expect(offOff.turnCount).toBe(1);
  });

  it("assigns to caveman-only when caveman active and ponytail off", () => {
    const annotated: AnnotatedEvent[] = [
      {
        event: makeTurnEnd({ sessionId: "sess-a" }),
        cavemanMode: "full",
        ponytailMode: "off",
        experimentTag: undefined,
        sessionId: "sess-a",
        runId: "run-1",
        turnIndex: 0,
        provider: "openai",
        model: "gpt-4",
        project: "/test",
        thinkingLevel: undefined,
      },
    ];
    const result = aggregateGroups(annotated);
    const cmOnly = result.rows.find((r) => r.groupKey === "observed_caveman_only")!;
    expect(cmOnly.turnCount).toBe(1);
  });

  it("assigns to ponytail-only when ponytail active and caveman off", () => {
    const annotated: AnnotatedEvent[] = [
      {
        event: makeTurnEnd({ sessionId: "sess-a" }),
        cavemanMode: "off",
        ponytailMode: "on",
        experimentTag: undefined,
        sessionId: "sess-a",
        runId: "run-1",
        turnIndex: 0,
        provider: "openai",
        model: "gpt-4",
        project: "/test",
        thinkingLevel: undefined,
      },
    ];
    const result = aggregateGroups(annotated);
    const ptOnly = result.rows.find((r) => r.groupKey === "observed_ponytail_only")!;
    expect(ptOnly.turnCount).toBe(1);
  });

  it("assigns to combined when both modes are active", () => {
    const annotated: AnnotatedEvent[] = [
      {
        event: makeTurnEnd({ sessionId: "sess-a" }),
        cavemanMode: "full",
        ponytailMode: "on",
        experimentTag: undefined,
        sessionId: "sess-a",
        runId: "run-1",
        turnIndex: 0,
        provider: "openai",
        model: "gpt-4",
        project: "/test",
        thinkingLevel: undefined,
      },
    ];
    const result = aggregateGroups(annotated);
    const combined = result.rows.find((r) => r.groupKey === "observed_combined")!;
    expect(combined.turnCount).toBe(1);
  });

  it("counts unique measured sessions per group", () => {
    const ts = "2026-07-18T10:00:00.000Z";
    const annotated: AnnotatedEvent[] = [
      // sess-a: has turn_end → measured
      { event: makeSessionStart({ sessionId: "sess-a", timestamp: ts }), cavemanMode: "off", ponytailMode: "off", experimentTag: undefined, sessionId: "sess-a", runId: undefined, turnIndex: undefined, provider: undefined, model: undefined, project: undefined, thinkingLevel: undefined },
      { event: makeTurnEnd({ sessionId: "sess-a", timestamp: ts }), cavemanMode: "off", ponytailMode: "off", experimentTag: undefined, sessionId: "sess-a", runId: "run-1", turnIndex: 0, provider: undefined, model: undefined, project: undefined, thinkingLevel: undefined },
      // sess-b: only session_start → not measured → excluded from sessionCount
      { event: makeSessionStart({ sessionId: "sess-b", timestamp: ts }), cavemanMode: "off", ponytailMode: "off", experimentTag: undefined, sessionId: "sess-b", runId: undefined, turnIndex: undefined, provider: undefined, model: undefined, project: undefined, thinkingLevel: undefined },
    ];
    const result = aggregateGroups(annotated);
    expect(result.rows[0].sessionCount).toBe(1); // only sess-a
  });

  it("counts runs from agent_run_start events", () => {
    const ts = "2026-07-18T10:00:00.000Z";
    const annotated: AnnotatedEvent[] = [
      { event: makeRunStart({ sessionId: "sess-a", timestamp: ts }), cavemanMode: "off", ponytailMode: "off", experimentTag: undefined, sessionId: "sess-a", runId: "run-1", turnIndex: undefined, provider: undefined, model: undefined, project: undefined, thinkingLevel: undefined },
      { event: makeRunStart({ sessionId: "sess-a", runId: "run-2", timestamp: ts }), cavemanMode: "off", ponytailMode: "off", experimentTag: undefined, sessionId: "sess-a", runId: "run-2", turnIndex: undefined, provider: undefined, model: undefined, project: undefined, thinkingLevel: undefined },
    ];
    const result = aggregateGroups(annotated);
    expect(result.rows[0].runCount).toBe(2);
  });

  it("counts turns from turn_end events", () => {
    const ts = "2026-07-18T10:00:00.000Z";
    const annotated: AnnotatedEvent[] = [
      { event: makeTurnEnd({ sessionId: "sess-a", timestamp: ts }), cavemanMode: "off", ponytailMode: "off", experimentTag: undefined, sessionId: "sess-a", runId: "run-1", turnIndex: 0, provider: undefined, model: undefined, project: undefined, thinkingLevel: undefined },
      { event: makeTurnEnd({ sessionId: "sess-a", turnIndex: 1, timestamp: ts }), cavemanMode: "off", ponytailMode: "off", experimentTag: undefined, sessionId: "sess-a", runId: "run-1", turnIndex: 1, provider: undefined, model: undefined, project: undefined, thinkingLevel: undefined },
    ];
    const result = aggregateGroups(annotated);
    expect(result.rows[0].turnCount).toBe(2);
  });

  it("sums toolCallCount from turn_end events", () => {
    const ts = "2026-07-18T10:00:00.000Z";
    const annotated: AnnotatedEvent[] = [
      { event: makeTurnEnd({ sessionId: "sess-a", toolCallCount: 3, timestamp: ts }), cavemanMode: "off", ponytailMode: "off", experimentTag: undefined, sessionId: "sess-a", runId: "run-1", turnIndex: 0, provider: undefined, model: undefined, project: undefined, thinkingLevel: undefined },
      { event: makeTurnEnd({ sessionId: "sess-a", toolCallCount: 2, timestamp: ts }), cavemanMode: "off", ponytailMode: "off", experimentTag: undefined, sessionId: "sess-a", runId: "run-1", turnIndex: 1, provider: undefined, model: undefined, project: undefined, thinkingLevel: undefined },
    ];
    const result = aggregateGroups(annotated);
    expect(result.rows[0].toolCallCount).toBe(5);
  });

  it("counts tool errors from isError=true tool results", () => {
    const ts = "2026-07-18T10:00:00.000Z";
    const annotated: AnnotatedEvent[] = [
      { event: makeFinalToolResult({ sessionId: "sess-a", isError: true, timestamp: ts }), cavemanMode: "off", ponytailMode: "off", experimentTag: undefined, sessionId: "sess-a", runId: "run-1", turnIndex: 0, provider: undefined, model: undefined, project: undefined, thinkingLevel: undefined },
      { event: makeFinalToolResult({ sessionId: "sess-a", isError: false, timestamp: ts }), cavemanMode: "off", ponytailMode: "off", experimentTag: undefined, sessionId: "sess-a", runId: "run-1", turnIndex: 1, provider: undefined, model: undefined, project: undefined, thinkingLevel: undefined },
    ];
    const result = aggregateGroups(annotated);
    expect(result.rows[0].toolErrorCount).toBe(1);
  });

  it("aggregates usage tokens and cost from turn_end", () => {
    const ts = "2026-07-18T10:00:00.000Z";
    const annotated: AnnotatedEvent[] = [
      {
        event: makeTurnEnd({
          sessionId: "sess-a",
          usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, totalTokens: 165, cost: 0.001 },
          timestamp: ts,
        }),
        cavemanMode: "off", ponytailMode: "off", experimentTag: undefined,
        sessionId: "sess-a", runId: "run-1", turnIndex: 0,
        provider: undefined, model: undefined, project: undefined,
        thinkingLevel: undefined,
      },
      {
        event: makeTurnEnd({
          sessionId: "sess-a",
          usage: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 10, totalTokens: 330, cost: 0.002 },
          timestamp: ts,
        }),
        cavemanMode: "off", ponytailMode: "off", experimentTag: undefined,
        sessionId: "sess-a", runId: "run-1", turnIndex: 1,
        provider: undefined, model: undefined, project: undefined,
        thinkingLevel: undefined,
      },
    ];
    const result = aggregateGroups(annotated);
    expect(result.rows[0].inputTokens).toBe(300);
    expect(result.rows[0].outputTokens).toBe(150);
    expect(result.rows[0].cacheReadTokens).toBe(30);
    expect(result.rows[0].cacheWriteTokens).toBe(15);
    expect(result.rows[0].totalTokens).toBe(495);
    expect(result.rows[0].cost).toBe(0.003);
  });

  it("aggregates session and run duration", () => {
    const ts = "2026-07-18T10:00:00.000Z";
    const annotated: AnnotatedEvent[] = [
      { event: makeSessionEnd({ sessionId: "sess-a", durationMs: 5000, timestamp: ts }), cavemanMode: "off", ponytailMode: "off", experimentTag: undefined, sessionId: "sess-a", runId: undefined, turnIndex: undefined, provider: undefined, model: undefined, project: undefined, thinkingLevel: undefined },
      { event: makeRunEnd({ sessionId: "sess-a", durationMs: 2000, timestamp: ts }), cavemanMode: "off", ponytailMode: "off", experimentTag: undefined, sessionId: "sess-a", runId: "run-1", turnIndex: undefined, provider: undefined, model: undefined, project: undefined, thinkingLevel: undefined },
    ];
    const result = aggregateGroups(annotated);
    expect(result.rows[0].sessionDurationMs).toBe(5000);
    expect(result.rows[0].runDurationMs).toBe(2000);
  });

  it("aggregates compression metrics from final_tool_result.compressionDetails", () => {
    const ts = "2026-07-18T10:00:00.000Z";
    const annotated: AnnotatedEvent[] = [
      {
        event: makeFinalToolResult({
          sessionId: "sess-a",
          contentLength: 200,
          compressionDetails: {
            originalLength: 1000,
            compressedLength: 200,
            savedBytes: 800,
            savedPct: 80,
            kind: "compressed",
          },
          timestamp: ts,
        }),
        cavemanMode: "off", ponytailMode: "off", experimentTag: undefined,
        sessionId: "sess-a", runId: "run-1", turnIndex: 0,
        provider: undefined, model: undefined, project: undefined,
        thinkingLevel: undefined,
      },
      {
        event: makeFinalToolResult({
          sessionId: "sess-a",
          contentLength: 500,
          compressionDetails: {
            originalLength: 500,
            compressedLength: 500,
            savedBytes: 0,
            savedPct: 0,
            kind: "skipped",
            reason: "no_change",
          },
          timestamp: ts,
        }),
        cavemanMode: "off", ponytailMode: "off", experimentTag: undefined,
        sessionId: "sess-a", runId: "run-1", turnIndex: 1,
        provider: undefined, model: undefined, project: undefined,
        thinkingLevel: undefined,
      },
    ];
    const result = aggregateGroups(annotated);
    expect(result.rows[0].observedCompression.compressedCount).toBe(1);
    expect(result.rows[0].observedCompression.skippedCount).toBe(1);
    expect(result.rows[0].observedCompression.failedCount).toBe(0);
    expect(result.rows[0].observedCompression.originalChars).toBe(1500);
    expect(result.rows[0].observedCompression.finalChars).toBe(700); // 200 + 500
    expect(result.rows[0].observedCompression.savedBytes).toBe(800);
    // Global ratio: 800/1500 = ~53.33%
    expect(result.rows[0].observedCompression.savingsPct).toBeCloseTo(53.33, 1);
  });

  it("handles final_tool_result without compressionDetails (no compression observed)", () => {
    const ts = "2026-07-18T10:00:00.000Z";
    const annotated: AnnotatedEvent[] = [
      {
        event: makeFinalToolResult({
          sessionId: "sess-a",
          contentLength: 500,
          // no compressionDetails
          timestamp: ts,
        }),
        cavemanMode: "off", ponytailMode: "off", experimentTag: undefined,
        sessionId: "sess-a", runId: "run-1", turnIndex: 0,
        provider: undefined, model: undefined, project: undefined,
        thinkingLevel: undefined,
      },
    ];
    const result = aggregateGroups(annotated);
    expect(result.rows[0].observedCompression.compressedCount).toBe(0);
    expect(result.rows[0].observedCompression.skippedCount).toBe(0);
    expect(result.rows[0].observedCompression.failedCount).toBe(0);
    expect(result.rows[0].observedCompression.originalChars).toBe(500);
    expect(result.rows[0].observedCompression.finalChars).toBe(500);
    expect(result.rows[0].observedCompression.savedBytes).toBe(0);
    expect(result.rows[0].observedCompression.savingsPct).toBe(0);
  });

  it("produces one row per group even when no events match", () => {
    const result = aggregateGroups([]);
    expect(result.rows.length).toBe(4); // All 4 groups present
    const keys = result.rows.map((r) => r.groupKey);
    expect(keys).toContain("observed_off_off");
    expect(keys).toContain("observed_caveman_only");
    expect(keys).toContain("observed_ponytail_only");
    expect(keys).toContain("observed_combined");
    // All zero
    for (const row of result.rows) {
      expect(row.sessionCount).toBe(0);
      expect(row.runCount).toBe(0);
    }
  });
});

// ===========================================================================
// 4. exportJson — deterministic JSON export
// ===========================================================================

describe("exportJson", () => {
  it("exports structured JSON with query metadata, diagnostics, rows, and exportVersion", () => {
    const result: AnalyticsResult = {
      query: { root: "/tmp/test", from: "2026-07-01", to: "2026-07-18" },
      diagnostics: { invalidDates: 0, symlinksSkipped: 0, nonRegularFilesSkipped: 0, malformedRecords: 0, duplicateEventIds: 0, totalFilesScanned: 5, totalSessionsScanned: 3, totalEventsScanned: 100 },
      rows: [
        {
          groupKey: "observed_off_off",
          sessionCount: 1,
          runCount: 2,
          turnCount: 3,
          toolCallCount: 10,
          toolErrorCount: 0,
          sessionDurationMs: 5000,
          runDurationMs: 3000,
          turnDurationMs: 0,
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 1500,
          cost: 0.01,
          observedCompression: {
            compressedCount: 1,
            skippedCount: 0,
            failedCount: 0,
            originalChars: 1000,
            finalChars: 200,
            savedBytes: 800,
            savingsPct: 80,
          },
        },
      ],
    };

    const json = exportJson(result);
    const parsed = JSON.parse(json);

    expect(parsed.exportVersion).toBe(1);
    expect(parsed.query.root).toBe("/tmp/test");
    expect(parsed.query.from).toBe("2026-07-01");
    expect(parsed.rows.length).toBe(1);
    expect(parsed.rows[0].groupKey).toBe("observed_off_off");
    expect(parsed.rows[0].sessionCount).toBe(1);
    expect(parsed.rows[0].observedCompression.savingsPct).toBe(80);
  });

  it("produces deterministic output (sorted keys with exportVersion)", () => {
    const result: AnalyticsResult = {
      query: { root: "/tmp/test" },
      diagnostics: { invalidDates: 0, symlinksSkipped: 0, nonRegularFilesSkipped: 0, malformedRecords: 0, duplicateEventIds: 0, totalFilesScanned: 0, totalSessionsScanned: 0, totalEventsScanned: 0 },
      rows: [],
    };
    const json1 = exportJson(result);
    const json2 = exportJson(result);
    expect(json1).toBe(json2);
    // Verify exportVersion is present
    const parsed = JSON.parse(json1);
    expect(parsed.exportVersion).toBe(1);
  });
});

// ===========================================================================
// 5. exportCsv — properly escaped CSV export
// ===========================================================================

describe("exportCsv", () => {
  it("exports CSV with header row", () => {
    const result: AnalyticsResult = {
      query: { root: "/tmp/test" },
      diagnostics: { invalidDates: 0, symlinksSkipped: 0, nonRegularFilesSkipped: 0, malformedRecords: 0, duplicateEventIds: 0, totalFilesScanned: 0, totalSessionsScanned: 0, totalEventsScanned: 0 },
      rows: [
        {
          groupKey: "observed_off_off",
          sessionCount: 1,
          runCount: 2,
          turnCount: 3,
          toolCallCount: 10,
          toolErrorCount: 0,
          sessionDurationMs: 5000,
          runDurationMs: 3000,
          turnDurationMs: 0,
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 1500,
          cost: 0.01,
          observedCompression: {
            compressedCount: 1,
            skippedCount: 0,
            failedCount: 0,
            originalChars: 1000,
            finalChars: 200,
            savedBytes: 800,
            savingsPct: 80,
          },
        },
      ],
    };

    const csv = exportCsv(result);
    const lines = csv.trim().split("\n");
    expect(lines.length).toBe(2); // header + 1 data row
    expect(lines[0]).toContain("groupKey");
    expect(lines[0]).toContain("sessionCount");
    expect(lines[1]).toContain("observed_off_off");
    expect(lines[1]).toContain("1");
  });

  it("escapes commas in field values", () => {
    const result: AnalyticsResult = {
      query: { root: "/tmp/test" },
      diagnostics: { invalidDates: 0, symlinksSkipped: 0, nonRegularFilesSkipped: 0, malformedRecords: 0, duplicateEventIds: 0, totalFilesScanned: 0, totalSessionsScanned: 0, totalEventsScanned: 0 },
      rows: [
        {
          groupKey: "observed_off_off",
          sessionCount: 1,
          runCount: 0, turnCount: 0, toolCallCount: 0, toolErrorCount: 0,
          sessionDurationMs: 0, runDurationMs: 0, turnDurationMs: 0,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0,
          observedCompression: { compressedCount: 0, skippedCount: 0, failedCount: 0, originalChars: 0, finalChars: 0, savedBytes: 0, savingsPct: 0 },
        },
      ],
    };
    const csv = exportCsv(result);
    // No commas within values here, just verify no extra quoting
    expect(csv).not.toContain('""');
  });

  it("handles empty rows gracefully", () => {
    const result: AnalyticsResult = {
      query: { root: "/tmp/test" },
      diagnostics: { invalidDates: 0, symlinksSkipped: 0, nonRegularFilesSkipped: 0, malformedRecords: 0, duplicateEventIds: 0, totalFilesScanned: 0, totalSessionsScanned: 0, totalEventsScanned: 0 },
      rows: [],
    };
    const csv = exportCsv(result);
    const lines = csv.trim().split("\n");
    expect(lines.length).toBe(1); // header only
  });

  it("produces deterministic column order", () => {
    const result: AnalyticsResult = {
      query: { root: "/tmp/test" },
      diagnostics: { invalidDates: 0, symlinksSkipped: 0, nonRegularFilesSkipped: 0, malformedRecords: 0, duplicateEventIds: 0, totalFilesScanned: 0, totalSessionsScanned: 0, totalEventsScanned: 0 },
      rows: [],
    };
    const csv1 = exportCsv(result);
    const csv2 = exportCsv(result);
    expect(csv1).toBe(csv2);
  });
});

// ===========================================================================
// 6. Integration — full scan + filter + aggregate pipeline
// ===========================================================================

describe("integration: scan → filter → aggregate", () => {
  it("end-to-end pipeline with real files", async () => {
    const root = await tempDir();

    const ts1 = "2026-07-18T10:00:00.000Z";
    const ts2 = "2026-07-18T10:30:00.000Z";

    const events: TelemetryEvent[] = [
      // Session A: off/off
      makeSessionStart({ sessionId: "sess-a", timestamp: ts1 }),
      makeTurnEnd({ sessionId: "sess-a", timestamp: ts1, runId: "run-a1", turnIndex: 0, toolCallCount: 2, usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.001 } }),
      makeSessionEnd({ sessionId: "sess-a", timestamp: ts1, durationMs: 1000, toolCallCount: 2 }),

      // Session B: caveman=full, ponytail=off
      makeSessionStart({ sessionId: "sess-b", timestamp: ts2 }),
      makeModeChange({ sessionId: "sess-b", timestamp: ts2, component: "caveman", previous: "off", next: "full" }),
      makeTurnEnd({ sessionId: "sess-b", timestamp: ts2, runId: "run-b1", turnIndex: 0, toolCallCount: 1, usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300, cost: 0.002 } }),
      makeFinalToolResult({ sessionId: "sess-b", timestamp: ts2, runId: "run-b1", turnIndex: 0, toolCallId: "tc-b1", toolName: "read_file", contentLength: 200, compressionDetails: { originalLength: 1000, compressedLength: 200, savedBytes: 800, savedPct: 80, kind: "compressed" } }),
      makeSessionEnd({ sessionId: "sess-b", timestamp: ts2, durationMs: 2000, toolCallCount: 1 }),
    ];

    await writeTelemetryFile(root, "2026-07-18", "sess-a", events.slice(0, 3));
    await writeTelemetryFile(root, "2026-07-18", "sess-b", events.slice(3));

    // Scan
    const scanResult = await scanTelemetryArchive({ root });
    expect(scanResult.records.length).toBe(8);

    // Filter + Annotate
    const fa = filterAndAnnotate(scanResult.records, {});
    expect(fa.annotated.length).toBe(8);

    // Aggregate
    const ag = aggregateGroups(fa.annotated);

    // off/off group: sess-a (turn_end + session_end) and sess-b session_start (admin-only, not measured)
    // sess-a is measured (has turn_end), sess-b session_start alone is admin → not counted
    const offOff = ag.rows.find((r) => r.groupKey === "observed_off_off")!;
    expect(offOff.sessionCount).toBe(1); // only sess-a has measured events
    expect(offOff.turnCount).toBe(1); // only sess-a turn_end
    expect(offOff.toolCallCount).toBe(2);
    expect(offOff.inputTokens).toBe(100);

    // caveman-only group (sess-b after mode_change)
    const cmOnly = ag.rows.find((r) => r.groupKey === "observed_caveman_only")!;
    expect(cmOnly.sessionCount).toBe(1);
    expect(cmOnly.turnCount).toBe(1);
    expect(cmOnly.observedCompression.compressedCount).toBe(1);
    expect(cmOnly.observedCompression.savedBytes).toBe(800);
  });
});

// ===========================================================================
// 7. Defect regression tests (RED → GREEN)
// ===========================================================================

describe("defect: toolErrorCount double-count (raw + final same toolCallId)", () => {
  it("counts error once when raw_tool_result and final_tool_result share toolCallId with isError", () => {
    const ts = "2026-07-18T10:00:00.000Z";
    const annotated: AnnotatedEvent[] = [
      {
        event: makeEvent({
          event: "raw_tool_result",
          sessionId: "sess-a",
          runId: "run-1",
          turnIndex: 0,
          toolCallId: "tc-err-1",
          toolName: "read_file",
          contentLength: 500,
          isError: true,
          timestamp: ts,
        }),
        cavemanMode: "off", ponytailMode: "off", experimentTag: undefined,
        sessionId: "sess-a", runId: "run-1", turnIndex: 0,
        provider: undefined, model: undefined, project: undefined,
        thinkingLevel: undefined,
      },
      {
        event: makeEvent({
          event: "final_tool_result",
          sessionId: "sess-a",
          runId: "run-1",
          turnIndex: 0,
          toolCallId: "tc-err-1",
          toolName: "read_file",
          contentLength: 120,
          isError: true,
          timestamp: ts,
        }),
        cavemanMode: "off", ponytailMode: "off", experimentTag: undefined,
        sessionId: "sess-a", runId: "run-1", turnIndex: 0,
        provider: undefined, model: undefined, project: undefined,
        thinkingLevel: undefined,
      },
    ];
    const result = aggregateGroups(annotated);
    // Should be 1, not 2
    expect(result.rows[0].toolErrorCount).toBe(1);
  });

  it("counts errors independently for different toolCallIds", () => {
    const ts = "2026-07-18T10:00:00.000Z";
    const annotated: AnnotatedEvent[] = [
      {
        event: makeEvent({
          event: "final_tool_result",
          sessionId: "sess-a", runId: "run-1", turnIndex: 0,
          toolCallId: "tc-err-A", toolName: "read_file",
          contentLength: 100, isError: true, timestamp: ts,
        }),
        cavemanMode: "off", ponytailMode: "off", experimentTag: undefined,
        sessionId: "sess-a", runId: "run-1", turnIndex: 0,
        provider: undefined, model: undefined, project: undefined,
        thinkingLevel: undefined,
      },
      {
        event: makeEvent({
          event: "final_tool_result",
          sessionId: "sess-a", runId: "run-1", turnIndex: 0,
          toolCallId: "tc-err-B", toolName: "grep",
          contentLength: 50, isError: true, timestamp: ts,
        }),
        cavemanMode: "off", ponytailMode: "off", experimentTag: undefined,
        sessionId: "sess-a", runId: "run-1", turnIndex: 0,
        provider: undefined, model: undefined, project: undefined,
        thinkingLevel: undefined,
      },
    ];
    const result = aggregateGroups(annotated);
    expect(result.rows[0].toolErrorCount).toBe(2);
  });
});

describe("defect: non-regular file scan (FIFO/device)", () => {
  it("skips non-regular .jsonl files (FIFO) without blocking", async () => {
    const root = await tempDir();
    const dateDir = join(root, "2026-07-18");
    await mkdir(dateDir, { recursive: true });
    // Valid JSONL file
    const evt = makeSessionStart({ sessionId: "sess-ok" });
    await writeTelemetryFile(root, "2026-07-18", "sess-ok", [evt]);
    // Create a FIFO (named pipe) that looks like a .jsonl file
    const fifoPath = join(dateDir, "fifo.jsonl");
    await new Promise<void>((resolve, reject) => {
      const { spawn } = require("node:child_process");
      const mkfifo = spawn("mkfifo", [fifoPath]);
      mkfifo.on("close", (code: number) => {
        if (code === 0) resolve();
        else reject(new Error(`mkfifo failed with code ${code}`));
      });
      mkfifo.on("error", reject);
    });

    const result = await scanTelemetryArchive({ root });
    // Should NOT block; should read only the valid file
    expect(result.records.length).toBe(1);
    expect(result.records[0].sessionId).toBe("sess-ok");
  });
});

describe("defect: sessionCount polluted by admin-only sessions", () => {
  it("excludes session with only session_start + mode_change + experiment_tag from sessionCount", () => {
    const ts = "2026-07-18T10:00:00.000Z";
    const annotated: AnnotatedEvent[] = [
      // Session A: admin events only (session_start, mode_change, experiment_tag)
      {
        event: makeSessionStart({ sessionId: "sess-admin", timestamp: ts }),
        cavemanMode: "off", ponytailMode: "off", experimentTag: undefined,
        sessionId: "sess-admin", runId: undefined, turnIndex: undefined,
        provider: undefined, model: undefined, project: undefined,
        thinkingLevel: undefined,
      },
      {
        event: makeModeChange({ sessionId: "sess-admin", component: "caveman", previous: "off", next: "full", timestamp: ts }),
        cavemanMode: "full", ponytailMode: "off", experimentTag: undefined,
        sessionId: "sess-admin", runId: undefined, turnIndex: undefined,
        provider: undefined, model: undefined, project: undefined,
        thinkingLevel: undefined,
      },
      {
        event: makeExperimentTag({ sessionId: "sess-admin", tag: "baseline", timestamp: ts }),
        cavemanMode: "full", ponytailMode: "off", experimentTag: "baseline",
        sessionId: "sess-admin", runId: undefined, turnIndex: undefined,
        provider: undefined, model: undefined, project: undefined,
        thinkingLevel: undefined,
      },
      // Session B: measured session
      {
        event: makeTurnEnd({ sessionId: "sess-measured", timestamp: ts }),
        cavemanMode: "off", ponytailMode: "off", experimentTag: undefined,
        sessionId: "sess-measured", runId: "run-1", turnIndex: 0,
        provider: undefined, model: undefined, project: undefined,
        thinkingLevel: undefined,
      },
    ];
    const result = aggregateGroups(annotated);
    const offOff = result.rows.find((r) => r.groupKey === "observed_off_off")!;
    // Only sess-measured should count (sess-admin had no measurement events)
    expect(offOff.sessionCount).toBe(1);
  });

  it("counts session that has at least one turn_end as measured", () => {
    const ts = "2026-07-18T10:00:00.000Z";
    const annotated: AnnotatedEvent[] = [
      {
        event: makeSessionStart({ sessionId: "sess-hybrid", timestamp: ts }),
        cavemanMode: "off", ponytailMode: "off", experimentTag: undefined,
        sessionId: "sess-hybrid", runId: undefined, turnIndex: undefined,
        provider: undefined, model: undefined, project: undefined,
        thinkingLevel: undefined,
      },
      {
        event: makeModeChange({ sessionId: "sess-hybrid", component: "caveman", previous: "off", next: "full", timestamp: ts }),
        cavemanMode: "full", ponytailMode: "off", experimentTag: undefined,
        sessionId: "sess-hybrid", runId: undefined, turnIndex: undefined,
        provider: undefined, model: undefined, project: undefined,
        thinkingLevel: undefined,
      },
      {
        event: makeTurnEnd({ sessionId: "sess-hybrid", timestamp: ts }),
        cavemanMode: "full", ponytailMode: "off", experimentTag: undefined,
        sessionId: "sess-hybrid", runId: "run-1", turnIndex: 0,
        provider: undefined, model: undefined, project: undefined,
        thinkingLevel: undefined,
      },
    ];
    const result = aggregateGroups(annotated);
    const cmOnly = result.rows.find((r) => r.groupKey === "observed_caveman_only")!;
    expect(cmOnly.sessionCount).toBe(1);
  });
});

describe("defect: from/to validation missing", () => {
  it("rejects invalid from date (bad month)", async () => {
    const root = await tempDir();
    await expect(
      scanTelemetryArchive({ root, from: "2026-13-01" }),
    ).rejects.toThrow(/from.*valid/i);
  });

  it("rejects invalid to date (bad day)", async () => {
    const root = await tempDir();
    await expect(
      scanTelemetryArchive({ root, to: "2026-02-30" }),
    ).rejects.toThrow(/to.*valid/i);
  });

  it("rejects reversed date range (from > to)", async () => {
    const root = await tempDir();
    await expect(
      scanTelemetryArchive({ root, from: "2026-07-18", to: "2026-07-17" }),
    ).rejects.toThrow(/from.*after.*to|range/i);
  });

  it("accepts valid from/to range", async () => {
    const root = await tempDir();
    const evt = makeSessionStart({ sessionId: "sess-a" });
    await writeTelemetryFile(root, "2026-07-18", "sess-a", [evt]);
    const result = await scanTelemetryArchive({ root, from: "2026-07-17", to: "2026-07-19" });
    expect(result.records.length).toBe(1);
  });
});

describe("defect: exportJson not truly sorted and not versioned", () => {
  it("includes exportVersion in JSON output", () => {
    const result: AnalyticsResult = {
      query: { root: "/tmp/test" },
      diagnostics: { invalidDates: 0, symlinksSkipped: 0, nonRegularFilesSkipped: 0, malformedRecords: 0, duplicateEventIds: 0, totalFilesScanned: 0, totalSessionsScanned: 0, totalEventsScanned: 0 },
      rows: [],
    };
    const json = exportJson(result);
    const parsed = JSON.parse(json);
    expect(parsed.exportVersion).toBe(1);
  });

  it("produces sorted keys (deterministic output verified by parsing)", () => {
    const result: AnalyticsResult = {
      query: { root: "/tmp/test", from: "2026-07-01" },
      diagnostics: { invalidDates: 0, symlinksSkipped: 0, nonRegularFilesSkipped: 0, malformedRecords: 0, duplicateEventIds: 0, totalFilesScanned: 5, totalSessionsScanned: 3, totalEventsScanned: 100 },
      rows: [
        {
          groupKey: "observed_off_off",
          sessionCount: 1, runCount: 2, turnCount: 3,
          toolCallCount: 10, toolErrorCount: 0,
          sessionDurationMs: 5000, runDurationMs: 3000, turnDurationMs: 0,
          inputTokens: 1000, outputTokens: 500,
          cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1500, cost: 0.01,
          observedCompression: {
            compressedCount: 1, skippedCount: 0, failedCount: 0,
            originalChars: 1000, finalChars: 200, savedBytes: 800, savingsPct: 80,
          },
        },
      ],
    };
    const json1 = exportJson(result);
    const json2 = exportJson(result);
    // Same input → same exact bytes
    expect(json1).toBe(json2);

    // Verify keys appear in sorted order in the output (exportVersion first, then sorted)
    const parsed = JSON.parse(json1);
    const topKeys = Object.keys(parsed);
    expect(topKeys).toEqual([
      "exportVersion",
      "diagnostics",
      "query",
      "rows",
    ]);
    // Verify row keys are sorted too
    if (parsed.rows.length > 0) {
      const rowKeys = Object.keys(parsed.rows[0]);
      const sortedRowKeys = [...rowKeys].sort();
      expect(rowKeys).toEqual(sortedRowKeys);
    }
  });
});

// ===========================================================================
// 8. Lot 4A: Runtime context reconstruction in filterAndAnnotate
// ===========================================================================

describe("runtime context inheritance for tool events", () => {
  it("tool events inherit provider/model/project from session_start", () => {
    const records: TelemetryEvent[] = [
      makeSessionStart({
        timestamp: "2026-07-18T10:00:00.000Z",
        sessionId: "sess-a",
        provider: "openai",
        model: "gpt-4",
        project: "/home/test",
      }),
      makeTurnEnd({ timestamp: "2026-07-18T10:01:00.000Z", sessionId: "sess-a" }),
      makeFinalToolResult({
        timestamp: "2026-07-18T10:01:30.000Z",
        sessionId: "sess-a",
        toolCallId: "tc-1",
        runId: "run-1",
        turnIndex: 0,
      }),
    ];
    const result = filterAndAnnotate(records, {});
    expect(result.annotated.length).toBe(3);
    for (const ae of result.annotated) {
      expect(ae.provider).toBe("openai");
      expect(ae.model).toBe("gpt-4");
      expect(ae.project).toBe("/home/test");
    }
  });

  it("filter provider=openai conserves tool result and compression events", () => {
    const records: TelemetryEvent[] = [
      makeSessionStart({
        timestamp: "2026-07-18T10:00:00.000Z",
        sessionId: "sess-a",
        provider: "openai",
        model: "gpt-4",
      }),
      makeTurnEnd({ timestamp: "2026-07-18T10:01:00.000Z", sessionId: "sess-a" }),
      makeFinalToolResult({
        timestamp: "2026-07-18T10:01:30.000Z",
        sessionId: "sess-a",
        toolCallId: "tc-1",
        runId: "run-1",
        turnIndex: 0,
        contentLength: 200,
        compressionDetails: {
          originalLength: 1000,
          compressedLength: 200,
          savedBytes: 800,
          savedPct: 80,
          kind: "compressed",
        },
      }),
    ];
    const result = filterAndAnnotate(records, { provider: "openai" });
    // All 3 events should pass the provider filter
    expect(result.annotated.length).toBe(3);
    // Verify final_tool_result is present
    const ftr = result.annotated.find(
      (ae) => ae.event.event === "final_tool_result",
    )!;
    expect(ftr).toBeDefined();
    expect(ftr.provider).toBe("openai");
  });

  it("model change mid-session: old events keep old model, new get new", () => {
    const records: TelemetryEvent[] = [
      makeSessionStart({
        timestamp: "2026-07-18T10:00:00.000Z",
        sessionId: "sess-a",
        provider: "openai",
        model: "gpt-4",
      }),
      makeTurnEnd({ timestamp: "2026-07-18T10:01:00.000Z", sessionId: "sess-a" }),
      // Second agent run with different model
      makeEvent({
        event: "agent_run_start",
        timestamp: "2026-07-18T10:02:00.000Z",
        sessionId: "sess-a",
        runId: "run-2",
        provider: "openai",
        model: "gpt-4o",
      }),
      makeTurnEnd({ timestamp: "2026-07-18T10:03:00.000Z", sessionId: "sess-a" }),
    ];
    const result = filterAndAnnotate(records, {});
    expect(result.annotated.length).toBe(4);
    // First two events keep gpt-4
    expect(result.annotated[0].model).toBe("gpt-4"); // session_start
    expect(result.annotated[1].model).toBe("gpt-4"); // first turn_end
    // After model change, subsequent events see gpt-4o
    expect(result.annotated[2].model).toBe("gpt-4o"); // agent_run_start
    expect(result.annotated[3].model).toBe("gpt-4o"); // second turn_end
  });

  it("project inherited on tool result from cwd field", () => {
    const records: TelemetryEvent[] = [
      makeSessionStart({
        timestamp: "2026-07-18T10:00:00.000Z",
        sessionId: "sess-a",
        cwd: "/home/proj-a",
      }),
      makeFinalToolResult({
        timestamp: "2026-07-18T10:01:00.000Z",
        sessionId: "sess-a",
        toolCallId: "tc-1",
        runId: "run-1",
        turnIndex: 0,
      }),
    ];
    const result = filterAndAnnotate(records, {});
    expect(result.annotated.length).toBe(2);
    expect(result.annotated[1].project).toBe("/home/proj-a");
  });

  it("thinkingLevel is tracked on AnnotatedEvent", () => {
    const records: TelemetryEvent[] = [
      makeSessionStart({
        timestamp: "2026-07-18T10:00:00.000Z",
        sessionId: "sess-a",
        thinkingLevel: "high",
      }),
      makeTurnEnd({ timestamp: "2026-07-18T10:01:00.000Z", sessionId: "sess-a" }),
    ];
    const result = filterAndAnnotate(records, {});
    expect(result.annotated.length).toBe(2);
    expect(result.annotated[0].thinkingLevel).toBe("high");
    expect(result.annotated[1].thinkingLevel).toBe("high");
  });

  it("filter by thinkingLevel", () => {
    const records: TelemetryEvent[] = [
      makeSessionStart({
        timestamp: "2026-07-18T10:00:00.000Z",
        sessionId: "sess-a",
        thinkingLevel: "high",
      }),
      makeTurnEnd({ timestamp: "2026-07-18T10:01:00.000Z", sessionId: "sess-a" }),
      makeSessionStart({
        timestamp: "2026-07-18T10:02:00.000Z",
        sessionId: "sess-b",
        thinkingLevel: "low",
      }),
      makeTurnEnd({ timestamp: "2026-07-18T10:03:00.000Z", sessionId: "sess-b" }),
    ];
    const result = filterAndAnnotate(records, { thinkingLevel: "high" });
    expect(result.annotated.length).toBe(2);
    expect(result.annotated[0].sessionId).toBe("sess-a");
    expect(result.annotated[1].sessionId).toBe("sess-a");
  });

  it("runtime context resets per session (no leak)", () => {
    const records: TelemetryEvent[] = [
      makeSessionStart({
        timestamp: "2026-07-18T10:00:00.000Z",
        sessionId: "sess-a",
        provider: "openai",
      }),
      makeSessionStart({
        timestamp: "2026-07-18T10:01:00.000Z",
        sessionId: "sess-b",
      }),
      makeTurnEnd({ timestamp: "2026-07-18T10:02:00.000Z", sessionId: "sess-b" }),
    ];
    const result = filterAndAnnotate(records, {});
    expect(result.annotated.length).toBe(3);
    // sess-b events should have undefined provider (no provider set for sess-b)
    expect(result.annotated[1].provider).toBeUndefined();
    expect(result.annotated[2].provider).toBeUndefined();
    // sess-a should have openai
    expect(result.annotated[0].provider).toBe("openai");
  });

  it("provider field not overwritten when event omits it", () => {
    // session_start sets provider. Turn_start without provider should keep it.
    const records: TelemetryEvent[] = [
      makeSessionStart({
        timestamp: "2026-07-18T10:00:00.000Z",
        sessionId: "sess-a",
        provider: "openai",
      }),
      // turn_start without provider should not overwrite
      makeEvent({
        event: "turn_start",
        timestamp: "2026-07-18T10:01:00.000Z",
        sessionId: "sess-a",
        runId: "run-1",
        turnIndex: 0,
      }),
      makeFinalToolResult({
        timestamp: "2026-07-18T10:01:30.000Z",
        sessionId: "sess-a",
        toolCallId: "tc-1",
        runId: "run-1",
        turnIndex: 0,
      }),
    ];
    const result = filterAndAnnotate(records, { provider: "openai" });
    expect(result.annotated.length).toBe(3);
  });
});

// ===========================================================================
// 9. Lot 4A: Error dedup composite (sessionId:toolCallId)
// ===========================================================================

describe("error dedup: composite sessionId:toolCallId", () => {
  it("same toolCallId in different sessions counted as separate errors", () => {
    const ts = "2026-07-18T10:00:00.000Z";
    const annotated: AnnotatedEvent[] = [
      {
        event: makeEvent({
          event: "final_tool_result",
          sessionId: "sess-a",
          runId: "run-1",
          turnIndex: 0,
          toolCallId: "tc-shared",
          toolName: "read",
          contentLength: 100,
          isError: true,
          timestamp: ts,
        }),
        cavemanMode: "off",
        ponytailMode: "off",
        experimentTag: undefined,
        sessionId: "sess-a",
        runId: "run-1",
        turnIndex: 0,
        provider: undefined,
        model: undefined,
        project: undefined,
        thinkingLevel: undefined,
      },
      {
        event: makeEvent({
          event: "final_tool_result",
          sessionId: "sess-b",
          runId: "run-2",
          turnIndex: 0,
          toolCallId: "tc-shared",
          toolName: "read",
          contentLength: 100,
          isError: true,
          timestamp: ts,
        }),
        cavemanMode: "off",
        ponytailMode: "off",
        experimentTag: undefined,
        sessionId: "sess-b",
        runId: "run-2",
        turnIndex: 0,
        provider: undefined,
        model: undefined,
        project: undefined,
        thinkingLevel: undefined,
      },
    ];
    const result = aggregateGroups(annotated);
    // Both counted separately (different sessions)
    expect(result.rows[0].toolErrorCount).toBe(2);
  });

  it("same toolCallId in same session still deduplicated", () => {
    const ts = "2026-07-18T10:00:00.000Z";
    const annotated: AnnotatedEvent[] = [
      {
        event: makeEvent({
          event: "raw_tool_result",
          sessionId: "sess-a",
          runId: "run-1",
          turnIndex: 0,
          toolCallId: "tc-err-1",
          toolName: "read_file",
          contentLength: 500,
          isError: true,
          timestamp: ts,
        }),
        cavemanMode: "off",
        ponytailMode: "off",
        experimentTag: undefined,
        sessionId: "sess-a",
        runId: "run-1",
        turnIndex: 0,
        provider: undefined,
        model: undefined,
        project: undefined,
        thinkingLevel: undefined,
      },
      {
        event: makeEvent({
          event: "final_tool_result",
          sessionId: "sess-a",
          runId: "run-1",
          turnIndex: 0,
          toolCallId: "tc-err-1",
          toolName: "read_file",
          contentLength: 120,
          isError: true,
          timestamp: ts,
        }),
        cavemanMode: "off",
        ponytailMode: "off",
        experimentTag: undefined,
        sessionId: "sess-a",
        runId: "run-1",
        turnIndex: 0,
        provider: undefined,
        model: undefined,
        project: undefined,
        thinkingLevel: undefined,
      },
    ];
    const result = aggregateGroups(annotated);
    // Same session + same toolCallId → deduplicated → 1
    expect(result.rows[0].toolErrorCount).toBe(1);
  });
});

// ===========================================================================
// 10. Lot 4A: turnDurationMs aggregation
// ===========================================================================

describe("turnDurationMs aggregation", () => {
  it("turnDurationMs sums durationMs from turn_end events", () => {
    const ts = "2026-07-18T10:00:00.000Z";
    const annotated: AnnotatedEvent[] = [
      {
        event: makeTurnEnd({
          sessionId: "sess-a",
          durationMs: 1500,
          timestamp: ts,
        }),
        cavemanMode: "off",
        ponytailMode: "off",
        experimentTag: undefined,
        sessionId: "sess-a",
        runId: "run-1",
        turnIndex: 0,
        provider: undefined,
        model: undefined,
        project: undefined,
        thinkingLevel: undefined,
      },
      {
        event: makeTurnEnd({
          sessionId: "sess-a",
          durationMs: 2500,
          timestamp: ts,
        }),
        cavemanMode: "off",
        ponytailMode: "off",
        experimentTag: undefined,
        sessionId: "sess-a",
        runId: "run-1",
        turnIndex: 1,
        provider: undefined,
        model: undefined,
        project: undefined,
        thinkingLevel: undefined,
      },
    ];
    const result = aggregateGroups(annotated);
    expect(result.rows[0].turnDurationMs).toBe(4000);
  });

  it("turn_end without durationMs does not contribute", () => {
    const ts = "2026-07-18T10:00:00.000Z";
    const annotated: AnnotatedEvent[] = [
      {
        event: makeTurnEnd({ sessionId: "sess-a", timestamp: ts }),
        cavemanMode: "off",
        ponytailMode: "off",
        experimentTag: undefined,
        sessionId: "sess-a",
        runId: "run-1",
        turnIndex: 0,
        provider: undefined,
        model: undefined,
        project: undefined,
        thinkingLevel: undefined,
      },
    ];
    const result = aggregateGroups(annotated);
    expect(result.rows[0].turnDurationMs).toBe(0);
  });

  it("CSV includes turnDurationMs column and value", () => {
    const result: AnalyticsResult = {
      query: { root: "/tmp/test" },
      diagnostics: {
        invalidDates: 0,
        symlinksSkipped: 0,
        nonRegularFilesSkipped: 0,
        malformedRecords: 0,
        duplicateEventIds: 0,
        totalFilesScanned: 0,
        totalSessionsScanned: 0,
        totalEventsScanned: 0,
      },
      rows: [
        {
          groupKey: "observed_off_off",
          sessionCount: 1,
          runCount: 2,
          turnCount: 3,
          toolCallCount: 10,
          toolErrorCount: 0,
          sessionDurationMs: 5000,
          runDurationMs: 3000,
          turnDurationMs: 1200,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 150,
          cost: 0.001,
          observedCompression: {
            compressedCount: 0,
            skippedCount: 0,
            failedCount: 0,
            originalChars: 0,
            finalChars: 0,
            savedBytes: 0,
            savingsPct: 0,
          },
        },
      ],
    };
    const csv = exportCsv(result);
    expect(csv).toContain("turnDurationMs");
    expect(csv).toContain("1200");
  });

  it("JSON includes turnDurationMs in row", () => {
    const result: AnalyticsResult = {
      query: { root: "/tmp/test" },
      diagnostics: {
        invalidDates: 0,
        symlinksSkipped: 0,
        nonRegularFilesSkipped: 0,
        malformedRecords: 0,
        duplicateEventIds: 0,
        totalFilesScanned: 0,
        totalSessionsScanned: 0,
        totalEventsScanned: 0,
      },
      rows: [
        {
          groupKey: "observed_off_off",
          sessionCount: 1,
          runCount: 2,
          turnCount: 3,
          toolCallCount: 10,
          toolErrorCount: 0,
          sessionDurationMs: 5000,
          runDurationMs: 3000,
          turnDurationMs: 1200,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 150,
          cost: 0.001,
          observedCompression: {
            compressedCount: 0,
            skippedCount: 0,
            failedCount: 0,
            originalChars: 0,
            finalChars: 0,
            savedBytes: 0,
            savingsPct: 0,
          },
        },
      ],
    };
    const json = exportJson(result);
    expect(json).toContain("turnDurationMs");
    const parsed = JSON.parse(json);
    expect(parsed.rows[0].turnDurationMs).toBe(1200);
  });
});

// ===========================================================================
// 11. Lot 4A: Integration — provider filter preserves compression + model change
// ===========================================================================

describe("integration: provider filter preserves compression in aggregate", () => {
  it("filter provider=openai keeps compression events counted", async () => {
    const root = await tempDir();
    const ts = "2026-07-18T10:00:00.000Z";

    const events: TelemetryEvent[] = [
      makeSessionStart({
        sessionId: "sess-a",
        timestamp: ts,
        provider: "openai",
        model: "gpt-4",
      }),
      makeTurnEnd({
        sessionId: "sess-a",
        timestamp: ts,
        runId: "run-1",
        turnIndex: 0,
        toolCallCount: 1,
      }),
      makeFinalToolResult({
        sessionId: "sess-a",
        timestamp: ts,
        runId: "run-1",
        turnIndex: 0,
        toolCallId: "tc-1",
        toolName: "read_file",
        contentLength: 200,
        compressionDetails: {
          originalLength: 1000,
          compressedLength: 200,
          savedBytes: 800,
          savedPct: 80,
          kind: "compressed",
        },
      }),
    ];

    await writeTelemetryFile(root, "2026-07-18", "sess-a", events);

    const scanResult = await scanTelemetryArchive({ root });
    const fa = filterAndAnnotate(scanResult.records, { provider: "openai" });

    // All 3 events should pass provider filter (tool result inherits provider)
    expect(fa.annotated.length).toBe(3);

    const ag = aggregateGroups(fa.annotated);
    // Compression should be counted
    expect(ag.rows[0].observedCompression.compressedCount).toBe(1);
    expect(ag.rows[0].observedCompression.savedBytes).toBe(800);
  });
});

describe("integration: model change mid-session in aggregate", () => {
  it("aggregate splits turns correctly after model change", async () => {
    const root = await tempDir();
    const ts1 = "2026-07-18T10:00:00.000Z";
    const ts2 = "2026-07-18T10:02:00.000Z";

    const events: TelemetryEvent[] = [
      makeSessionStart({
        sessionId: "sess-a",
        timestamp: ts1,
        provider: "openai",
        model: "gpt-4",
      }),
      makeTurnEnd({
        sessionId: "sess-a",
        timestamp: ts1,
        runId: "run-1",
        turnIndex: 0,
        toolCallCount: 2,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          cost: 0.001,
        },
      }),
      // Model change via agent_run_start
      makeEvent({
        event: "agent_run_start",
        timestamp: ts2,
        sessionId: "sess-a",
        runId: "run-2",
        provider: "openai",
        model: "gpt-4o",
      }),
      makeTurnEnd({
        sessionId: "sess-a",
        timestamp: ts2,
        runId: "run-2",
        turnIndex: 0,
        toolCallCount: 3,
        usage: {
          inputTokens: 200,
          outputTokens: 100,
          totalTokens: 300,
          cost: 0.002,
        },
      }),
    ];

    await writeTelemetryFile(root, "2026-07-18", "sess-a", events);

    const scanResult = await scanTelemetryArchive({ root });

    // Filter by model=gpt-4 → only first two events
    const faGpt4 = filterAndAnnotate(scanResult.records, { model: "gpt-4" });
    expect(faGpt4.annotated.length).toBe(2);
    expect(faGpt4.annotated[0].model).toBe("gpt-4");
    expect(faGpt4.annotated[1].model).toBe("gpt-4");

    // Filter by model=gpt-4o → only last two events
    const faGpt4o = filterAndAnnotate(scanResult.records, { model: "gpt-4o" });
    expect(faGpt4o.annotated.length).toBe(2);
    expect(faGpt4o.annotated[0].model).toBe("gpt-4o");
    expect(faGpt4o.annotated[1].model).toBe("gpt-4o");

    // Aggregate gpt-4
    const agGpt4 = aggregateGroups(faGpt4.annotated);
    expect(agGpt4.rows[0].turnCount).toBe(1);
    expect(agGpt4.rows[0].toolCallCount).toBe(2);
    expect(agGpt4.rows[0].totalTokens).toBe(150);

    // Aggregate gpt-4o
    const agGpt4o = aggregateGroups(faGpt4o.annotated);
    expect(agGpt4o.rows[0].turnCount).toBe(1);
    expect(agGpt4o.rows[0].toolCallCount).toBe(3);
    expect(agGpt4o.rows[0].totalTokens).toBe(300);
  });
});
