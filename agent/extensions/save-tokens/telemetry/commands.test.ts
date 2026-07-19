/**
 * Tests for telemetry commands (save-tokens-experiment, stats, export).
 *
 * Covers:
 * - parseArgs key=value parsing
 * - validateTag pattern validation
 * - Experiment command: valid tag writes, invalid rejected, error notified
 * - Stats command: real scan/filter/aggregate on tmp JSONL archive
 * - Export command: real JSON/CSV file writing, permissions, anti-overwrite
 * - Command error handling (catch → notify)
 * - Wiring: three commands registered once
 */

import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

// ---------------------------------------------------------------------------
// Mocks — must precede static imports that transitively load '../config'
// ---------------------------------------------------------------------------

let mockConfigDir = "/tmp/save-tokens-telemetry-nonexistent";

mock.module("../config", () => ({
    loadTelemetryConfig: mock(() => ({ enabled: true, directory: mockConfigDir })),
}));

// ---------------------------------------------------------------------------
// Imports — test the real module (mock.module already set up)
// ---------------------------------------------------------------------------

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
    parseArgs,
    validateTag,
    TAG_PATTERN,
    MAX_TAG_LENGTH,
    resolveExportPath,
    writeExportFile,
} from "./commands";
import { registerTelemetryCommands } from "./commands";
import type { TelemetryController } from "./controller";

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

type TagImpl = TelemetryController["tag"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockPi() {
    const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
    return {
        registerCommand: mock((name: string, def: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
            commands.set(name, def);
        }),
        _getCommand: (name: string) => commands.get(name),
        _commandNames: () => Array.from(commands.keys()),
    } as unknown as ExtensionAPI & {
        registerCommand: ReturnType<typeof mock>;
        _getCommand: (name: string) => { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> } | undefined;
        _commandNames: () => string[];
    };
}

function makeMockCtx(overrides: Partial<ExtensionCommandContext> = {}): ExtensionCommandContext {
    return {
        cwd: "/test",
        ui: {
            notify: mock(() => {}),
        },
        sessionManager: { getEntries: () => ([]) },
        getSystemPrompt: () => "",
        getContextUsage: () => ({ tokens: 0, contextWindow: 100000 }),
        ...overrides,
    } as unknown as ExtensionCommandContext;
}

function makeMockTelemetry(tagImpl?: TagImpl): TelemetryController {
    return {
        before: mock(() => {}),
        after: mock(() => {}),
        tag: mock(tagImpl ?? (() => Promise.resolve(true))),
    };
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
    it("parses key=value pairs", () => {
        const result = parseArgs("provider=anthropic model=claude-sonnet");
        expect(result.ok).toBe(true);
        expect(result.parsed!.provider).toBe("anthropic");
        expect(result.parsed!.model).toBe("claude-sonnet");
    });

    it("returns empty object for empty string", () => {
        const result = parseArgs("");
        expect(result.ok).toBe(true);
        expect(Object.keys(result.parsed!).length).toBe(0);
    });

    it("returns empty object for whitespace-only string", () => {
        const result = parseArgs("   ");
        expect(result.ok).toBe(true);
        expect(Object.keys(result.parsed!).length).toBe(0);
    });

    it("rejects unknown keys", () => {
        const result = parseArgs("provider=anthropic unknown_key=value");
        expect(result.ok).toBe(false);
        expect(result.error).toContain("unknown_key");
    });

    it("rejects duplicate keys", () => {
        const result = parseArgs("provider=a provider=b");
        expect(result.ok).toBe(false);
        expect(result.error).toContain("provider");
    });

    it("rejects empty values (key=)", () => {
        const result = parseArgs("provider=");
        expect(result.ok).toBe(false);
        expect(result.error!.toLowerCase()).toContain("empty");
    });

    it("rejects missing = (bare word)", () => {
        const result = parseArgs("provider");
        expect(result.ok).toBe(false);
        expect(result.error).toContain("=");
    });

    it("trims whitespace around keys and values", () => {
        const result = parseArgs("  provider = anthropic  ");
        expect(result.ok).toBe(true);
        expect(result.parsed!.provider).toBe("anthropic");
    });

    it("accepts valid keys: from, to, tag, provider, model, project, thinking, caveman, ponytail, format, out", () => {
        const result = parseArgs("from=2026-01-01 to=2026-06-01 tag=baseline provider=openai model=gpt-5 project=myapp thinking=high caveman=full ponytail=ultra format=csv out=/tmp/export.csv");
        expect(result.ok).toBe(true);
        expect(result.parsed!.from).toBe("2026-01-01");
        expect(result.parsed!.to).toBe("2026-06-01");
        expect(result.parsed!.tag).toBe("baseline");
        expect(result.parsed!.provider).toBe("openai");
        expect(result.parsed!.model).toBe("gpt-5");
        expect(result.parsed!.project).toBe("myapp");
        expect(result.parsed!.thinking).toBe("high");
        expect(result.parsed!.caveman).toBe("full");
        expect(result.parsed!.ponytail).toBe("ultra");
        expect(result.parsed!.format).toBe("csv");
        expect(result.parsed!.out).toBe("/tmp/export.csv");
    });

    it("handles values containing = (e.g., out=/path/with=equals)", () => {
        const result = parseArgs("out=/tmp/file=name.csv");
        expect(result.ok).toBe(true);
        expect(result.parsed!.out).toBe("/tmp/file=name.csv");
    });
});

// ---------------------------------------------------------------------------
// validateTag
// ---------------------------------------------------------------------------

describe("validateTag", () => {
    it("accepts valid ASCII tags", () => {
        expect(validateTag("baseline")).toBe(true);
        expect(validateTag("my_experiment")).toBe(true);
        expect(validateTag("test-123")).toBe(true);
        expect(validateTag("v1.0.0")).toBe(true);
        expect(validateTag("A_B_C")).toBe(true);
    });

    it("rejects empty tag", () => {
        expect(validateTag("")).toBe(false);
    });

    it("rejects tags exceeding max length", () => {
        const long = "a".repeat(MAX_TAG_LENGTH + 1);
        expect(validateTag(long)).toBe(false);
    });

    it("rejects tags with spaces", () => {
        expect(validateTag("my tag")).toBe(false);
    });

    it("rejects tags with special chars", () => {
        expect(validateTag("tag!")).toBe(false);
        expect(validateTag("tag@test")).toBe(false);
        expect(validateTag("tag#1")).toBe(false);
        expect(validateTag("tag$")).toBe(false);
        expect(validateTag("tag%")).toBe(false);
        expect(validateTag("tag/test")).toBe(false);
    });

    it("rejects tags with unicode", () => {
        expect(validateTag("taggé")).toBe(false);
        expect(validateTag("タグ")).toBe(false);
    });

    it("accepts tag at max length", () => {
        const max = "a".repeat(MAX_TAG_LENGTH);
        expect(validateTag(max)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// registerTelemetryCommands — wiring
// ---------------------------------------------------------------------------

describe("registerTelemetryCommands — wiring", () => {
    it("registers exactly three commands", () => {
        const pi = makeMockPi();
        const telemetry = makeMockTelemetry();
        registerTelemetryCommands(pi, telemetry);
        expect(pi._commandNames().length).toBe(3);
    });

    it("registers save-tokens-experiment", () => {
        const pi = makeMockPi();
        const telemetry = makeMockTelemetry();
        registerTelemetryCommands(pi, telemetry);
        expect(pi._getCommand("save-tokens-experiment")).toBeDefined();
    });

    it("registers save-tokens-stats", () => {
        const pi = makeMockPi();
        const telemetry = makeMockTelemetry();
        registerTelemetryCommands(pi, telemetry);
        expect(pi._getCommand("save-tokens-stats")).toBeDefined();
    });

    it("registers save-tokens-export", () => {
        const pi = makeMockPi();
        const telemetry = makeMockTelemetry();
        registerTelemetryCommands(pi, telemetry);
        expect(pi._getCommand("save-tokens-export")).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// save-tokens-experiment command
// ---------------------------------------------------------------------------

describe("save-tokens-experiment command", () => {
    it("calls telemetry.tag() with parsed tag", async () => {
        const pi = makeMockPi();
        const telemetry = makeMockTelemetry();
        registerTelemetryCommands(pi, telemetry);
        const cmd = pi._getCommand("save-tokens-experiment")!;
        const ctx = makeMockCtx();

        await cmd.handler("baseline", ctx);

        expect(telemetry.tag).toHaveBeenCalledWith("baseline", undefined);
    });

    it("calls telemetry.tag() with tag and value", async () => {
        const pi = makeMockPi();
        const telemetry = makeMockTelemetry();
        registerTelemetryCommands(pi, telemetry);
        const cmd = pi._getCommand("save-tokens-experiment")!;
        const ctx = makeMockCtx();

        await cmd.handler("my_exp variant-A", ctx);

        expect(telemetry.tag).toHaveBeenCalledWith("my_exp", "variant-A");
    });

    it("notifies error when tag is empty", async () => {
        const pi = makeMockPi();
        const telemetry = makeMockTelemetry();
        registerTelemetryCommands(pi, telemetry);
        const cmd = pi._getCommand("save-tokens-experiment")!;
        const ctx = makeMockCtx();

        await cmd.handler("", ctx);

        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const errorCall = notifyCalls.find((c: unknown[]) => c[1] === "error");
        expect(errorCall).toBeDefined();
        expect(errorCall![0]).toContain("tag required");
    });

    it("notifies error when tag contains invalid characters", async () => {
        const pi = makeMockPi();
        const telemetry = makeMockTelemetry();
        registerTelemetryCommands(pi, telemetry);
        const cmd = pi._getCommand("save-tokens-experiment")!;
        const ctx = makeMockCtx();

        // "bad!" is a single token with invalid char — no space to split as value
        await cmd.handler("bad!", ctx);

        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const errorCall = notifyCalls.find((c: unknown[]) => c[1] === "error");
        expect(errorCall).toBeDefined();
        expect(errorCall![0]).toContain("invalid");
    });

    it("notifies success when tag succeeds", async () => {
        const pi = makeMockPi();
        const telemetry = makeMockTelemetry();
        registerTelemetryCommands(pi, telemetry);
        const cmd = pi._getCommand("save-tokens-experiment")!;
        const ctx = makeMockCtx();

        await cmd.handler("baseline", ctx);

        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const successCall = notifyCalls.find((c: unknown[]) => c[1] === "info");
        expect(successCall).toBeDefined();
        expect(successCall![0]).toContain("baseline");
    });

    it("notifies error when telemetry.tag() returns false", async () => {
        const pi = makeMockPi();
        const telemetry = makeMockTelemetry(() => Promise.resolve(false));
        registerTelemetryCommands(pi, telemetry);
        const cmd = pi._getCommand("save-tokens-experiment")!;
        const ctx = makeMockCtx();

        await cmd.handler("baseline", ctx);

        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const errorCall = notifyCalls.find((c: unknown[]) => c[1] === "error");
        expect(errorCall).toBeDefined();
        expect(errorCall![0]).toContain("no active session");
    });

    it("catches exceptions in handler and notifies error", async () => {
        const pi = makeMockPi();
        const telemetry = makeMockTelemetry(async () => {
            throw new Error("unexpected");
        });
        registerTelemetryCommands(pi, telemetry);
        const cmd = pi._getCommand("save-tokens-experiment")!;
        const ctx = makeMockCtx();

        // Should not throw — error caught in handler
        await cmd.handler("baseline", ctx);

        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const errorCall = notifyCalls.find((c: unknown[]) => c[1] === "error");
        expect(errorCall).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// save-tokens-stats command — real integration tests
// ---------------------------------------------------------------------------

describe("save-tokens-stats command", () => {
    it("notifies error on invalid from date", async () => {
        const pi = makeMockPi();
        registerTelemetryCommands(pi, makeMockTelemetry());
        const cmd = pi._getCommand("save-tokens-stats")!;
        const ctx = makeMockCtx();

        await cmd.handler("from=bad-date", ctx);

        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const errorCall = notifyCalls.find((c: unknown[]) => c[1] === "error");
        expect(errorCall).toBeDefined();
    });

    it("catches exceptions in handler and survives double-fault", async () => {
        const pi = makeMockPi();
        registerTelemetryCommands(pi, makeMockTelemetry());
        const cmd = pi._getCommand("save-tokens-stats")!;
        const ctx = makeMockCtx();
        (ctx.ui.notify as ReturnType<typeof mock>).mockImplementation(() => {
            throw new Error("ui failure");
        });

        await cmd.handler("bad", ctx);
        expect(true).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Helpers for real integration (JSONL write)
// ---------------------------------------------------------------------------

async function writeJsonlSessionFile(dir: string, sessionId: string, events: Record<string, unknown>[]): Promise<void> {
    // Extract date from first event timestamp: scanner expects <root>/YYYY-MM-DD/<session>.jsonl
    const firstTs = typeof events[0]?.timestamp === "string" ? events[0].timestamp : "2026-07-15T00:00:00.000Z";
    const dateStr = firstTs.slice(0, 10); // YYYY-MM-DD
    const dateDir = join(dir, dateStr);
    await mkdir(dateDir, { recursive: true });
    const lines = events.map(e => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(join(dateDir, `${sessionId}.jsonl`), lines, "utf-8");
}

function makeSessionStartRec(sessionId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        schemaVersion: 1, eventId: `ev-${sessionId}-start`, timestamp: "2026-07-15T10:00:00.000Z",
        sessionId, event: "session_start", model: "claude-sonnet-4-6", provider: "anthropic",
        project: "test-project", ...overrides,
    };
}

function makeTurnEndRec(sessionId: string, runId: string, turnIndex: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        schemaVersion: 1, eventId: `ev-${sessionId}-turn${turnIndex}`,
        timestamp: `2026-07-15T1${turnIndex}:00:00.000Z`, sessionId, event: "turn_end",
        runId, turnIndex, toolCallCount: 3,
        usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700, cost: 0.015 },
        ...overrides,
    };
}

function makeExperimentTagRec(sessionId: string, tag: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        schemaVersion: 1, eventId: `ev-${sessionId}-exptag`, timestamp: "2026-07-15T10:01:00.000Z",
        sessionId, event: "experiment_tag", tag, ...overrides,
    };
}

// ===========================================================================
// Real stats integration tests — scan/filter/aggregate on tmp archive
// ===========================================================================

describe("save-tokens-stats — real integration", () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), "st-stats-real-"));
        mockConfigDir = tmpDir;
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    it("scans archive with real JSONL files and displays summary with nonzero metrics", async () => {
        // Write one session with 2 turns worth of events
        // Turn 0: 700 tokens, $0.015 | Turn 1: 1500 tokens, $0.03 | Total: 2200 tokens, $0.045
        const sid = "sess-001";
        await writeJsonlSessionFile(tmpDir, sid, [
            makeSessionStartRec(sid),
            makeTurnEndRec(sid, "run-001", 0),
            makeTurnEndRec(sid, "run-001", 1, { usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cost: 0.03 } }),
        ]);

        const pi = makeMockPi();
        registerTelemetryCommands(pi, makeMockTelemetry());
        const cmd = pi._getCommand("save-tokens-stats")!;
        const ctx = makeMockCtx();

        await cmd.handler("", ctx);

        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const summaryCall = notifyCalls.find((c: unknown[]) => c[1] === "info");
        expect(summaryCall).toBeDefined();
        const text = summaryCall![0] as string;
        // Summary must contain scan diagnostics with nonzero counts
        expect(text).toContain("Scanned:");
        expect(text).toContain("1 sessions");
        expect(text).toContain("3 events");
        // observed_off_off row must contain nonzero metrics
        expect(text).toContain("$0.0450");
        expect(text).toContain("2,200"); // 2200 total tokens
    });

    it("rejects unknown filter keys", async () => {
        await writeJsonlSessionFile(tmpDir, "sess-001", [
            makeSessionStartRec("sess-001"),
            makeTurnEndRec("sess-001", "run-001", 0),
        ]);

        const pi = makeMockPi();
        registerTelemetryCommands(pi, makeMockTelemetry());
        const cmd = pi._getCommand("save-tokens-stats")!;
        const ctx = makeMockCtx();

        await cmd.handler("unknown_key=val", ctx);

        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const errorCall = notifyCalls.find((c: unknown[]) => c[1] === "error");
        expect(errorCall).toBeDefined();
        expect(errorCall![0]).toContain("unknown_key");
    });

    it("displays tag filter when tag=baseline in summary", async () => {
        // Write session with proper experiment_tag event so filterAndAnnotate picks it up.
        // analytics.ts reads experimentTag state only from event==="experiment_tag",
        // NOT from session_start.experimentTag.
        //
        // IMPORTANT: scanTelemetryArchive sorts by timestamp. turn_end for turnIndex=0
        // has ts "2026-07-15T10:00:00.000Z" (same as session_start), which sorts BEFORE
        // experiment_tag at "10:01:00". So we use turnIndex=1 (ts "11:00:00") to ensure
        // chronological order: session_start → experiment_tag → turn_end.
        //
        // Archive order: session_start (10:00) → experiment_tag baseline (10:01) → turn_end (11:00)
        const sid = "sess-tag-001";
        await writeJsonlSessionFile(tmpDir, sid, [
            makeSessionStartRec(sid),
            makeExperimentTagRec(sid, "baseline"),
            makeTurnEndRec(sid, "run-001", 1),
        ]);

        const pi = makeMockPi();
        registerTelemetryCommands(pi, makeMockTelemetry());
        const cmd = pi._getCommand("save-tokens-stats")!;
        const ctx = makeMockCtx();

        await cmd.handler("tag=baseline", ctx);

        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const summaryCall = notifyCalls.find((c: unknown[]) => c[1] === "info");
        expect(summaryCall).toBeDefined();
        const text = summaryCall![0] as string;
        // Must show the filter text
        expect(text).toContain("Filters: tag=baseline");
        // Must contain nonzero cost from the filtered group row (not just Scanned header).
        // makeTurnEndRec default: cost=0.015, totalTokens=700. This proves filter+annotate
        // passed the tagged turn_end through, not just that the filter text is present.
        expect(text).toContain("$0.0150");
    });
});

// ===========================================================================
// Real export integration tests — JSON/CSV file creation, permissions, anti-overwrite
// ===========================================================================

describe("save-tokens-export — real integration", () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), "st-export-real-"));
        mockConfigDir = tmpDir;
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    it("exports real JSON with valid structure and nonzero metrics", async () => {
        // Write real events — 1 session, 2 turns, 6 tools, 2200 tokens, $0.045
        const sid = "sess-exp-001";
        await writeJsonlSessionFile(tmpDir, sid, [
            makeSessionStartRec(sid),
            makeTurnEndRec(sid, "run-001", 0),
            makeTurnEndRec(sid, "run-001", 1, { usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cost: 0.03 } }),
        ]);

        const pi = makeMockPi();
        registerTelemetryCommands(pi, makeMockTelemetry());
        const cmd = pi._getCommand("save-tokens-export")!;
        const ctx = makeMockCtx();

        // Default export: JSON to <root>/exports/
        await cmd.handler("", ctx);

        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const successCall = notifyCalls.find((c: unknown[]) => c[1] === "info");
        expect(successCall).toBeDefined();
        const msg = successCall![0] as string;
        expect(msg).toContain("JSON");

        // Extract the file path from the notification
        const pathMatch = msg.match(/written JSON to (.+)$/);
        expect(pathMatch).toBeTruthy();
        const exportPath = pathMatch![1]!;

        // Verify file exists and content is valid JSON
        const content = await readFile(exportPath, "utf-8");
        const parsed = JSON.parse(content);
        expect(parsed.exportVersion).toBe(1);
        expect(parsed.query).toBeDefined();
        expect(Array.isArray(parsed.rows)).toBe(true);
        expect(parsed.rows.length).toBe(4); // always 4 group rows

        // observed_off_off must contain nonzero metrics
        const offOff = parsed.rows.find((r: { groupKey: string }) => r.groupKey === "observed_off_off");
        expect(offOff).toBeDefined();
        expect(offOff.sessionCount).toBe(1);
        expect(offOff.turnCount).toBe(2);
        expect(offOff.toolCallCount).toBe(6);
        expect(offOff.totalTokens).toBe(2200);
        expect(offOff.cost).toBe(0.045);
        // Other three rows should be zero
        for (const row of parsed.rows) {
            if (row.groupKey !== "observed_off_off") {
                expect(row.sessionCount).toBe(0);
                expect(row.totalTokens).toBe(0);
            }
        }

        // Verify file mode 0600
        const st = await stat(exportPath);
        expect(st.mode & 0o777).toBe(0o600);
    });

    it("exports real CSV with header and nonzero data rows", async () => {
        const sid = "sess-csv-001";
        await writeJsonlSessionFile(tmpDir, sid, [
            makeSessionStartRec(sid),
            makeTurnEndRec(sid, "run-001", 0),
            makeTurnEndRec(sid, "run-001", 1, { usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cost: 0.03 } }),
        ]);

        const pi = makeMockPi();
        registerTelemetryCommands(pi, makeMockTelemetry());
        const cmd = pi._getCommand("save-tokens-export")!;
        const ctx = makeMockCtx();

        await cmd.handler("format=csv", ctx);

        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const successCall = notifyCalls.find((c: unknown[]) => c[1] === "info");
        expect(successCall).toBeDefined();
        const msg = successCall![0] as string;
        expect(msg).toContain("CSV");

        const pathMatch = msg.match(/written CSV to (.+)$/);
        expect(pathMatch).toBeTruthy();
        const exportPath = pathMatch![1]!;

        const content = await readFile(exportPath, "utf-8");
        const lines = content.trim().split("\n");
        expect(lines.length).toBeGreaterThanOrEqual(2); // header + at least 1 data row
        expect(lines[0]).toContain("groupKey"); // header

        // Find observed_off_off data row and verify nonzero metrics
        const offOffLine = lines.find((l) => l.startsWith("observed_off_off"));
        expect(offOffLine).toBeDefined();
        // CSV columns: groupKey, sessionCount, runCount, turnCount, toolCallCount, ...
        const fields = offOffLine!.split(",");
        expect(fields[1]).toBe("1"); // sessionCount
        // turnCount should be 2, toolCallCount 6
        expect(fields[3]).toBe("2"); // turnCount
        expect(fields[4]).toBe("6"); // toolCallCount

        // Verify file mode 0600
        const st = await stat(exportPath);
        expect(st.mode & 0o777).toBe(0o600);
    });

    it("explicit export fails with error when file already exists", async () => {
        const sid = "sess-dup-001";
        await writeJsonlSessionFile(tmpDir, sid, [
            makeSessionStartRec(sid),
            makeTurnEndRec(sid, "run-001", 0),
        ]);

        // Pre-create the export file
        const explicitPath = join(tmpdir(), `st-export-exists-${Date.now()}.json`);
        await writeFile(explicitPath, "existing content", "utf-8");

        const pi = makeMockPi();
        registerTelemetryCommands(pi, makeMockTelemetry());
        const cmd = pi._getCommand("save-tokens-export")!;
        const ctx = makeMockCtx();

        await cmd.handler(`out=${explicitPath}`, ctx);

        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const errorCall = notifyCalls.find((c: unknown[]) => c[1] === "error");
        expect(errorCall).toBeDefined();
        expect(errorCall![0]).toContain("already exists");

        // Original content must be intact
        const originalContent = await readFile(explicitPath, "utf-8");
        expect(originalContent).toBe("existing content");

        // Cleanup
        await rm(explicitPath, { force: true }).catch(() => {});
    });

    it("explicit export preserves parent directory mode", async () => {
        const sid = "sess-parent-001";
        await writeJsonlSessionFile(tmpDir, sid, [
            makeSessionStartRec(sid),
            makeTurnEndRec(sid, "run-001", 0),
        ]);

        // Create a parent dir with known mode 0755
        const parentDir = join(tmpdir(), `st-parent-${Date.now()}`);
        await mkdir(parentDir, { mode: 0o755 });
        const explicitPath = join(parentDir, "export.json");

        const pi = makeMockPi();
        registerTelemetryCommands(pi, makeMockTelemetry());
        const cmd = pi._getCommand("save-tokens-export")!;
        const ctx = makeMockCtx();

        await cmd.handler(`out=${explicitPath}`, ctx);

        // Parent dir mode must remain 0755
        const parentSt = await stat(parentDir);
        expect(parentSt.mode & 0o777).toBe(0o755);

        // Export file must be 0600
        const exportSt = await stat(explicitPath);
        expect(exportSt.mode & 0o777).toBe(0o600);

        // Cleanup
        await rm(parentDir, { recursive: true, force: true }).catch(() => {});
    });

    it("default export dir is created with 0700", async () => {
        const sid = "sess-defdir-001";
        await writeJsonlSessionFile(tmpDir, sid, [
            makeSessionStartRec(sid),
            makeTurnEndRec(sid, "run-001", 0),
        ]);

        const pi = makeMockPi();
        registerTelemetryCommands(pi, makeMockTelemetry());
        const cmd = pi._getCommand("save-tokens-export")!;
        const ctx = makeMockCtx();

        await cmd.handler("", ctx);

        // The exports subdirectory inside tmpDir should be 0700
        const exportsDir = join(tmpDir, "exports");
        const st = await stat(exportsDir);
        expect(st.mode & 0o777).toBe(0o700);
    });

    it("rejects invalid format value", async () => {
        const pi = makeMockPi();
        registerTelemetryCommands(pi, makeMockTelemetry());
        const cmd = pi._getCommand("save-tokens-export")!;
        const ctx = makeMockCtx();

        await cmd.handler("format=xml", ctx);

        const notifyCalls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
        const errorCall = notifyCalls.find((c: unknown[]) => c[1] === "error");
        expect(errorCall).toBeDefined();
        expect(errorCall![0]).toContain("format");
    });

    it("catches exceptions in handler and survives double-fault", async () => {
        const pi = makeMockPi();
        registerTelemetryCommands(pi, makeMockTelemetry());
        const cmd = pi._getCommand("save-tokens-export")!;
        const ctx = makeMockCtx();
        (ctx.ui.notify as ReturnType<typeof mock>).mockImplementation(() => {
            throw new Error("ui failure");
        });

        await cmd.handler("bad", ctx);
        expect(true).toBe(true);
    });

    it("default format is json", async () => {
        const result = parseArgs("");
        expect(result.ok).toBe(true);
        expect(result.parsed!.format).toBeUndefined();
    });

    it("default filename collision preserves original content and creates suffixed file", async () => {
        // Pre-create exact default target with sentinel content
        const exportsDir = join(tmpDir, "exports");
        await mkdir(exportsDir, { recursive: true });

        const now = new Date("2026-07-15T12:00:00.000Z");
        const stamp = now.toISOString().replace(/[:.]/g, "-");
        const defaultPath = join(exportsDir, `telemetry-export-${stamp}.json`);
        const sentinel = "PRESERVED-SENTINEL-CONTENT";
        await writeFile(defaultPath, sentinel, "utf-8");

        // Write events so export content is non-empty
        const sid = "sess-collide-001";
        await writeJsonlSessionFile(tmpDir, sid, [
            makeSessionStartRec(sid),
            makeTurnEndRec(sid, "run-001", 0),
        ]);

        // Resolve path with the same clock — simulate the default path
        const resolved = resolveExportPath(tmpDir, undefined, "json", "/test", now);
        expect(resolved.path).toBe(defaultPath);
        expect(resolved.isExplicit).toBe(false);

        // Build export content
        const { scanTelemetryArchive, filterAndAnnotate, aggregateGroups, exportJson } = await import("./analytics");
        const scanResult = await scanTelemetryArchive({ root: tmpDir });
        const { annotated } = filterAndAnnotate(scanResult.records, {});
        const { rows } = aggregateGroups(annotated);
        const content = exportJson({
            query: { root: tmpDir },
            diagnostics: scanResult.diagnostics,
            rows,
        });

        // Write via writeExportFile — should detect collision and create -1 suffix
        const writtenPath = await writeExportFile(defaultPath, content, false);

        // Original sentinel file must be INTACT
        const originalContent = await readFile(defaultPath, "utf-8");
        expect(originalContent).toBe(sentinel);

        // Suffixed file must exist with exported content
        expect(writtenPath).not.toBe(defaultPath);
        expect(writtenPath).toContain("-1");
        const suffixedContent = await readFile(writtenPath, "utf-8");
        const parsed = JSON.parse(suffixedContent);
        expect(parsed.exportVersion).toBe(1);
        expect(parsed.rows.length).toBe(4);
    });
});

// ---------------------------------------------------------------------------
// resolveExportPath — tilde expansion and path resolution
// ---------------------------------------------------------------------------

describe("resolveExportPath", () => {
    it("resolves relative paths from cwd", () => {
        const result = resolveExportPath("/telemetry", "export.json", "json", "/home/user/project");
        expect(result.path).toBe("/home/user/project/export.json");
        expect(result.isExplicit).toBe(true);
    });

    it("keeps absolute paths unchanged", () => {
        const result = resolveExportPath("/telemetry", "/tmp/out.json", "json", "/cwd");
        expect(result.path).toBe("/tmp/out.json");
        expect(result.isExplicit).toBe(true);
    });

    it("expands ~/ prefix to homedir", () => {
        const result = resolveExportPath("/telemetry", "~/exports/data.json", "json", "/cwd");
        expect(result.path).toBe(join(homedir(), "exports", "data.json"));
        expect(result.isExplicit).toBe(true);
        expect(result.path.startsWith(homedir())).toBe(true);
    });

    it("expands bare ~ to homedir", () => {
        const result = resolveExportPath("/telemetry", "~", "json", "/cwd");
        expect(result.path).toBe(homedir());
        expect(result.isExplicit).toBe(true);
    });

    it("does not expand ~other (non-home tilde)", () => {
        const result = resolveExportPath("/telemetry", "~other/file.json", "json", "/cwd");
        expect(result.path).toBe("/cwd/~other/file.json");
        expect(result.isExplicit).toBe(true);
    });

    it("generates default path with timestamp in exports/ subdirectory", () => {
        const now = new Date("2026-07-15T12:00:00.000Z");
        const result = resolveExportPath("/telemetry", undefined, "json", "/cwd", now);
        expect(result.isExplicit).toBe(false);
        expect(result.path).toContain("/telemetry/exports/");
        expect(result.path).toContain("2026-07-15");
        expect(result.path.endsWith(".json")).toBe(true);
    });

    it("uses .csv extension for csv format", () => {
        const now = new Date("2026-07-15T12:00:00.000Z");
        const result = resolveExportPath("/telemetry", undefined, "csv", "/cwd", now);
        expect(result.path.endsWith(".csv")).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// TAG_PATTERN constant
// ---------------------------------------------------------------------------

describe("TAG_PATTERN", () => {
    it("is a RegExp", () => {
        expect(TAG_PATTERN).toBeInstanceOf(RegExp);
    });

    it("matches ASCII alphanumeric, dot, dash, underscore", () => {
        expect(TAG_PATTERN.test("abc")).toBe(true);
        expect(TAG_PATTERN.test("ABC123")).toBe(true);
        expect(TAG_PATTERN.test("test-1")).toBe(true);
        expect(TAG_PATTERN.test("v1.0")).toBe(true);
        expect(TAG_PATTERN.test("my_tag")).toBe(true);
    });

    it("rejects non-ASCII", () => {
        expect(TAG_PATTERN.test("café")).toBe(false);
    });
});
