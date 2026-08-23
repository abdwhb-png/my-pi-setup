import { describe, expect, it } from "bun:test";
import {
  formatTokenCount,
  formatUsdCompact,
  renderBranch,
  buildContextContent,
  renderContext,
  renderCost,
  renderCwd,
  renderModel,
  renderSessionName,
  buildSessionTokenContent,
  buildTokenContent,
  renderTokenCounts,
    shortenMiddle,
  sessionNamePrefix,
  type StatusBarState,
} from "./status-segments";
import type { UiColorsCreation } from "./ui/ui-colors";

/**
 * Identity color stub: every method returns its first string arg unchanged.
 * Lets us assert on plain text content without a real theme/ANSI pipeline.
 */
function stubColors(): UiColorsCreation {
  const identity = (text: string) => text;
  return {
    apply: identity,
    separator: identity,
    subtle: identity,
    muted: identity,
    meta: identity,
    primary: identity,
    success: identity,
    warning: identity,
    danger: identity,
    text: identity,
    model: identity,
    toolOutput: identity,
    // pressure ignores numeric args in the stub, returns the text as-is
    pressure: (text: string) => text,
  } as unknown as UiColorsCreation;
}

function makeState(over: Partial<StatusBarState> = {}): StatusBarState {
  return {
    workspace: { shortCwd: "~/repo", shortBranch: "main" },
    context: { tokens: 18000, window: 200000, percent: 9 },
    model: { id: "claude-sonnet-4", provider: "anthropic" as never },
    session: { name: "my-session" },
    cost: { totalUsd: 0.42 },
    tokens: { input: 1234, output: 340, cacheRead: 20, cacheWrite: 8 },
    ...over,
  };
}

describe("shortenMiddle", () => {
  it("returns text unchanged when it fits", () => {
    expect(shortenMiddle("abc", 10)).toBe("abc");
  });

  it("shortens from the middle when too long", () => {
    expect(shortenMiddle("abcdefghij", 7)).toBe("abc…hij");
  });

  it("returns dots when width is tiny", () => {
    expect(shortenMiddle("abc", 2)).toBe("..");
  });
});

describe("formatTokenCount", () => {
  it("formats raw count under 1k", () => {
    expect(formatTokenCount(500)).toBe("500");
  });

  it("formats 1k-10k with one decimal", () => {
    expect(formatTokenCount(2500)).toBe("2.5k");
  });

  it("formats 10k-1m rounded", () => {
    expect(formatTokenCount(18000)).toBe("18k");
  });

  it("formats millions with one decimal", () => {
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
  });
});

describe("formatUsdCompact", () => {
  const colors = stubColors();

  it("shows $0.00 for zero or invalid", () => {
    expect(formatUsdCompact(0, colors)).toBe("$ 0.00");
    expect(formatUsdCompact(-1, colors)).toBe("$ 0.00");
  });

  it("shows <$0.01 for sub-cent values", () => {
    expect(formatUsdCompact(0.001, colors)).toBe("<$ 0.01");
  });

  it("formats normal values with two decimals", () => {
    expect(formatUsdCompact(0.42, colors)).toBe("$ 0.42");
    expect(formatUsdCompact(12.5, colors)).toBe("$ 12.50");
  });
});

describe("segment renderers", () => {
  const colors = stubColors();

  it("renderCwd applies meta color and shortens to width", () => {
    const state = makeState({ workspace: { shortCwd: "~/very/long/path/here", shortBranch: "main" } });
    expect(renderCwd(state, 8, colors)).toBe(shortenMiddle("~/very/long/path/here", 8));
  });

  it("renderBranch returns the branch string", () => {
    expect(renderBranch(makeState(), 20, colors)).toBe("main");
  });

  it("renderSessionName prefixes and shortens; empty when no name", () => {
    expect(renderSessionName(makeState(), 20, colors)).toBe(`${sessionNamePrefix}my-session`);
    const empty = makeState({ session: { name: undefined } });
    expect(renderSessionName(empty, 20, colors)).toBe("");
  });

  it("renderContext builds percent + tokens/window", () => {
    const out = renderContext(makeState(), 80, colors);
    expect(out).toBe(buildContextContent(9, 18000, 200000, colors));
  });

  it("renderCost formats usd compact", () => {
    expect(renderCost(makeState(), 20, colors)).toBe("$ 0.42");
  });

  it("renderModel combines provider and model id", () => {
    expect(renderModel(makeState(), 40, colors)).toBe("(anthropic) claude-sonnet-4");
  });

  it("renderModel handles missing provider", () => {
    const state = makeState({ model: { id: "x", provider: undefined } });
    expect(renderModel(state, 40, colors)).toBe("(no-provider) x");
  });

  it("buildTokenContent labels input and output with their directions", () => {
    expect(buildTokenContent(1234, 340, colors)).toBe("in↓1.2k/out↑340");
  });

  it("renderTokenCounts renders session totals with cache read and write", () => {
    const state = makeState({
      tokens: { input: 1234, output: 340, cacheRead: 20, cacheWrite: 8 },
    });
    expect(renderTokenCounts(state, 40, colors)).toBe(
      buildSessionTokenContent(1234, 340, 20, 8, colors),
    );
    expect(renderTokenCounts(state, 40, colors)).toBe(
      "Σ in↓1.2k/out↑340 · cache R20/W8",
    );
  });
});
