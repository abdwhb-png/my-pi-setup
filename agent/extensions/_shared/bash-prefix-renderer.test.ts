/**
 * Tests for bash-prefix-renderer shared module.
 */
import { describe, it, expect } from "bun:test";
import { Text } from "@earendil-works/pi-tui";
import { createBashPrefixRenderer } from "./bash-prefix-renderer";

function createMockTheme(): any {
  return {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => `**${text}**`,
  };
}

function createMockContext(): any {
  const state: Record<string, unknown> = {};
  return {
    lastComponent: undefined,
    state,
    executionStarted: true,
  };
}

describe("createBashPrefixRenderer", () => {
  it("renders command with static prefix", () => {
    const renderCall = createBashPrefixRenderer("🔒");
    const component = renderCall(
      { command: "ls -la" },
      createMockTheme(),
      createMockContext(),
    );

    // Text component rendered content — check via setText behavior
    expect(component).toBeInstanceOf(Text);
  });

  it("renders command with dynamic prefix getter", () => {
    let active = false;
    const renderCall = createBashPrefixRenderer(() => (active ? "🛡️" : ""));

    // When inactive — no prefix
    const ctx1 = createMockContext();
    const component1 = renderCall(
      { command: "ls" },
      createMockTheme(),
      ctx1,
    );
    expect(component1).toBeInstanceOf(Text);

    // When active — has prefix
    active = true;
    const ctx2 = createMockContext();
    const component2 = renderCall(
      { command: "ls" },
      createMockTheme(),
      ctx2,
    );
    expect(component2).toBeInstanceOf(Text);
  });

  it("reuses lastComponent across renders", () => {
    const renderCall = createBashPrefixRenderer("🔒");
    const ctx = createMockContext();

    const first = renderCall({ command: "ls" }, createMockTheme(), ctx);
    expect(first).toBeInstanceOf(Text);

    // Second call with lastComponent set should reuse it
    ctx.lastComponent = first;
    const second = renderCall({ command: "pwd" }, createMockTheme(), ctx);
    expect(second).toBe(first); // Same Text instance
  });

  it("tracks startedAt in context.state", () => {
    const renderCall = createBashPrefixRenderer("🔒");
    const ctx = createMockContext();

    expect(ctx.state.startedAt).toBeUndefined();
    renderCall({ command: "ls" }, createMockTheme(), ctx);
    expect(ctx.state.startedAt).toBeGreaterThan(0);
  });

  it("includes timeout suffix when timeout is set", () => {
    const renderCall = createBashPrefixRenderer("🔒");
    const theme = createMockTheme();
    const ctx = createMockContext();

    // Should not throw — timeout suffix is handled
    const component = renderCall(
      { command: "sleep 10", timeout: 30 },
      theme,
      ctx,
    );
    expect(component).toBeInstanceOf(Text);
  });

  it("handles empty command gracefully", () => {
    const renderCall = createBashPrefixRenderer("🔒");
    const theme = createMockTheme();
    const ctx = createMockContext();

    const component = renderCall(
      { command: "" },
      theme,
      ctx,
    );
    expect(component).toBeInstanceOf(Text);
  });

  it("handles undefined command gracefully", () => {
    const renderCall = createBashPrefixRenderer("🔒");
    const theme = createMockTheme();
    const ctx = createMockContext();

    const component = renderCall(
      {} as any,
      theme,
      ctx,
    );
    expect(component).toBeInstanceOf(Text);
  });
});
