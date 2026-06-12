import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { parseJSONLLine, parseSessionFile } from "./scanner";
import {
  isWithinWindow,
  groupByModel,
  computeWindow,
  computeAllWindows,
  TIME_WINDOWS,
} from "./aggregator";
import { formatNumber, formatUSD, renderWindow, renderReport } from "./format";
import { UsageReportWidget } from "./session";
import { PRICING_CACHE_PATH, loadPricingCache, fetchFromModelsDev } from "./pricing";
import type {
  UsageRecord,
  UsageReport,
  TimeWindowReport,
  ModelRates,
  ModelUsageAggregate,
} from "./types";

// ── Sample data helpers ──────────────────────────────────────────────────────

const SAMPLE_TIMESTAMP = "2026-06-10T20:17:27.487Z";

function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    timestamp: new Date(SAMPLE_TIMESTAMP),
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash",
    sourceKey: "openrouter/deepseek/deepseek-v4-flash",
    input: 15302,
    output: 35,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15337,
    cost: 0.00151,
    ...overrides,
  };
}

function makeSecondRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    timestamp: new Date("2026-06-09T14:00:00.000Z"),
    provider: "openai",
    model: "gpt-4o",
    sourceKey: "openai/gpt-4o",
    input: 500,
    output: 100,
    cacheRead: 50,
    cacheWrite: 10,
    totalTokens: 650,
    cost: 0.02,
    ...overrides,
  };
}

function makeSampleWindow(overrides: Partial<TimeWindowReport> = {}): TimeWindowReport {
  return {
    label: "Last 7 days",
    days: 7,
    models: [
      {
        sourceKey: "openrouter/deepseek/deepseek-v4-flash",
        provider: "openrouter",
        model: "deepseek/deepseek-v4-flash",
        messageCount: 1,
        input: 15302,
        output: 35,
        cacheRead: 0,
        totalTokens: 15337,
        cost: 0.00151,
      },
      {
        sourceKey: "openai/gpt-4o",
        provider: "openai",
        model: "gpt-4o",
        messageCount: 1,
        input: 500,
        output: 100,
        cacheRead: 50,
        totalTokens: 650,
        cost: 0.02,
      },
    ],
    totalMessages: 2,
    totalInput: 15802,
    totalOutput: 135,
    totalCacheRead: 50,
    totalTokens: 15987,
    totalCost: 0.02,
    ...overrides,
  };
}

function makeSampleReport(overrides: Partial<UsageReport> = {}): UsageReport {
  return {
    windows: [makeSampleWindow()],
    generatedAt: new Date("2026-06-10T21:00:00.000Z"),
    pricingNotes: [
      "openrouter/deepseek/deepseek-v4-flash: rates from cached",
      "openai/gpt-4o: rates from models.dev",
    ],
    pricing: new Map<string, ModelRates>(),
    ...overrides,
  };
}

// Real session data sample
const REAL_ASSISTANT_LINE = `{"type":"message","id":"10252817","parentId":"9de0670c","timestamp":"2026-06-10T20:17:27.487Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"thinking text","thinkingSignature":"reasoning"},{"type":"text","text":"Yes"}],"api":"openai-completions","provider":"openrouter","model":"deepseek/deepseek-v4-flash","usage":{"input":15302,"output":35,"cacheRead":0,"cacheWrite":0,"totalTokens":15337,"cost":{"input":0.0015041866,"output":6.881e-06,"cacheRead":0,"cacheWrite":0,"total":0.0015110676}},"stopReason":"stop","timestamp":1781122642614,"responseId":"gen-1781122643-yWXd4y2Svi3RJ5ZRToC8","responseModel":"deepseek/deepseek-v4-flash-20260423"}}`;

// ── scanner ──────────────────────────────────────────────────────────────────

describe("scanner", () => {
  describe("parseJSONLLine", () => {
    it("extracts usage from valid assistant message line", () => {
      const record = parseJSONLLine(REAL_ASSISTANT_LINE);
      expect(record).not.toBeNull();
      expect(record!.provider).toBe("openrouter");
      expect(record!.model).toBe("deepseek/deepseek-v4-flash");
      expect(record!.sourceKey).toBe("openrouter/deepseek/deepseek-v4-flash");
      expect(record!.input).toBe(15302);
      expect(record!.output).toBe(35);
      expect(record!.cacheRead).toBe(0);
      expect(record!.cacheWrite).toBe(0);
      expect(record!.totalTokens).toBe(15337);
      // cost should be the nested total (0.0015110676), rounded by precision
      expect(record!.cost).toBeCloseTo(0.0015110676, 6);
      expect(record!.timestamp).toBeInstanceOf(Date);
    });

    it("returns null for non-message lines (session header)", () => {
      const result = parseJSONLLine('{"type":"session","version":3}');
      expect(result).toBeNull();
    });

    it("returns null for user messages", () => {
      const userLine = JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      });
      const result = parseJSONLLine(userLine);
      expect(result).toBeNull();
    });

    it("returns null for malformed JSON", () => {
      expect(parseJSONLLine("{this is not valid json}")).toBeNull();
    });

    it("returns null for empty/whitespace lines", () => {
      expect(parseJSONLLine("")).toBeNull();
      expect(parseJSONLLine("   ")).toBeNull();
      expect(parseJSONLLine("\t")).toBeNull();
    });
  });

  describe("parseSessionFile", () => {
    it("returns empty array for nonexistent file", () => {
      const result = parseSessionFile("/tmp/__nonexistent_usage_test_file__.jsonl");
      expect(result).toEqual([]);
    });

    it("returns empty array for empty file", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-test-"));
      const emptyFile = path.join(tmpDir, "empty.jsonl");
      fs.writeFileSync(emptyFile, "", "utf-8");
      try {
        const result = parseSessionFile(emptyFile);
        expect(result).toEqual([]);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

// ── aggregator ───────────────────────────────────────────────────────────────

describe("aggregator", () => {
  describe("isWithinWindow", () => {
    it("returns true for recent record", () => {
      const now = new Date("2026-06-10T21:00:00.000Z");
      const record = makeRecord();
      expect(isWithinWindow(record, 7, now)).toBe(true);
    });

    it("returns false for old record", () => {
      const now = new Date("2026-06-30T21:00:00.000Z");
      const record = makeRecord();
      expect(isWithinWindow(record, 7, now)).toBe(false);
    });
  });

  describe("groupByModel", () => {
    it("combines records with same sourceKey", () => {
      const records = [
        makeRecord({ sourceKey: "openrouter/deepseek/deepseek-v4-flash", input: 100 }),
        makeRecord({ sourceKey: "openrouter/deepseek/deepseek-v4-flash", input: 200, cost: 0.5 }),
        makeSecondRecord(),
      ];
      const grouped = groupByModel(records);
      expect(grouped.size).toBe(2);

      const first = grouped.get("openrouter/deepseek/deepseek-v4-flash");
      expect(first).toBeDefined();
      expect(first!.messageCount).toBe(2);
      expect(first!.input).toBe(300);
      expect(first!.cost).toBeCloseTo(0.00151 + 0.5, 4);

      const second = grouped.get("openai/gpt-4o");
      expect(second).toBeDefined();
      expect(second!.messageCount).toBe(1);
    });

    it("returns empty map for empty input", () => {
      const grouped = groupByModel([]);
      expect(grouped.size).toBe(0);
    });
  });

  describe("computeWindow", () => {
    it("creates correct TimeWindowReport with real sample records", () => {
      const now = new Date("2026-06-10T21:00:00.000Z");
      const records = [makeRecord(), makeSecondRecord()];
      const pricing = new Map<string, ModelRates>();
      const report = computeWindow(records, 7, pricing, now);

      expect(report.days).toBe(7);
      expect(report.label).toBe("Last 7 days");
      expect(report.models).toHaveLength(2);
      // Models are sorted by cost descending (gpt-4o cost is 0.02 > 0.00151)
      expect(report.models[0].sourceKey).toBe("openai/gpt-4o");
      expect(report.totalMessages).toBe(2);
      expect(report.totalInput).toBe(15802);
      expect(report.totalOutput).toBe(135);
      expect(report.totalCost).toBe(0.02); // Math.round(0.02151 * 100) / 100 = 0.02
    });

    it('label uses singular "day" for 1 day window', () => {
      const now = new Date("2026-06-10T21:00:00.000Z");
      const records = [makeRecord()];
      const pricing = new Map<string, ModelRates>();
      const report = computeWindow(records, 1, pricing, now);
      expect(report.label).toBe("Last 1 day");
    });
  });

  describe("computeAllWindows", () => {
    it("returns all 4 windows", () => {
      const records = [makeRecord()];
      const pricing = new Map<string, ModelRates>();
      const reports = computeAllWindows(records, pricing);
      expect(reports).toHaveLength(4);
      expect(reports.map((r) => r.days)).toEqual([1, 7, 30, 90]);
    });
  });
});

// ── format ───────────────────────────────────────────────────────────────────

describe("format", () => {
  describe("formatNumber", () => {
    it('adds commas: 15302 → "15,302"', () => {
      expect(formatNumber(15302)).toBe("15,302");
    });

    it("handles zero", () => {
      expect(formatNumber(0)).toBe("0");
    });
  });

  describe("formatUSD", () => {
    it("formats small amounts with 4 decimals", () => {
      expect(formatUSD(0.00151)).toBe("$0.0015");
    });

    it("formats large amounts with 2 decimals", () => {
      expect(formatUSD(1.5)).toBe("$1.50");
      expect(formatUSD(100)).toBe("$100.00");
    });
  });

  describe("renderWindow", () => {
    it("returns array of strings for a sample window", () => {
      const window = makeSampleWindow();
      const lines = renderWindow(window);
      expect(Array.isArray(lines)).toBe(true);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(typeof line).toBe("string");
      }
      // Header should include the label
      expect(lines.some((l) => l.includes("Last 7 days"))).toBe(true);
    });

    it("handles empty models array gracefully", () => {
      const window = makeSampleWindow({ models: [] });
      const lines = renderWindow(window);
      expect(lines.some((l) => l.includes("No usage data in this period."))).toBe(true);
    });
  });

  describe("renderReport", () => {
    it("returns array of strings for a sample report", () => {
      const report = makeSampleReport();
      const lines = renderReport(report);
      expect(Array.isArray(lines)).toBe(true);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(typeof line).toBe("string");
      }
      // Should include the title
      expect(lines.some((l) => l.includes("Pi Usage Report"))).toBe(true);
    });
  });
});

// ── UsageReportWidget ────────────────────────────────────────────────────────

describe("UsageReportWidget", () => {
  it("render returns non-empty array when reportLines provided", () => {
    const report = makeSampleReport();
    const lines = ["📊  Usage Report", "", "  Test line"];
    const widget = new UsageReportWidget(report, lines);
    const output = widget.render(80);
    expect(output.length).toBeGreaterThan(0);
    expect(output).toEqual(lines);
  });

  it("render returns lines unchanged when reportLines provided (no truncation in static mode)", () => {
    const report = makeSampleReport();
    const longLine = "a".repeat(100);
    const widget = new UsageReportWidget(report, [longLine]);
    const output = widget.render(10);
    // The widget returns this.lines verbatim when non-empty (static pre-rendered mode)
    expect(output[0]).toBe(longLine);
    expect(output[0].length).toBe(100);
  });

  it("render leaves short lines unchanged", () => {
    const report = makeSampleReport();
    const shortLine = "hello";
    const widget = new UsageReportWidget(report, [shortLine]);
    const output = widget.render(80);
    expect(output[0]).toBe("hello");
  });

  it("invalidate does not throw", () => {
    const report = makeSampleReport();
    const widget = new UsageReportWidget(report, []);
    expect(() => widget.invalidate()).not.toThrow();
  });
});

// ── pricing ──────────────────────────────────────────────────────────────────

describe("pricing", () => {
  describe("PRICING_CACHE_PATH", () => {
    it("ends with pricing-cache.json", () => {
      expect(PRICING_CACHE_PATH.endsWith("pricing-cache.json")).toBe(true);
    });
  });

  describe("loadPricingCache", () => {
    it("returns empty map for nonexistent file", async () => {
      const result = await loadPricingCache(
        "/tmp/__nonexistent_pricing_cache__.json",
      );
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });
  });

  describe("fetchFromModelsDev", () => {
    it("returns empty map for empty sourceKeys array", async () => {
      const result = await fetchFromModelsDev([]);
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });
  });
});