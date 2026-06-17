import { describe, it, expect } from "bun:test";
import type { TimeWindowReport, ModelUsageAggregate } from "./types";
import { UsageInlineView } from "./inline-view";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeModel(overrides: Partial<ModelUsageAggregate> = {}): ModelUsageAggregate {
  return {
    sourceKey: "openrouter/deepseek/deepseek-v4-flash",
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash",
    messageCount: 5,
    input: 50000,
    output: 2000,
    cacheRead: 1000,
    totalTokens: 53000,
    cost: 0.025,
    ...overrides,
  };
}

function makeWindow(overrides: Partial<TimeWindowReport> = {}): TimeWindowReport {
  return {
    label: "Last 1 day",
    days: 1,
    models: [
      makeModel(),
      makeModel({
        sourceKey: "openai/gpt-4o",
        provider: "openai",
        model: "gpt-4o",
        messageCount: 3,
        input: 15000,
        output: 800,
        cacheRead: 500,
        totalTokens: 16300,
        cost: 0.06,
      }),
    ],
    totalMessages: 8,
    totalInput: 65000,
    totalOutput: 2800,
    totalCacheRead: 1500,
    totalTokens: 69300,
    totalCost: 0.085,
    ...overrides,
  };
}

const MOCK_THEME = {
  fg: (color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("UsageInlineView", () => {
  it("renders without throwing with valid data", () => {
    const window = makeWindow();
    let doneCalled = false;
    const view = new UsageInlineView({
      window,
      theme: MOCK_THEME as any,
      done: () => {
        doneCalled = true;
      },
    });

    const lines = view.render(80);
    expect(lines.length).toBeGreaterThan(0);
    // Should include the title
    const joined = lines.join("\n");
    expect(joined).toContain("Today");
    // Should include model names (may be truncated due to column width)
    expect(joined).toContain("deepseek");
    expect(joined).toContain("gpt-4o");
    expect(doneCalled).toBe(false);
  });

  it("renders empty state when there are no models", () => {
    const emptyWindow = makeWindow({ models: [], totalMessages: 0, totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalTokens: 0, totalCost: 0 });
    let doneCalled = false;
    const view = new UsageInlineView({
      window: emptyWindow,
      theme: MOCK_THEME as any,
      done: () => {
        doneCalled = true;
      },
    });

    const lines = view.render(80);
    const joined = lines.join("\n");
    expect(joined).toContain("No usage data");
    expect(doneCalled).toBe(false);
  });

  it("handleInput calls done on 'q'", () => {
    let doneCalled = false;
    const view = new UsageInlineView({
      window: makeWindow(),
      theme: MOCK_THEME as any,
      done: () => {
        doneCalled = true;
      },
    });

    view.handleInput("q");
    expect(doneCalled).toBe(true);
  });

  it("handleInput calls done on 'Q'", () => {
    let doneCalled = false;
    const view = new UsageInlineView({
      window: makeWindow(),
      theme: MOCK_THEME as any,
      done: () => {
        doneCalled = true;
      },
    });

    view.handleInput("Q");
    expect(doneCalled).toBe(true);
  });

  it("handleInput calls done on Escape", () => {
    let doneCalled = false;
    const view = new UsageInlineView({
      window: makeWindow(),
      theme: MOCK_THEME as any,
      done: () => {
        doneCalled = true;
      },
    });

    view.handleInput("\x1b");
    expect(doneCalled).toBe(true);
  });

  it("handleInput calls done on Enter", () => {
    let doneCalled = false;
    const view = new UsageInlineView({
      window: makeWindow(),
      theme: MOCK_THEME as any,
      done: () => {
        doneCalled = true;
      },
    });

    view.handleInput("\r");
    expect(doneCalled).toBe(true);
  });

  it("handleInput ignores other keys", () => {
    let doneCalled = false;
    const view = new UsageInlineView({
      window: makeWindow(),
      theme: MOCK_THEME as any,
      done: () => {
        doneCalled = true;
      },
    });

    view.handleInput("x");
    view.handleInput("ArrowUp");
    view.handleInput("\t");
    expect(doneCalled).toBe(false);
  });

  it("invalidate does not throw", () => {
    const view = new UsageInlineView({
      window: makeWindow(),
      theme: MOCK_THEME as any,
      done: () => {},
    });

    expect(() => view.invalidate()).not.toThrow();
  });
});