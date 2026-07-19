import { describe, expect, it, mock } from "bun:test";

const widgetContributions: any[] = [];
const discoverMock = mock(() => undefined);
const refreshMock = mock(() => undefined);

mock.module("pi-fancy-footer/api", () => ({
  contributeFancyFooterWidgets: mock((_pi: any, provider: any) => {
    widgetContributions.push(provider);
  }),
  requestFancyFooterWidgetDiscovery: discoverMock,
  requestFancyFooterRefresh: refreshMock,
  // _shared/fancy-footer re-exports the extension-statuses surface; provide it
  // so any sibling extension importing the wrapper isn't broken by this mock.
  publishExtensionStatusesSnapshot: mock(() => undefined),
  getExtensionStatusesSnapshot: mock(() => []),
  subscribeExtensionStatusesSnapshot: mock(() => () => {}),
  FANCY_FOOTER_EXTENSION_STATUSES_SNAPSHOT_EVENT:
    "pi-fancy-footer:extension-statuses-snapshot",
}));

const { default: codexFastMode } = await import("../openai-codex-fast-mode.ts");

function createMockAPI() {
  const handlers = new Map<string, any[]>();
  const commands = new Map<string, any>();
  const pi = {
    events: { on: mock(), emit: mock() },
    on: (event: string, handler: any) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand: (name: string, command: any) => commands.set(name, command),
  } as any;
  return { pi, handlers, commands };
}

function createCtx() {
  return {
    hasUI: true,
    ui: {
      notify: mock(() => undefined),
      setWidget: mock(() => undefined),
    },
  } as any;
}

const codexPayload = {
  model: "codex-mini-latest",
  stream: true,
  instructions: "You are coding.",
  input: [],
  tool_choice: "auto",
  prompt_cache_key: "cache-key",
};

describe("openai codex fast mode", () => {
  it("does not inject priority by default", () => {
    const { pi, handlers } = createMockAPI();
    codexFastMode(pi);

    const handler = handlers.get("before_provider_request")?.[0];
    expect(handler({ payload: codexPayload }, createCtx())).toBeUndefined();
  });

  it("toggles priority with slash command and reports status", async () => {
    const { pi, handlers, commands } = createMockAPI();
    const ctx = createCtx();
    codexFastMode(pi);

    expect(commands.has("codex-fast-mode")).toBe(true);
    const command = commands.get("codex-fast-mode");
    const handler = handlers.get("before_provider_request")?.[0];

    await command.handler("on", ctx);
    expect(handler({ payload: codexPayload }, ctx)).toEqual({
      ...codexPayload,
      service_tier: "priority",
    });

    await command.handler("status", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("enabled"),
      "info",
    );

    await command.handler("off", ctx);
    expect(handler({ payload: codexPayload }, ctx)).toBeUndefined();
  });

  it("registers a fancy-footer widget showing current status", async () => {
    widgetContributions.length = 0;
    const { pi, commands } = createMockAPI();
    const ctx = createCtx();
    codexFastMode(pi);

    const widget = widgetContributions.find((entry) => entry.id === "codex-fast-mode");
    expect(widget).toBeDefined();
    expect(widget.render()).toContain("off");

    await commands.get("codex-fast-mode").handler("on", ctx);
    expect(widget.render()).toContain("on");
    expect(refreshMock).toHaveBeenCalled();
  });
});