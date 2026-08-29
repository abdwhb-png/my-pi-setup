import { describe, expect, it, mock } from "bun:test";
import { statusText } from "../openai-codex-fast-mode.ts";

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

function createCtx(model?: any) {
  return {
    hasUI: true,
    model,
    ui: {
      notify: mock(() => undefined),
      setStatus: mock(() => undefined),
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
    const ctx = createCtx({ provider: "openai-codex", id: "gpt-5.6-sol" });
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

  it("shows status on session start only if model is an OpenAI model", async () => {
    const { pi, handlers } = createMockAPI();
    const openAICtx = createCtx({ provider: "openai-codex", id: "gpt-5.6-sol" });
    codexFastMode(pi);

    const sessionStartHandler = handlers.get("session_start")?.[0];
    expect(sessionStartHandler).toBeDefined();

    await sessionStartHandler({}, openAICtx);
    expect(openAICtx.ui.setStatus).toHaveBeenCalledWith("codex-fast-mode", statusText(false));

    const nonOpenAICtx = createCtx({ provider: "anthropic", id: "claude-3-5-sonnet" });
    await sessionStartHandler({}, nonOpenAICtx);
    expect(nonOpenAICtx.ui.setStatus).toHaveBeenCalledWith("codex-fast-mode", undefined);
  });

  it("hides status for OpenAI-compatible proxies routed via other providers", async () => {
    const { pi, handlers } = createMockAPI();
    codexFastMode(pi);

    const sessionStartHandler = handlers.get("session_start")?.[0];

    // CPA proxy models use openai-completions/openai-responses APIs but are
    // NOT OpenAI models — the status must stay hidden.
    const cpaCtx = createCtx({
      provider: "cpa",
      id: "ox-alpha-free",
      api: "openai-responses",
    });
    await sessionStartHandler({}, cpaCtx);
    expect(cpaCtx.ui.setStatus).toHaveBeenCalledWith("codex-fast-mode", undefined);

    const zaiCtx = createCtx({
      provider: "zai",
      id: "glm-5.2",
      api: "openai-completions",
    });
    await sessionStartHandler({}, zaiCtx);
    expect(zaiCtx.ui.setStatus).toHaveBeenCalledWith("codex-fast-mode", undefined);
  });

  it("updates status visibility on model_select event", async () => {
    const { pi, handlers, commands } = createMockAPI();
    const ctx = createCtx();
    codexFastMode(pi);

    const modelSelectHandler = handlers.get("model_select")?.[0];
    expect(modelSelectHandler).toBeDefined();

    // Select OpenAI model -> status becomes visible
    await modelSelectHandler({ model: { provider: "openai", id: "gpt-4o" } }, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("codex-fast-mode",statusText(false));

    // Enable fast mode
    await commands.get("codex-fast-mode").handler("on", ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("codex-fast-mode", statusText(true));

    // Switch to non-OpenAI model -> status is hidden
    await modelSelectHandler({ model: { provider: "anthropic", id: "claude-3-5-sonnet" } }, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("codex-fast-mode", undefined);

    // Switch back to OpenAI Codex model -> status reappears as on
    await modelSelectHandler({ model: { provider: "openai-codex", id: "gpt-5.6-sol" } }, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("codex-fast-mode", statusText(true));
  });

  it("clears status on session shutdown", async () => {
    const { pi, handlers } = createMockAPI();
    const ctx = createCtx({ provider: "openai-codex", id: "gpt-5.6-sol" });
    codexFastMode(pi);

    const shutdownHandler = handlers.get("session_shutdown")?.[0];
    expect(shutdownHandler).toBeDefined();

    await shutdownHandler({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("codex-fast-mode", undefined);
  });
});