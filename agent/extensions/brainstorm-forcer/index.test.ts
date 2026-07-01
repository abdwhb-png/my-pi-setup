import { describe, expect, it, mock } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const { default: brainstormForcer } = await import("./index");

function createMockAPI() {
  const commands = new Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>();
  const handlers = new Map<string, (...args: any[]) => any>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const renderers = new Map<string, any>();
  const sentUserMessages: Array<{ content: unknown; options?: unknown }> = [];
  const toolInfo = [
    { name: "read" },
    { name: "grep" },
    { name: "find" },
    { name: "ls" },
    { name: "bash" },
    { name: "write" },
    { name: "edit" },
    { name: "ask_user_question" },
    { name: "hypa_find" },
    { name: "hypa_ls" },
  ];

  const pi = {
    registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
    on: (event: string, handler: any) => handlers.set(event, handler),
    appendEntry: (customType: string, data?: unknown) => entries.push({ customType, data }),
    registerMessageRenderer: (customType: string, renderer: any) => renderers.set(customType, renderer),
    sendUserMessage: (content: unknown, options?: unknown) => sentUserMessages.push({ content, options }),
    getAllTools: () => toolInfo,
    events: { emit: mock(() => undefined) },
  } as unknown as ExtensionAPI;

  return { pi, commands, handlers, entries, renderers, sentUserMessages };
}

function createMockContext(sessionEntries?: Array<{ type: string; customType?: string; data?: unknown }>) {
  const entries = sessionEntries ?? [];
  return {
    hasUI: true,
    isIdle: () => true,
    signal: undefined as any,
    ui: {
      theme: {
        fg: (_c: string, t: string) => t,
        bold: (t: string) => t,
        bg: (_c: string, t: string) => t,
      } as any,
      notify: mock(() => undefined),
      setStatus: mock(() => undefined),
      setWidget: mock(() => undefined),
      custom: mock(() => undefined),
      confirm: mock(async () => true),
      select: mock(async () => "yes"),
      input: mock(async () => ""),
    } as any,
    sessionManager: {
      getEntries: () => entries,
    } as any,
  } as unknown as ExtensionContext;
}

describe("brainstorm-forcer redesign", () => {
  it("registers command, hooks, and renderer", () => {
    const { pi, commands, handlers, renderers } = createMockAPI();
    brainstormForcer(pi);
    expect(commands.has("brainstorm")).toBe(true);
    expect(handlers.has("resources_discover")).toBe(true);
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("tool_call")).toBe(true);
    expect(handlers.has("tool_result")).toBe(true);
    expect(handlers.has("message_end")).toBe(true);
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(renderers.has("brainstorm-forcer")).toBe(true);
  });

  it("provides argument completions like sandbox-style commands", async () => {
    const { pi, commands } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    const cmd = commands.get("brainstorm")! as any;

    const all = cmd.getArgumentCompletions("");
    expect(Array.isArray(all)).toBe(true);
    expect(all.some((item: any) => item.value === "status")).toBe(true);
    expect(all.some((item: any) => item.value === "next")).toBe(true);
    expect(all.some((item: any) => item.value === "previous")).toBe(true);
    expect(all.some((item: any) => item.value === "arm ")).toBe(true);
    expect(all.some((item: any) => item.value === "phase discovery")).toBe(true);

    const filtered = cmd.getArgumentCompletions("sta");
    expect(filtered).toHaveLength(2);
    expect(filtered[0]).toMatchObject({ value: "status" });
    expect(filtered[1]).toMatchObject({ value: "start " });

    await cmd.handler("topic", ctx);
    await cmd.handler("force-next", ctx); // understanding
    const nextFiltered = cmd.getArgumentCompletions("next ");
    expect(nextFiltered.some((item: any) => item.value === "next exploring")).toBe(true);
    const previousFiltered = cmd.getArgumentCompletions("previous ");
    expect(previousFiltered.some((item: any) => item.value === "previous discovery")).toBe(true);
  });

  it("/brainstorm <topic> starts immediately and sends user message", async () => {
    const { pi, commands, sentUserMessages, entries } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    await commands.get("brainstorm")!.handler("fix footer status", ctx);
    expect(sentUserMessages).toHaveLength(1);
    expect(sentUserMessages[0]!.content).toBe("fix footer status");
    expect(entries[0]!.data).toMatchObject({
      active: true,
      phase: "discovery",
      topic: { raw: "fix footer status", display: "fix footer status" },
    });
  });

  it("/brainstorm arm <topic> arms only without sending user message", async () => {
    const { pi, commands, sentUserMessages } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    await commands.get("brainstorm")!.handler("arm diagnose footer", ctx);
    expect(sentUserMessages).toHaveLength(0);
  });

  it("uses shortened topic for notify/footer while sending raw topic to model", async () => {
    const { pi, commands, sentUserMessages, handlers } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    await handlers.get("session_start")!({}, ctx);
    const longTopic = "you see the forked pi-roles package ? I dont get why the status displayed is Intent not defined - role and I want something more useful";
    await commands.get("brainstorm")!.handler(longTopic, ctx);
    expect(sentUserMessages[0]!.content).toBe(longTopic);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Brainstorm started: Discovery (1/5)", "info");
    const widgetCall = (ctx.ui.setWidget as any).mock.calls.at(-1);
    expect(widgetCall[0]).toBe("brainstorm-forcer");
    expect(widgetCall[1][0]).toContain("Discovery");
    expect(widgetCall[1][0].length).toBeLessThan(longTopic.length + 20);
  });

  it("resources_discover registers extension dir for bundled skill discovery", async () => {
    const { pi, handlers } = createMockAPI();
    brainstormForcer(pi);
    const result = await handlers.get("resources_discover")!({ type: "resources_discover", reason: "startup" }, createMockContext());
    expect(result.skillPaths).toHaveLength(1);
    expect(result.skillPaths[0]).toMatch(/brainstorm-forcer\/skills$/);
  });

  it("dynamic tool groups allow hypa research tools in discovery", async () => {
    const { pi, handlers, commands } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    await commands.get("brainstorm")!.handler("topic", ctx);
    const toolCall = handlers.get("tool_call")!;
    expect(await toolCall({ toolName: "hypa_find" }, ctx)).toBeUndefined();
    expect(await toolCall({ toolName: "hypa_ls" }, ctx)).toBeUndefined();
    expect(await toolCall({ toolName: "read" }, ctx)).toBeUndefined();
    expect(await toolCall({ toolName: "bash" }, ctx)).toBeUndefined();
  });

  it("discovery blocks only mutation tools, not research/question/unknown non-mutating tools", async () => {
    const { pi, handlers, commands } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    await commands.get("brainstorm")!.handler("topic", ctx);
    const toolCall = handlers.get("tool_call")!;
    const blocked = await toolCall({ toolName: "write" }, ctx);
    expect(blocked.block).toBe(true);
    expect(await toolCall({ toolName: "ask_user_question" }, ctx)).toBeUndefined();
    expect(await toolCall({ toolName: "web_search" }, ctx)).toBeUndefined();
  });

  it("exploring allows any non-mutating tools, but blocks mutation", async () => {
    const { pi, handlers, commands } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    const cmd = commands.get("brainstorm")!;
    await cmd.handler("topic", ctx);
    await cmd.handler("phase exploring", ctx);
    const toolCall = handlers.get("tool_call")!;
    expect(await toolCall({ toolName: "read" }, ctx)).toBeUndefined();
    expect(await toolCall({ toolName: "ask_user_question" }, ctx)).toBeUndefined();
    expect(await toolCall({ toolName: "web_search" }, ctx)).toBeUndefined();
    const blocked = await toolCall({ toolName: "edit" }, ctx);
    expect(blocked.block).toBe(true);
  });

  it("/brainstorm next is blocked until discovery evidence exists", async () => {
    const { pi, commands } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    const cmd = commands.get("brainstorm")!;
    await cmd.handler("topic", ctx);
    await cmd.handler("next", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Discovery incomplete"), "warning");
  });

  it("/brainstorm next advances after evidence exists", async () => {
    const { pi, commands, handlers } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    const cmd = commands.get("brainstorm")!;
    await cmd.handler("topic", ctx);
    await handlers.get("tool_result")!({ toolName: "read" }, ctx);
    await cmd.handler("next", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Advanced to Understanding"), "info");
  });

  it("/brainstorm force-next bypasses completion checks (deprecated alias)", async () => {
    const { pi, commands } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    const cmd = commands.get("brainstorm")!;
    await cmd.handler("topic", ctx);
    await cmd.handler("force-next", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Force-advanced to Understanding"), "warning");
  });

  it("/brainstorm next --force bypasses completion blocker", async () => {
    const { pi, commands } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    const cmd = commands.get("brainstorm")!;
    await cmd.handler("topic", ctx);
    await cmd.handler("next --force", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Advanced to Understanding (2/5) (forced)"), "warning");
  });

  it("/brainstorm next exploring --force skips blocker", async () => {
    const { pi, commands } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    const cmd = commands.get("brainstorm")!;
    await cmd.handler("topic", ctx);
    await cmd.handler("next exploring --force", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Advanced to Exploring"), "warning");
  });

  it("/brainstorm previous returns to previous or specified earlier phase", async () => {
    const { pi, commands, handlers } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    const cmd = commands.get("brainstorm")!;
    await cmd.handler("topic", ctx);
    await handlers.get("tool_result")!({ toolName: "read" }, ctx);
    await cmd.handler("next", ctx); // understanding
    await cmd.handler("force-next", ctx); // exploring
    await cmd.handler("previous", ctx); // back to understanding
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Returned to Understanding"), "info");
    await cmd.handler("previous discovery --force", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Returned to Discovery"), "warning");
  });

  it("tool_result tracks research + question evidence", async () => {
    const { pi, handlers, commands } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    await commands.get("brainstorm")!.handler("topic", ctx);
    await handlers.get("tool_result")!({ toolName: "read" }, ctx);
    await handlers.get("tool_result")!({ toolName: "hypa_ls" }, ctx);
    await handlers.get("tool_result")!({ toolName: "ask_user_question" }, ctx);
    await commands.get("brainstorm")!.handler("status", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Research calls: 1"), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Questions: 1"), "info");
  });

  it("message_end tracks assistant turns by phase", async () => {
    const { pi, handlers, commands } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    const cmd = commands.get("brainstorm")!;
    await cmd.handler("topic", ctx);
    await handlers.get("tool_result")!({ toolName: "read" }, ctx);
    await cmd.handler("next", ctx); // understanding
    await cmd.handler("force-next", ctx); // exploring
    await handlers.get("message_end")!({ message: { role: "assistant", content: [] } }, ctx);
    await cmd.handler("next", ctx); // should now advance because exploring got an assistant turn
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Advanced to Presenting"), "info");
  });

  it("before_agent_start injects system prompt + custom message", async () => {
    const { pi, handlers, commands } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    await commands.get("brainstorm")!.handler("topic", ctx);
    const result = await handlers.get("before_agent_start")!(
      { systemPrompt: "BASE", prompt: "topic", images: undefined, systemPromptOptions: {} },
      ctx,
    );
    expect(result.systemPrompt).toContain("Current phase: DISCOVERY");
    expect(result.systemPrompt).toContain("bundled skill `brainstorm-forcer`");
    expect(result.message.customType).toBe("brainstorm-forcer");
    expect(result.message.content).toContain("Brainstorm Discovery");
  });

  it("phase widget uses ui-colors path and updates on phase changes", async () => {
    const { pi, commands, handlers } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    await handlers.get("session_start")!({}, ctx);
    const cmd = commands.get("brainstorm")!;
    await cmd.handler("topic", ctx);
    expect(ctx.ui.setWidget).toHaveBeenCalled();
    await cmd.handler("phase exploring", ctx);
    const lastWidgetCall = (ctx.ui.setWidget as any).mock.calls.at(-1);
    expect(lastWidgetCall[0]).toBe("brainstorm-forcer");
    expect(lastWidgetCall[1][0]).toContain("Exploring");
  });

  it("stop clears state and footer", async () => {
    const { pi, commands, entries, handlers } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    await handlers.get("session_start")!({}, ctx);
    const cmd = commands.get("brainstorm")!;
    await cmd.handler("topic", ctx);
    await cmd.handler("stop", ctx);
    expect(entries.at(-1)?.data).toMatchObject({ active: false });
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("brainstorm-forcer", undefined);
  });
});
