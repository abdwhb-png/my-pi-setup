import { useIsolatedAgentDir } from "../_shared/testing/config-fixture.ts";
import { describe, expect, it, mock } from "bun:test";
import { buildSessionTokenContent } from "../_shared/status-segments.ts";
import { createUiColors } from "../_shared/ui/ui-colors.ts";

/**
 * Mock the _shared/fancy-footer wrapper (what the extension actually imports)
 * rather than the low-level pi-fancy-footer/api. This isolates the test from
 * cross-file mock pollution (other test files mock pi-fancy-footer/api with
 * minimal stubs that would break this module's re-export chain).
 *
 * Captures every widget def passed to createWidget — one entry per call.
 */
useIsolatedAgentDir();

const widgetDefs: any[] = [];
const fakeHandle = {
  active: true,
  update: mock(() => undefined),
  remove: mock(() => undefined),
};

mock.module("../_shared/fancy-footer", () => ({
  createWidget: mock((_pi: any, def: any) => {
    widgetDefs.push(def);
    return fakeHandle;
  }),
  getSessionUsageMetrics: mock(() => ({
    latest: { input: 100, output: 20, cacheRead: 3, cacheWrite: 1, cost: 0.01 },
    total: { input: 1000, output: 200, cacheRead: 30, cacheWrite: 10 },
    totalCost: 0.02,
  })),
}));

const { default: sessionFactory } = await import("../session-status-bar.ts");

function createMockPi() {
  const handlers = new Map<string, any[]>();
  return {
    pi: {
      events: { on: mock(), emit: mock() },
      on: (event: string, handler: any) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    } as any,
    handlers,
  };
}

function createMockCtx() {
  return {
    hasUI: true,
    cwd: "/home/user/repo",
    model: { id: "claude-sonnet-4", provider: "anthropic", contextWindow: 200000 },
    ui: { theme: { fg: (_c: string, t: string) => t } },
    sessionManager: {
      getBranch: () => [],
      getSessionName: () => "test-session",
    },
  } as any;
}

describe("session-status-bar extension wiring", () => {
  it("exports a factory function", () => {
    expect(typeof sessionFactory).toBe("function");
  });

  it("registers seven positioned widgets with correct align + order", async () => {
    widgetDefs.length = 0;
    const { pi, handlers } = createMockPi();
    sessionFactory(pi);

    for (const h of handlers.get("session_start") ?? []) {
      await h({}, createMockCtx());
    }
    await Promise.resolve();

    expect(widgetDefs).toHaveLength(7);

    const byId = new Map(widgetDefs.map((w) => [w.id, w]));
    expect(byId.get("session-status-bar.cwd")?.align).toBe("left");
    expect(byId.get("session-status-bar.branch")?.align).toBe("left");
    expect(byId.get("session-status-bar.session")?.align).toBe("left");
    expect(byId.get("session-status-bar.context")?.align).toBe("right");
    expect(byId.get("session-status-bar.tokens")?.align).toBe("right");
    expect(byId.get("session-status-bar.cost")?.align).toBe("right");
    expect(byId.get("session-status-bar.model")?.align).toBe("right");

    expect(byId.get("session-status-bar.session")?.order).toBe(2);
    expect(byId.get("session-status-bar.tokens")?.order).toBe(1);
    expect(byId.get("session-status-bar.model")?.order).toBe(3);

    for (const w of widgetDefs) {
      expect(w.placement).toBe("belowEditor");
      expect(w.styled).toBe(true);
      expect(typeof w.render).toBe("function");
    }
  });

  it("renders cumulative session tokens instead of latest message usage", async () => {
    widgetDefs.length = 0;
    const { pi, handlers } = createMockPi();
    sessionFactory(pi);

    for (const h of handlers.get("session_start") ?? []) {
      await h({}, createMockCtx());
    }

    const tokensWidget = widgetDefs.find((w) => w.id === "session-status-bar.tokens");
    const renderCtx = { theme: { fg: (_c: string, t: string) => t }, width: 120 };
    expect(tokensWidget.render(renderCtx, 80)).toBe(
      buildSessionTokenContent(
        1000,
        200,
        30,
        10,
        createUiColors(renderCtx.theme),
      ),
    );
  });

  it("keeps fallback content when a session label changes", async () => {
    const { pi, handlers } = createMockPi();
    sessionFactory(pi);
    const ctx = createMockCtx();
    for (const handler of handlers.get("session_start") ?? [])
      await handler({}, ctx);
    ctx.sessionManager.getSessionName = () => "Renamed fixture session";
    for (const handler of handlers.get("session_info_changed") ?? [])
      await handler({}, ctx);
    expect(fakeHandle.update).toHaveBeenLastCalledWith(
      ctx,
      expect.stringContaining("Renamed fixture session"),
    );
    for (const handler of handlers.get("session_shutdown") ?? [])
      await handler({}, ctx);
  });

  it("reports unexpected path errors once instead of silently hiding refresh failures", async () => {
    const { pi, handlers } = createMockPi();
    sessionFactory(pi);
    const ctx = createMockCtx();
    ctx.cwd = "/invalid\0path/repo";
    ctx.ui.notify = mock();
    for (const handler of handlers.get("session_start") ?? [])
      await handler({}, ctx);
    for (const handler of handlers.get("agent_end") ?? [])
      await handler({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Session status bar refresh failed:"),
      "warning",
    );
    for (const handler of handlers.get("session_shutdown") ?? [])
      await handler({}, ctx);
  });

  it("render closure produces segment content after state refresh", () => {
    const cwdWidget = widgetDefs.find((w) => w.id === "session-status-bar.cwd");
    const renderCtx = { theme: { fg: (_c: string, t: string) => t }, width: 120 };
    // session_start refreshed latestState, so the closure renders real content.
    expect(cwdWidget.render(renderCtx, 20)).toContain("repo");
  });
});
