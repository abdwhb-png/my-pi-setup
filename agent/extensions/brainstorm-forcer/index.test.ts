import { describe, expect, it, mock } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { default: brainstormForcer } = await import("./index");

async function expectRejection(promise: Promise<unknown>, message: string): Promise<void> {
  let actual = "";
  try {
    await promise;
  } catch (error) {
    actual = error instanceof Error ? error.message : String(error);
  }
  expect(actual).toContain(message);
}

function createMockAPI() {
  const commands = new Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>();
  const tools = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => any>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const renderers = new Map<string, any>();
  const sentUserMessages: Array<{ content: unknown; options?: unknown }> = [];
  const sentMessages: Array<{ message: unknown; options?: unknown }> = [];
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
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (event: string, handler: any) => handlers.set(event, handler),
    appendEntry: (customType: string, data?: unknown) => entries.push({ customType, data }),
    registerMessageRenderer: (customType: string, renderer: any) => renderers.set(customType, renderer),
    sendUserMessage: (content: unknown, options?: unknown) => sentUserMessages.push({ content, options }),
    sendMessage: (message: unknown, options?: unknown) => sentMessages.push({ message, options }),
    getAllTools: () => toolInfo,
    events: { emit: mock(() => undefined) },
  } as unknown as ExtensionAPI;

  return { pi, commands, tools, handlers, entries, renderers, sentUserMessages, sentMessages };
}

function createMockContext(
  sessionEntries?: Array<{ type: string; customType?: string; data?: unknown }>,
  cwd = process.cwd(),
) {
  const entries = sessionEntries ?? [];
  return {
    cwd,
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
      select: mock(async () => "Approve"),
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
    expect(handlers.has("context")).toBe(true);
    expect(renderers.has("brainstorm-forcer")).toBe(true);
  });

  it("registers one structured artifact submission tool per phase", () => {
    const { pi, tools } = createMockAPI();
    brainstormForcer(pi);
    expect([...tools.keys()].filter((name) => name.startsWith("brainstorm_submit_"))).toEqual([
      "brainstorm_submit_discovery",
      "brainstorm_submit_understanding",
      "brainstorm_submit_exploring",
      "brainstorm_submit_presenting",
      "brainstorm_submit_design",
    ]);
  });

  it("writes discovery content directly through its phase tool", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-tool-"));
    try {
      const { pi, tools, commands } = createMockAPI();
      const ctx = createMockContext(undefined, projectRoot);
      brainstormForcer(pi);
      await commands.get("brainstorm")!.handler("Safer workflow", ctx);

      const result = await tools.get("brainstorm_submit_discovery")!.execute(
        "call-1",
        {
          filesAccessed: ["agent/extensions/brainstorm-forcer/index.ts"],
          keyFindings: ["Transitions are user commands only."],
          gaps: ["No LLM transition tool."],
        },
        undefined,
        undefined,
        ctx,
      );

      const path = result.details.artifact.path as string;
      expect(path).toMatch(/docs\/brainstorms\/.+\/01-discovery-r001\.md$/);
      expect(await readFile(join(projectRoot, path), "utf8")).toContain("## Key Findings\n\n- Transitions are user commands only.");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("writes each remaining phase through its matching structured tool", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-tools-"));
    try {
      const { pi, tools, commands } = createMockAPI();
      const ctx = createMockContext(undefined, projectRoot);
      brainstormForcer(pi);
      const command = commands.get("brainstorm")!;
      await command.handler("Artifact workflow", ctx);

      const submissions = [
        [
          "understanding",
          "brainstorm_submit_understanding",
          {
            objective: "Control brainstorming phases.",
            requirements: ["One phase at a time."],
            constraints: ["No planning."],
            successCriteria: ["Every phase leaves an artifact."],
            openQuestions: [],
          },
          "02-understanding-r001.md",
        ],
        [
          "exploring",
          "brainstorm_submit_exploring",
          {
            approaches: [
              {
                title: "Dedicated tools",
                summary: "One schema per phase.",
                tradeoffs: ["More tools."],
                uncertainties: ["Model compliance."],
                failureConditions: ["Wrong phase tool accepted."],
              },
              {
                title: "Generic tool",
                summary: "One loose schema.",
                tradeoffs: ["Less validation."],
                uncertainties: [],
                failureConditions: ["Malformed artifact."],
              },
            ],
            recommendation: "Dedicated tools",
            userChoice: "Dedicated tools",
          },
          "03-exploring-r001.md",
        ],
        [
          "presenting",
          "brainstorm_submit_presenting",
          {
            sections: [{ title: "Architecture", content: "State machine plus artifact store.", feedback: "Approved." }],
            decisions: ["Use project files."],
            approved: true,
          },
          "04-presenting-r001.md",
        ],
        [
          "documenting",
          "brainstorm_submit_design",
          {
            title: "Controlled brainstorming",
            summary: "Persist every phase without choosing a planning workflow.",
            sections: [{ title: "Architecture", content: "Tools submit versioned artifacts." }],
            decisions: ["Stop after design."],
            residualRisks: ["LLM content quality remains probabilistic."],
          },
          "05-design-r001.md",
        ],
      ] as const;

      for (const [phase, toolName, params, expectedSuffix] of submissions) {
        await command.handler(`phase ${phase}`, ctx);
        const result = await tools.get(toolName)!.execute("call", params, undefined, undefined, ctx);
        expect(result.details.artifact.path).toEndWith(expectedSuffix);
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("lets the LLM move only between adjacent phases after submitting the current artifact", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-transition-"));
    try {
      const { pi, tools, commands, sentMessages } = createMockAPI();
      const ctx = createMockContext(undefined, projectRoot);
      brainstormForcer(pi);
      await commands.get("brainstorm")!.handler("Controlled transitions", ctx);
      await tools.get("brainstorm_submit_discovery")!.execute(
        "artifact",
        { filesAccessed: ["index.ts"], keyFindings: ["No transition tool."], gaps: [] },
        undefined,
        undefined,
        ctx,
      );

      const transition = tools.get("brainstorm_transition")!;
      const advanced = await transition.execute("next", { action: "next" }, undefined, undefined, ctx);
      expect(ctx.ui.select).toHaveBeenCalledWith(
        "Approve brainstorm transition: Discovery → Understanding?",
        ["Approve", "Reject", "Reject with reason"],
      );
      expect(advanced.details).toMatchObject({ phase: "understanding", completed: false, approved: true });
      expect(sentMessages.at(-1)).toMatchObject({
        message: { customType: "brainstorm-forcer-transition" },
        options: { deliverAs: "steer" },
      });
      const blockedNext = Promise.resolve(transition.execute("next-again", { action: "next" }, undefined, undefined, ctx));
      await expectRejection(blockedNext, "Understanding incomplete");

      const returned = await transition.execute("previous", { action: "previous" }, undefined, undefined, ctx);
      expect(returned.details).toMatchObject({ phase: "discovery", completed: false, approved: true });
      expect(ctx.ui.select).toHaveBeenCalledTimes(2);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("reports transition status without asking for approval", async () => {
    const { pi, tools, commands } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    await commands.get("brainstorm")!.handler("Status only", ctx);

    const result = await tools
      .get("brainstorm_transition")!
      .execute("status", { action: "status" }, undefined, undefined, ctx);
    expect(result.details).toMatchObject({ phase: "discovery", completed: false });
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("keeps the current phase and requires a revised artifact after a plain rejection", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-rejection-"));
    try {
      const { pi, tools, commands, sentMessages } = createMockAPI();
      const ctx = createMockContext(undefined, projectRoot);
      (ctx.ui.select as any).mockResolvedValue("Reject");
      brainstormForcer(pi);
      await commands.get("brainstorm")!.handler("Rejected transition", ctx);
      const discovery = tools.get("brainstorm_submit_discovery")!;
      await discovery.execute(
        "artifact",
        { filesAccessed: ["index.ts"], keyFindings: ["Initial finding."], gaps: [] },
        undefined,
        undefined,
        ctx,
      );

      const transition = tools.get("brainstorm_transition")!;
      const rejected = await transition.execute("next", { action: "next" }, undefined, undefined, ctx);
      expect(rejected.details).toMatchObject({ phase: "discovery", completed: false, approved: false });
      expect(rejected.content[0].text).toContain("Refine the current phase");
      expect(sentMessages.at(-1)).toMatchObject({
        message: { customType: "brainstorm-forcer-transition-rejected" },
        options: { deliverAs: "steer" },
      });

      await expectRejection(
        Promise.resolve(transition.execute("retry", { action: "next" }, undefined, undefined, ctx)),
        "Refine the current phase",
      );
      expect(ctx.ui.select).toHaveBeenCalledTimes(1);

      await discovery.execute(
        "revision",
        { filesAccessed: ["index.ts"], keyFindings: ["Deeper validated finding."], gaps: [] },
        undefined,
        undefined,
        ctx,
      );
      (ctx.ui.select as any).mockResolvedValue("Approve");
      const advanced = await transition.execute("next-after-revision", { action: "next" }, undefined, undefined, ctx);
      expect(advanced.details).toMatchObject({ phase: "understanding", approved: true });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("uses the optional custom rejection reason", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-rejection-reason-"));
    try {
      const { pi, tools, commands, sentMessages } = createMockAPI();
      const ctx = createMockContext(undefined, projectRoot);
      (ctx.ui.select as any).mockResolvedValue("Reject with reason");
      (ctx.ui.input as any).mockResolvedValue("Validate claims against primary sources.");
      brainstormForcer(pi);
      await commands.get("brainstorm")!.handler("Reasoned rejection", ctx);
      await tools.get("brainstorm_submit_discovery")!.execute(
        "artifact",
        { filesAccessed: ["index.ts"], keyFindings: ["Unverified finding."], gaps: [] },
        undefined,
        undefined,
        ctx,
      );

      const rejected = await tools
        .get("brainstorm_transition")!
        .execute("next", { action: "next" }, undefined, undefined, ctx);
      expect(ctx.ui.input).toHaveBeenCalledWith("Why reject this transition? (optional)");
      expect(rejected.details).toMatchObject({
        phase: "discovery",
        approved: false,
        rejectionReason: "Validate claims against primary sources.",
      });
      expect(sentMessages.at(-1)?.message).toMatchObject({
        content: expect.stringContaining("Validate claims against primary sources."),
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("uses the default refinement reason when optional input is empty", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-empty-reason-"));
    try {
      const { pi, tools, commands } = createMockAPI();
      const ctx = createMockContext(undefined, projectRoot);
      (ctx.ui.select as any).mockResolvedValue("Reject with reason");
      (ctx.ui.input as any).mockResolvedValue("   ");
      brainstormForcer(pi);
      await commands.get("brainstorm")!.handler("Empty rejection reason", ctx);
      await tools.get("brainstorm_submit_discovery")!.execute(
        "artifact",
        { filesAccessed: ["index.ts"], keyFindings: ["Initial finding."], gaps: [] },
        undefined,
        undefined,
        ctx,
      );

      const rejected = await tools
        .get("brainstorm_transition")!
        .execute("next", { action: "next" }, undefined, undefined, ctx);
      expect(rejected.details.rejectionReason).toContain("Refine the current phase");
      expect(rejected.content[0].text).toContain("investigate remaining gaps");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("finishes after the final design without starting planning", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-complete-"));
    try {
      const { pi, tools, commands, handlers } = createMockAPI();
      const ctx = createMockContext(undefined, projectRoot);
      brainstormForcer(pi);
      await commands.get("brainstorm")!.handler("Design only", ctx);
      await commands.get("brainstorm")!.handler("phase documenting", ctx);
      await tools.get("brainstorm_submit_design")!.execute(
        "design",
        {
          title: "Design only",
          summary: "Final design artifact.",
          sections: [{ title: "Architecture", content: "Controlled state machine." }],
          decisions: ["No planning."],
          residualRisks: [],
        },
        undefined,
        undefined,
        ctx,
      );

      const result = await tools.get("brainstorm_transition")!.execute("complete", { action: "next" }, undefined, undefined, ctx);
      expect(result.details).toEqual({ phase: null, completed: true, approved: true });
      expect(result.content[0].text).toContain("No planning workflow was started");
      expect((await handlers.get("context")!({ messages: [] }, ctx)).messages).toHaveLength(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("uses the same completion behavior for /brainstorm next", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-command-complete-"));
    try {
      const { pi, tools, commands, handlers } = createMockAPI();
      const ctx = createMockContext(undefined, projectRoot);
      brainstormForcer(pi);
      const command = commands.get("brainstorm")!;
      await command.handler("Command completion", ctx);
      await command.handler("phase documenting", ctx);
      await tools.get("brainstorm_submit_design")!.execute(
        "design",
        {
          title: "Command completion",
          summary: "Final design.",
          sections: [{ title: "Architecture", content: "Shared transition engine." }],
          decisions: ["Stop after design."],
          residualRisks: [],
        },
        undefined,
        undefined,
        ctx,
      );

      await command.handler("next", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No planning workflow was started"), "info");
      expect((await handlers.get("context")!({ messages: [] }, ctx)).messages).toHaveLength(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("injects exactly one current brainstorm status before every LLM call", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-context-"));
    try {
      const { pi, commands, handlers } = createMockAPI();
      const ctx = createMockContext(undefined, projectRoot);
      brainstormForcer(pi);
      await commands.get("brainstorm")!.handler("Persistent context", ctx);
      const context = handlers.get("context")!;

      const first = await context({ messages: [] }, ctx);
      expect(first.messages).toHaveLength(1);
      expect(first.messages[0]).toMatchObject({ role: "custom", customType: "brainstorm-forcer-status", display: false });
      expect(first.messages[0].content).toContain("brainstorm_submit_discovery");
      expect(first.messages[0].content).toContain("docs/brainstorms/");

      const second = await context({ messages: first.messages }, ctx);
      expect(second.messages.filter((message: any) => message.customType === "brainstorm-forcer-status")).toHaveLength(1);

      await commands.get("brainstorm")!.handler("stop", ctx);
      const stopped = await context({ messages: second.messages }, ctx);
      expect(stopped.messages).toHaveLength(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("restores phase artifacts and status after session reload", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-restore-"));
    try {
      const first = createMockAPI();
      const firstContext = createMockContext(undefined, projectRoot);
      brainstormForcer(first.pi);
      await first.commands.get("brainstorm")!.handler("Reloadable workflow", firstContext);
      await first.tools.get("brainstorm_submit_discovery")!.execute(
        "artifact",
        { filesAccessed: ["index.ts"], keyFindings: ["State is persisted."], gaps: [] },
        undefined,
        undefined,
        firstContext,
      );
      const saved = first.entries.at(-1)!;
      expect(saved.data).toMatchObject({ phase: "discovery", startedAt: expect.any(String) });

      const second = createMockAPI();
      const secondContext = createMockContext([{ type: "custom", customType: saved.customType, data: saved.data }], projectRoot);
      brainstormForcer(second.pi);
      await second.handlers.get("session_start")!({}, secondContext);
      const status = await second.handlers.get("context")!({ messages: [] }, secondContext);
      expect(status.messages[0].content).toContain("01-discovery-r001.md");
      expect(status.messages[0].content).toContain("Phase: Discovery");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("lists durable artifact revisions through /brainstorm artifacts", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-list-"));
    try {
      const { pi, commands, tools } = createMockAPI();
      const ctx = createMockContext(undefined, projectRoot);
      brainstormForcer(pi);
      const command = commands.get("brainstorm")!;
      await command.handler("Inspectable artifacts", ctx);
      await tools.get("brainstorm_submit_discovery")!.execute(
        "artifact",
        { filesAccessed: ["index.ts"], keyFindings: ["Durable files."], gaps: [] },
        undefined,
        undefined,
        ctx,
      );

      await command.handler("artifacts", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("01-discovery-r001.md"), "info");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("provides argument completions like sandbox-style commands", () => {
    const { pi, commands } = createMockAPI();
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

    expect(cmd.getArgumentCompletions("next ")).toBeNull();
    expect(cmd.getArgumentCompletions("previous ")).toBeNull();
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

  it("allows dedicated research tools but blocks generic shell access in discovery", async () => {
    const { pi, handlers, commands } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    await commands.get("brainstorm")!.handler("topic", ctx);
    const toolCall = handlers.get("tool_call")!;
    expect(await toolCall({ toolName: "hypa_find" }, ctx)).toBeUndefined();
    expect(await toolCall({ toolName: "hypa_ls" }, ctx)).toBeUndefined();
    expect(await toolCall({ toolName: "read" }, ctx)).toBeUndefined();
    expect((await toolCall({ toolName: "bash" }, ctx)).block).toBe(true);
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

  it("blocks generic mutation and planning tools even during Documenting", async () => {
    const { pi, handlers, commands } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    const cmd = commands.get("brainstorm")!;
    await cmd.handler("topic", ctx);
    await cmd.handler("phase documenting", ctx);
    const toolCall = handlers.get("tool_call")!;

    for (const toolName of ["write", "edit", "bash", "safe_bash", "session_plan", "write_plan", "edit_plan"]) {
      expect((await toolCall({ toolName }, ctx)).block).toBe(true);
    }
    expect(await toolCall({ toolName: "brainstorm_submit_design" }, ctx)).toBeUndefined();
    expect(await toolCall({ toolName: "brainstorm_transition" }, ctx)).toBeUndefined();
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

  it("/brainstorm next advances after the phase artifact exists", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-command-"));
    try {
      const { pi, commands, tools } = createMockAPI();
      const ctx = createMockContext(undefined, projectRoot);
      brainstormForcer(pi);
      const cmd = commands.get("brainstorm")!;
      await cmd.handler("topic", ctx);
      await tools.get("brainstorm_submit_discovery")!.execute(
        "artifact",
        { filesAccessed: ["index.ts"], keyFindings: ["Artifact gate."], gaps: [] },
        undefined,
        undefined,
        ctx,
      );
      await cmd.handler("next", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Advanced to Understanding"), "info");
      expect(ctx.ui.select).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
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

  it("/brainstorm previous returns one phase and /brainstorm phase handles explicit jumps", async () => {
    const { pi, commands } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    const cmd = commands.get("brainstorm")!;
    await cmd.handler("topic", ctx);
    await cmd.handler("phase exploring", ctx);
    await cmd.handler("previous", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Returned to Understanding"), "info");
    await cmd.handler("phase discovery", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Jumped to Discovery"), "info");
  });

  it("requires resolved questions and explicit final approval in submitted artifacts", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-gates-"));
    try {
      const { pi, commands, tools } = createMockAPI();
      const ctx = createMockContext(undefined, projectRoot);
      brainstormForcer(pi);
      const command = commands.get("brainstorm")!;
      const transition = tools.get("brainstorm_transition")!;
      await command.handler("topic", ctx);
      await command.handler("phase understanding", ctx);
      const baseUnderstanding = {
        objective: "Understand scope.",
        requirements: ["Artifacts."],
        constraints: ["No planning."],
        successCriteria: ["Explicit phase gates."],
      };
      await tools.get("brainstorm_submit_understanding")!.execute(
        "open",
        { ...baseUnderstanding, openQuestions: ["Which format?"] },
        undefined,
        undefined,
        ctx,
      );
      const blockedUnderstanding = Promise.resolve(transition.execute("blocked", { action: "next" }, undefined, undefined, ctx));
      await expectRejection(blockedUnderstanding, "open questions remain");
      await tools.get("brainstorm_submit_understanding")!.execute(
        "closed",
        { ...baseUnderstanding, openQuestions: [] },
        undefined,
        undefined,
        ctx,
      );
      expect((await transition.execute("advance", { action: "next" }, undefined, undefined, ctx)).details.phase).toBe("exploring");

      await command.handler("phase presenting", ctx);
      const presentation = {
        sections: [{ title: "Architecture", content: "State machine." }],
        decisions: ["Dedicated tools."],
      };
      await tools.get("brainstorm_submit_presenting")!.execute(
        "unapproved",
        { ...presentation, approved: false },
        undefined,
        undefined,
        ctx,
      );
      const blockedPresentation = Promise.resolve(transition.execute("blocked", { action: "next" }, undefined, undefined, ctx));
      await expectRejection(blockedPresentation, "approval is missing");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
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
    expect(result.systemPrompt).toContain("brainstorm_submit_discovery");
    expect(result.systemPrompt).toContain("brainstorm_transition");
    expect(result.systemPrompt).toContain("explicit user approval");
    expect(result.systemPrompt).toContain("Do not start the next phase before the transition succeeds");
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

  it("blocked mutation tool appends blockFeedback entry", async () => {
    const { pi, handlers, commands, entries } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    await commands.get("brainstorm")!.handler("topic", ctx);
    const toolCall = handlers.get("tool_call")!;
    const result = await toolCall({ toolName: "write" }, ctx);
    expect(result.block).toBe(true);
    expect(result.reason).toContain("BLOCKED");
    // Simulate Pi returning the blocked tool result
    await handlers.get("tool_result")!({ toolName: "write", isError: true }, ctx);
    // Should have appended blockFeedback entry
    const feedbackEntry = entries.find((e: any) => e.data?.blockFeedback);
    expect(feedbackEntry).toBeTruthy();
    expect((feedbackEntry!.data as any).blockFeedback.tool).toBe("write");
    expect((feedbackEntry!.data as any).blockFeedback.phase).toBe("discovery");
  });
});
