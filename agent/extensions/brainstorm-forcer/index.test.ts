import { describe, expect, it, mock } from "bun:test";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { resolveSubagentCapabilityCeiling } from "pi-subagents/capability-ceiling";

const {
  default: brainstormForcer,
  createCapabilityCeilingManager,
  preflightVerifierAgents,
} =
  await import("./index");

async function expectRejection(promise: Promise<unknown>, message: string): Promise<void> {
  let actual = "";
  try {
    await promise;
  } catch (error) {
    actual = error instanceof Error ? error.message : String(error);
  }
  expect(actual).toContain(message);
}

function createMockAPI(sessionManager?: SessionManager) {
  const commands = new Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>();
  const tools = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => any>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const renderers = new Map<string, any>();
  const sentUserMessages: Array<{ content: unknown; options?: unknown }> = [];
  const sentMessages: Array<{ message: unknown; options?: unknown }> = [];
  const eventListeners = new Map<string, Set<(data: unknown) => void>>();
  const events = {
    on(event: string, handler: (data: unknown) => void) {
      if (event.startsWith("pi-fancy-footer:"))
        throw new Error("Fancy footer is not installed in this mock.");
      const listeners = eventListeners.get(event) ?? new Set();
      listeners.add(handler);
      eventListeners.set(event, listeners);
      return () => {
        listeners.delete(handler);
        if (listeners.size === 0) eventListeners.delete(event);
      };
    },
    emit(event: string, data: unknown) {
      for (const handler of [...(eventListeners.get(event) ?? [])]) handler(data);
    },
  };
  const toolInfo = [
    { name: "read" },
    { name: "grep" },
    { name: "find" },
    { name: "ls" },
    { name: "bash" },
    { name: "write" },
    { name: "edit" },
    { name: "create_resource", description: "Create a generic resource." },
    { name: "ask_user_question" },
    { name: "hypa_find" },
    { name: "hypa_ls" },
    {
      name: "subagent",
      description: "Delegate work or create, update, and delete agent definitions.",
    },
  ];

  const pi = {
    registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (event: string, handler: any) => handlers.set(event, handler),
    appendEntry: (customType: string, data?: unknown) => {
      entries.push({ customType, data });
      sessionManager?.appendCustomEntry(customType, data);
    },
    registerMessageRenderer: (customType: string, renderer: any) => renderers.set(customType, renderer),
    sendUserMessage: (content: unknown, options?: unknown) => sentUserMessages.push({ content, options }),
    sendMessage: (message: unknown, options?: unknown) => sentMessages.push({ message, options }),
    getAllTools: () => [
      ...toolInfo,
      ...[...tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
      })),
    ],
    events,
  } as unknown as ExtensionAPI;

  return { pi, commands, tools, handlers, entries, renderers, sentUserMessages, sentMessages, events };
}

function createMockContext(
  sessionEntries?: Array<{ type: string; customType?: string; data?: unknown }>,
  cwd = process.cwd(),
  sessionId = "test-session-id",
  sessionFile = join(tmpdir(), `${sessionId}.jsonl`),
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
        italic: (t: string) => t,
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
      getBranch: () => entries,
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
      getLeafId: () => "mock-leaf",
    } as any,
  } as unknown as ExtensionContext;
}

function createSessionManagerContext(sessionManager: SessionManager) {
  const sessionFile =
    sessionManager.getSessionFile() ??
    join(tmpdir(), `${sessionManager.getSessionId()}.jsonl`);
  const ctx = createMockContext(
    undefined,
    sessionManager.getCwd(),
    sessionManager.getSessionId(),
    sessionFile,
  ) as ExtensionContext & { sessionManager: SessionManager };
  ctx.sessionManager = new Proxy(sessionManager, {
    get(target, property) {
      if (property === "getSessionFile") return () => sessionFile;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return ctx;
}

async function createVerificationAsyncDirFixture(runId: string) {
  const scopeDir = await mkdtemp(
    join(await realpath(tmpdir()), "pi-subagents-test-"),
  );
  const asyncDir = join(scopeDir, "async-subagent-runs", runId);
  await mkdir(asyncDir, { recursive: true });
  return { asyncDir, scopeDir };
}

function installVerificationRpcBridge(
  events: ReturnType<typeof createMockAPI>["events"],
  sessionId: string,
  runId: string,
  asyncDir: string,
  sessionFile = join(tmpdir(), `${sessionId}.jsonl`),
) {
  const requests: Array<Record<string, unknown>> = [];
  events.on("subagents:rpc:v1:request", (raw) => {
    const request = raw as Record<string, unknown>;
    requests.push(request);
    const method = request.method as string;
    const data =
      method === "ping"
        ? {
            version: 1,
            methods: ["ping", "spawn", "status"],
            events: {
              replyPrefix: "subagents:rpc:v1:reply:",
              asyncComplete: "subagent:async-complete",
            },
            session: { sessionId, sessionFile },
          }
        : method === "spawn"
          ? {
              text: "spawned",
              details: {
                runId,
                asyncDir,
              },
            }
          : {
              text: "Run is still active.",
              details: { mode: "single", results: [] },
            };
    events.emit(`subagents:rpc:v1:reply:${String(request.requestId)}`, {
      version: 1,
      requestId: request.requestId,
      method,
      success: true,
      data,
    });
  });
  return requests;
}

function installControllableVerificationRpcBridge(
  events: ReturnType<typeof createMockAPI>["events"],
  sessionId: string,
  runId: string,
  asyncDir: string,
  sessionFile = join(tmpdir(), `${sessionId}.jsonl`),
) {
  type Method = "ping" | "spawn" | "status" | "stop";
  const requests: Array<Record<string, unknown>> = [];
  const deferred = new Set<Method>();
  const waiting = new Map<Method, Record<string, unknown>>();
  const reply = (request: Record<string, unknown>) => {
    const method = request.method as Method;
    const data =
      method === "ping"
        ? {
            version: 1,
            methods: ["ping", "spawn", "status"],
            events: {
              replyPrefix: "subagents:rpc:v1:reply:",
              asyncComplete: "subagent:async-complete",
            },
            session: { sessionId, sessionFile },
          }
        : method === "spawn"
          ? { text: "spawned", details: { runId, asyncDir } }
          : method === "stop"
            ? {
                runId,
                asyncDir,
                previousState: "running",
                state: "stopping",
                message: "Stop requested.",
              }
            : {
              text: "Run is still active.",
              details: { mode: "single", results: [] },
            };
    events.emit(`subagents:rpc:v1:reply:${String(request.requestId)}`, {
      version: 1,
      requestId: request.requestId,
      method,
      success: true,
      data,
    });
  };
  events.on("subagents:rpc:v1:request", (raw) => {
    const request = raw as Record<string, unknown>;
    const method = request.method as Method;
    requests.push(request);
    if (deferred.has(method)) waiting.set(method, request);
    else reply(request);
  });
  return {
    requests,
    defer(method: Method) {
      deferred.add(method);
    },
    release(method: Method) {
      const request = waiting.get(method);
      if (!request) throw new Error(`No deferred ${method} request.`);
      waiting.delete(method);
      deferred.delete(method);
      reply(request);
    },
    reject(method: Method) {
      const request = waiting.get(method);
      if (!request) throw new Error(`No deferred ${method} request.`);
      waiting.delete(method);
      deferred.delete(method);
      events.emit(`subagents:rpc:v1:reply:${String(request.requestId)}`, {
        version: 1,
        requestId: request.requestId,
        method,
        success: false,
        error: {
          code: "execution_failed",
          message: `${method} failed after navigation`,
        },
      });
    },
  };
}

async function emitSuccessfulLocalCodeVerification(
  events: ReturnType<typeof createMockAPI>["events"],
  runId: string,
  sessionFile: string,
  asyncDir: string,
): Promise<void> {
  const structuredOutput = {
    outcome: "supported",
    claimIds: ["CL-001"],
    evidenceIds: ["EV-001"],
    summary: "Critical claim is supported by direct evidence.",
  };
  const outputs = {
    "verify_local_code_supported": {
      text: JSON.stringify(structuredOutput),
      structured: structuredOutput,
      agent: "scout",
      stepIndex: 0,
    },
  };
  await writeFile(
    join(asyncDir, "status.json"),
    JSON.stringify({
      lifecycleArtifactVersion: 3,
      runId,
      sessionId: sessionFile,
      mode: "chain",
      state: "complete",
      steps: [
        {
          agent: "scout",
          context: "fresh",
          outputName: "verify_local_code_supported",
          status: "complete",
          exitCode: 0,
          structuredOutput,
        },
      ],
      outputs,
    }),
  );
  events.emit("subagent:async-complete", {
    runId,
    sessionId: sessionFile,
    success: true,
    state: "complete",
    exitCode: 0,
    results: [
      {
        agent: "scout",
        context: "fresh",
        status: "completed",
        success: true,
        structuredOutput,
      },
    ],
    outputs,
  });
}

async function enterLocalCodeClaim(
  api: ReturnType<typeof createMockAPI>,
  ctx: ExtensionContext,
) {
  await api.commands.get("brainstorm")!.handler("topic", ctx);
  await api.commands.get("brainstorm")!.handler("phase exploring", ctx);
  await api.handlers.get("tool_result")!(
    {
      type: "tool_result",
      toolCallId: "read-1",
      toolName: "read",
      input: { path: "index.ts" },
      content: [{ type: "text", text: "observable result" }],
      details: undefined,
      isError: false,
    },
    ctx,
  );
  await api.tools.get("brainstorm_record_claim")!.execute(
    "claim-1",
    {
      assertion: "The transition gate is centralized.",
      classification: "empirical",
      critical: true,
      verdict: "verified",
      evidenceIds: ["EV-001"],
      contradictoryEvidenceIds: [],
      impact: "Controls all forward transitions.",
      verificationDomain: "local-code",
      architectureImpact: false,
      mitigation: "Keep one shared blocker.",
    },
    undefined,
    undefined,
    ctx,
  );
}

async function enterPendingLocalCodeVerification(
  api: ReturnType<typeof createMockAPI>,
  ctx: ExtensionContext,
) {
  await enterLocalCodeClaim(api, ctx);
  await api.tools.get("brainstorm_run_verification")!.execute(
    "verification-1",
    { claimIds: ["CL-001"] },
    undefined,
    undefined,
    ctx,
  );
}

describe("brainstorm-forcer redesign", () => {
  it("rejects preflight agent names outside the verifier allowlist", async () => {
    await expect(
      preflightVerifierAgents("test-session", process.cwd(), ["worker"]),
    ).rejects.toThrow(/not allowed/i);
  });

  it("registers command, hooks, and renderer", () => {
    const { pi, tools, commands, handlers, renderers } = createMockAPI();
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
    expect(tools.get("brainstorm_run_verification")!.executionMode).toBe(
      "sequential",
    );
  });

  it("abandons verification launch when branch ownership changes during preflight", async () => {
    const fixture = await createVerificationAsyncDirFixture("launch-race-run");
    try {
      const api = createMockAPI();
      const ctx = createMockContext();
      let leafId = "branch-a";
      (ctx.sessionManager as any).getLeafId = () => leafId;
      const requests = installVerificationRpcBridge(
        api.events,
        "test-session-id",
        "launch-race-run",
        fixture.asyncDir,
      );
      brainstormForcer(api.pi, {
        preflight: async (_sessionId, _cwd, agents) => {
          leafId = "branch-b";
          return agents.map((agent) => ({ agent, ok: true }));
        },
      });
      await enterLocalCodeClaim(api, ctx);

      await expect(
        api.tools.get("brainstorm_run_verification")!.execute(
          "verification-race",
          { claimIds: ["CL-001"] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("launch ownership changed");
      expect(
        requests.some((request) => request.method === "spawn"),
      ).toBe(false);
      expect(
        (
          api.entries
            .filter((entry) => entry.customType === "brainstorm-forcer")
            .at(-1)?.data as any
        )?.pendingVerification,
      ).toBeNull();
    } finally {
      await rm(fixture.scopeDir, { recursive: true, force: true });
    }
  });

  it("stops a spawned run when branch ownership changes before persistence", async () => {
    const fixture = await createVerificationAsyncDirFixture("spawn-race-run");
    try {
      const api = createMockAPI();
      const ctx = createMockContext();
      let leafId = "branch-a";
      (ctx.sessionManager as any).getLeafId = () => leafId;
      const bridge = installControllableVerificationRpcBridge(
        api.events,
        "test-session-id",
        "spawn-race-run",
        fixture.asyncDir,
      );
      bridge.defer("spawn");
      brainstormForcer(api.pi, {
        preflight: async (_sessionId, _cwd, agents) =>
          agents.map((agent) => ({ agent, ok: true })),
      });
      await enterLocalCodeClaim(api, ctx);

      const launch = api.tools.get("brainstorm_run_verification")!.execute(
        "verification-spawn-race",
        { claimIds: ["CL-001"] },
        undefined,
        undefined,
        ctx,
      );
      while (!bridge.requests.some((request) => request.method === "spawn"))
        await Bun.sleep(0);
      leafId = "branch-b";
      bridge.release("spawn");

      await expect(launch).rejects.toThrow("launch ownership changed");
      expect(
        bridge.requests.some((request) => request.method === "stop"),
      ).toBe(true);
      expect(
        (
          api.entries
            .filter((entry) => entry.customType === "brainstorm-forcer")
            .at(-1)?.data as any
        )?.pendingVerification,
      ).toBeNull();
    } finally {
      await rm(fixture.scopeDir, { recursive: true, force: true });
    }
  });

  it("requires verificationDomain and architectureImpact on brainstorm_record_claim", () => {
    const { pi, tools } = createMockAPI();
    brainstormForcer(pi);
    const schema = tools.get("brainstorm_record_claim")!.parameters;
    const base = {
      assertion: "x",
      classification: "empirical",
      critical: false,
      verdict: "verified",
      evidenceIds: [],
      contradictoryEvidenceIds: [],
      impact: "i",
      mitigation: "m",
    };
    expect(Value.Check(schema, base)).toBe(false);
    expect(
      Value.Check(schema, {
        ...base,
        verificationDomain: "local-code",
        architectureImpact: false,
      }),
    ).toBe(true);
    expect(
      Value.Check(schema, { ...base, verificationDomain: "bogus", architectureImpact: false }),
    ).toBe(false);

    const verificationSchema = tools.get("brainstorm_run_verification")!.parameters;
    expect(Value.Check(verificationSchema, { claimIds: ["CL-001"] })).toBe(true);
    expect(
      Value.Check(verificationSchema, {
        claimIds: ["CL-001"],
        agent: "worker",
        domain: "local-code",
        architect: true,
      }),
    ).toBe(false);
  });

  it("registers one structured artifact submission tool per phase", () => {
    const { pi, tools } = createMockAPI();
    brainstormForcer(pi);
    expect(
      [...tools.keys()].filter(
        (name) => name.startsWith("brainstorm_submit_"),
      ),
    ).toEqual([
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
      const { pi, tools, commands, handlers } = createMockAPI();
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
                claimIds: ["CL-001"],
                failureConditions: ["Wrong phase tool accepted."],
              },
              {
                title: "Generic tool",
                summary: "One loose schema.",
                tradeoffs: ["Less validation."],
                claimIds: ["CL-002"],
                failureConditions: ["Malformed artifact."],
              },
            ],
            recommendation: "Dedicated tools",
            recommendationClaimIds: ["CL-001"],
            userChoice: "Dedicated tools",
            userChoiceEvidenceId: "EV-001",
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
        if (phase === "presenting") await command.handler("next", ctx);
        else await command.handler(`phase ${phase}`, ctx);
        if (phase === "exploring") {
          for (const assertion of ["Use dedicated tools.", "Keep schemas strict."]) {
            await tools.get("brainstorm_record_claim")!.execute(
              "claim",
              {
                assertion,
                classification: "design-choice",
                critical: false,
                verdict: "unresolved",
                evidenceIds: [],
                contradictoryEvidenceIds: [],
                impact: "Shapes the workflow API.",
                verificationDomain: "local-code",
                architectureImpact: false,
                mitigation: "Document the trade-off.",
              },
              undefined,
              undefined,
              ctx,
            );
          }
          await handlers.get("tool_result")!(
            {
              type: "tool_result",
              toolCallId: "choice-1",
              toolName: "ask_user_question",
              input: { questions: [{ question: "Which approach?" }] },
              content: [{ type: "text", text: "Dedicated tools" }],
              details: {
                cancelled: false,
                answers: [
                  {
                    questionIndex: 0,
                    question: "Which approach?",
                    kind: "option",
                    answer: "Dedicated tools",
                  },
                ],
              },
              isError: false,
            },
            ctx,
          );
        }
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

  it("shows the active artifact inside Pi before approving a TUI transition", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-review-ui-"));
    try {
      const { pi, tools, commands } = createMockAPI();
      const ctx = createMockContext(undefined, projectRoot);
      (ctx as any).mode = "tui";
      const { initTheme } = await import("@earendil-works/pi-coding-agent");
      initTheme();
      let rendered = "";
      (ctx.ui.custom as any).mockImplementation(async (factory: any) =>
        await new Promise((resolve) => {
          const component = factory(
            { requestRender: mock(() => undefined) },
            ctx.ui.theme,
            {},
            resolve,
          );
          rendered = component.render(100).join("\n");
          component.handleInput("a");
        }),
      );
      brainstormForcer(pi);
      await commands.get("brainstorm")!.handler("Visible artifact", ctx);
      await tools.get("brainstorm_submit_discovery")!.execute(
        "artifact",
        { filesAccessed: ["index.ts"], keyFindings: ["Verified in overlay."], gaps: [] },
        undefined,
        undefined,
        ctx,
      );

      const result = await tools
        .get("brainstorm_transition")!
        .execute("next", { action: "next" }, undefined, undefined, ctx);
      expect(rendered).toContain("Verified in overlay.");
      expect(rendered).toContain("Discovery r001 → Understanding");
      expect(result.details).toMatchObject({ phase: "understanding", approved: true });
      expect(ctx.ui.select).not.toHaveBeenCalled();
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

  it("returns semantic Exploring status in transition details", async () => {
    const { pi, tools, commands } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    await commands.get("brainstorm")!.handler("Status details", ctx);
    await commands.get("brainstorm")!.handler("phase exploring", ctx);

    const result = await tools
      .get("brainstorm_transition")!
      .execute("status", { action: "status" }, undefined, undefined, ctx);

    expect(result.details.exploringStatus).toMatchObject({
      claims: { historical: 0, active: 0 },
      reviews: { total: 0, success: 0, malformed: 0 },
      missingSuccessfulReviewClaimIds: [],
      pendingRunId: null,
      questionTool: "available",
      finalChoice: "required",
      nextAction: "askDedicatedChoice",
    });
  });

  it("shows compact ledger counts in /brainstorm status", async () => {
    const { pi, handlers, commands } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    const command = commands.get("brainstorm")!;
    await command.handler("topic", ctx);
    await command.handler("phase exploring", ctx);
    await handlers.get("tool_result")!(
      {
        type: "tool_result",
        toolCallId: "read-1",
        toolName: "read",
        input: { path: "index.ts" },
        content: [{ type: "text", text: "result" }],
        details: undefined,
        isError: false,
      },
      ctx,
    );

    await command.handler("status", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Exploring ledger: EV=1 | claims=0 active/0 historical | reviews=0 successful/0 total",
      ),
      "warning",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Required successful reviews missing: none"),
      "warning",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Final choice: required"),
      "warning",
    );
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
      (ctx.ui.input as any).mockResolvedValueOnce("Completion-path test override.");
      (ctx.ui.select as any).mockResolvedValueOnce("Approve override");
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
      (ctx.ui.input as any).mockResolvedValueOnce("Completion-path test override.");
      (ctx.ui.select as any).mockResolvedValueOnce("Approve override");
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

  it("injects compact Exploring ledger counts without raw evidence", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-ledger-context-"));
    try {
      const { pi, commands, handlers, tools } = createMockAPI();
      const ctx = createMockContext(undefined, projectRoot);
      brainstormForcer(pi);
      await commands.get("brainstorm")!.handler("topic", ctx);
      await commands.get("brainstorm")!.handler("phase exploring", ctx);
      await handlers.get("tool_result")!(
        {
          type: "tool_result",
          toolCallId: "read-1",
          toolName: "read",
          input: { path: "index.ts" },
          content: [{ type: "text", text: "raw-evidence-must-not-be-injected" }],
          details: undefined,
          isError: false,
        },
        ctx,
      );
      await tools.get("brainstorm_record_claim")!.execute(
        "claim-1",
        {
          assertion: "Use session entries.",
          classification: "design-choice",
          critical: false,
          verdict: "unresolved",
          evidenceIds: [],
          contradictoryEvidenceIds: [],
          impact: "Avoids duplicate persistence.",
          verificationDomain: "local-code",
          architectureImpact: false,
          mitigation: "Bound records.",
        },
        undefined,
        undefined,
        ctx,
      );

      const result = await handlers.get("context")!({ messages: [] }, ctx);
      expect(result.messages[0].content).toContain(
        "Exploring ledger: EV=1 | claims=1 active/1 historical | reviews=0 successful/0 total",
      );
      expect(result.messages[0].content).not.toContain("raw-evidence-must-not-be-injected");
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

  it("reopens the active artifact through /brainstorm review", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-review-command-"));
    try {
      const { pi, commands, tools } = createMockAPI();
      const ctx = createMockContext(undefined, projectRoot);
      (ctx as any).mode = "tui";
      const { initTheme } = await import("@earendil-works/pi-coding-agent");
      initTheme();
      let rendered = "";
      (ctx.ui.custom as any).mockImplementation(async (factory: any) =>
        await new Promise((resolve) => {
          const component = factory(
            { requestRender: mock(() => undefined) },
            ctx.ui.theme,
            {},
            resolve,
          );
          rendered = component.render(100).join("\n");
          component.handleInput("\r");
        }),
      );
      brainstormForcer(pi);
      const command = commands.get("brainstorm")!;
      await command.handler("Review command", ctx);
      await tools.get("brainstorm_submit_discovery")!.execute(
        "artifact",
        { filesAccessed: ["index.ts"], keyFindings: ["Review me inside Pi."], gaps: [] },
        undefined,
        undefined,
        ctx,
      );

      await command.handler("review", ctx);
      expect(rendered).toContain("Review me inside Pi.");
      expect(rendered).toContain("Discovery r001");
      expect(rendered).toContain("[ Close ]");
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
    expect(all.some((item: any) => item.value === "review")).toBe(true);
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
    (ctx.ui.input as any).mockResolvedValueOnce("Tool-policy test override.");
    (ctx.ui.select as any).mockResolvedValueOnce("Approve override");
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

  it("allows phase-scoped Exploring workflow tools despite mutation-like descriptions", async () => {
    const { pi, handlers, commands } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    const command = commands.get("brainstorm")!;
    await command.handler("topic", ctx);
    const toolCall = handlers.get("tool_call")!;

    expect((await toolCall({ toolName: "brainstorm_record_claim" }, ctx)).block).toBe(true);

    await command.handler("phase exploring", ctx);
    for (const toolName of [
      "brainstorm_record_claim",
      "brainstorm_run_verification",
      "brainstorm_request_waiver",
    ]) {
      expect(await toolCall({ toolName }, ctx)).toBeUndefined();
    }
    const blocked = await toolCall({ toolName: "create_resource" }, ctx);
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toContain("brainstorm_record_claim");
  });

  it("blocks direct generic subagent execution during Exploring", async () => {
    const { pi, handlers, commands } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    await commands.get("brainstorm")!.handler("topic", ctx);
    await commands.get("brainstorm")!.handler("phase exploring", ctx);

    const result = await handlers.get("tool_call")!(
        {
          toolName: "subagent",
          input: {
            agent: "researcher",
            context: "fresh",
            task: "Research competing approaches and cite primary sources.",
          },
        },
        ctx,
      );
    expect(result.block).toBe(true);
  });

  it("blocks every direct subagent shape during Exploring", async () => {
    const { pi, handlers, commands } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    await commands.get("brainstorm")!.handler("topic", ctx);
    await commands.get("brainstorm")!.handler("phase exploring", ctx);
    const toolCall = handlers.get("tool_call")!;

    expect(
      (
        await toolCall(
        {
          toolName: "subagent",
          input: {
            context: "fresh",
            async: false,
            chain: [
              {
                agent: "reviewer",
                task: "Review CL-001 against EV-001.",
                outputSchema: {
                  type: "object",
                  properties: {
                    outcome: { enum: ["supported", "rejected", "unresolved"] },
                    claimIds: { type: "array", items: { type: "string" } },
                    evidenceIds: { type: "array", items: { type: "string" } },
                  },
                  required: ["outcome", "claimIds", "evidenceIds"],
                  additionalProperties: false,
                },
              },
            ],
          },
        },
        ctx,
        )
      ).block,
    ).toBe(true);
    for (const input of [
      {
        agent: "reviewer",
        context: "fresh",
        task: "Review CL-001.",
        outputSchema: {},
      },
      { agent: "reviewer", context: "fresh", task: "Review CL-001." },
      { agent: "reviewer", context: "fork", task: "Review CL-001.", outputSchema: {} },
      { agent: "worker", context: "fresh", task: "Review CL-001." },
      { agent: "reviewer", context: "fresh", task: "Review CL-001.", async: true },
      {
        context: "fresh",
        chain: [
          {
            agent: "reviewer",
            task: "Review CL-001.",
            outputSchema: {},
          },
        ],
      },
      { action: "list" },
    ]) {
      expect((await toolCall({ toolName: "subagent", input }, ctx)).block).toBe(true);
    }
  });

  it("blocks questions only while verification is pending and allows owned status until terminal completion", async () => {
    const fixture = await createVerificationAsyncDirFixture("owned-verification-run");
    try {
      const api = createMockAPI();
      const ctx = createMockContext();
      installVerificationRpcBridge(
        api.events,
        "test-session-id",
        "owned-verification-run",
        fixture.asyncDir,
      );
      brainstormForcer(api.pi, {
        preflight: async (_sessionId, _cwd, agents) =>
          agents.map((agent) => ({ agent, ok: true })),
      });
      await enterPendingLocalCodeVerification(api, ctx);

      const question = await api.handlers.get("tool_call")!(
        { toolName: "ask_user_question", input: {} },
        ctx,
      );
      expect(question).toMatchObject({ block: true });
      expect(question.reason).toContain(
        "ask_user_question is blocked while verification run owned-verification-run is pending",
      );

      expect(
        await api.handlers.get("tool_call")!(
          {
            toolName: "subagent",
            input: { action: "status", id: "owned-verification-run" },
          },
          ctx,
        ),
      ).toBeUndefined();

      const foreign = await api.handlers.get("tool_call")!(
        {
          toolName: "subagent",
          input: { action: "status", id: "foreign-run" },
        },
        ctx,
      );
      expect(foreign).toMatchObject({ block: true });
      expect(foreign.reason).toContain(
        "must target exactly owned verification run owned-verification-run",
      );

      await emitSuccessfulLocalCodeVerification(
        api.events,
        "owned-verification-run",
        join(tmpdir(), "test-session-id.jsonl"),
        fixture.asyncDir,
      );
      await Bun.sleep(0);
      expect(
        await api.handlers.get("tool_call")!(
          { toolName: "ask_user_question", input: {} },
          ctx,
        ),
      ).toBeUndefined();
    } finally {
      await rm(fixture.scopeDir, { recursive: true, force: true });
    }
  });

  it("enforces action-specific fields and bounded child indexes for owned verification controls", async () => {
    const fixture = await createVerificationAsyncDirFixture("owned-verification-run");
    try {
      const api = createMockAPI();
      const ctx = createMockContext();
      installVerificationRpcBridge(
        api.events,
        "test-session-id",
        "owned-verification-run",
        fixture.asyncDir,
      );
      brainstormForcer(api.pi, {
        preflight: async (_sessionId, _cwd, agents) =>
          agents.map((agent) => ({ agent, ok: true })),
      });
      await api.commands.get("brainstorm")!.handler("topic", ctx);
      await api.commands.get("brainstorm")!.handler("phase exploring", ctx);
      const toolCall = api.handlers.get("tool_call")!;
      const withoutPending = await toolCall(
        {
          toolName: "subagent",
          input: { action: "status", id: "owned-verification-run" },
        },
        ctx,
      );
      expect(withoutPending.reason).toContain(
        "No owned verification run is pending",
      );

      await enterPendingLocalCodeVerification(api, ctx);
      const spawnWithoutAction = await toolCall(
        {
          toolName: "subagent",
          input: {
            agent: "scout",
            task: "Start unrelated generic execution.",
          },
        },
        ctx,
      );
      expect(spawnWithoutAction.block).toBe(true);
      expect(spawnWithoutAction.reason).toContain(
        "Unsupported verification control action undefined",
      );

      for (const input of [
        { action: "status", id: "owned-verification-run" },
        {
          action: "steer",
          id: "owned-verification-run",
          message: "Continue with the cited evidence.",
          index: 0,
        },
        {
          action: "resume",
          id: "owned-verification-run",
          message: "Resume the verification.",
          index: 0,
        },
        { action: "interrupt", id: "owned-verification-run" },
        { action: "stop", id: "owned-verification-run" },
      ]) {
        expect(
          await toolCall({ toolName: "subagent", input }, ctx),
        ).toBeUndefined();
      }

      const unknownAction = await toolCall(
        {
          toolName: "subagent",
          input: { action: "list", id: "owned-verification-run" },
        },
        ctx,
      );
      expect(unknownAction.reason).toContain(
        "Unsupported verification control action",
      );

      const alternateTarget = await toolCall(
        {
          toolName: "subagent",
          input: { action: "status", runId: "owned-verification-run" },
        },
        ctx,
      );
      expect(alternateTarget.reason).toContain(
        "does not allow field(s): runId",
      );

      const directoryTarget = await toolCall(
        {
          toolName: "subagent",
          input: {
            action: "status",
            id: "owned-verification-run",
            dir: fixture.asyncDir,
          },
        },
        ctx,
      );
      expect(directoryTarget.reason).toContain("does not allow field(s): dir");

      for (const input of [
        {
          action: "steer",
          id: "owned-verification-run",
          message: "Continue.",
          index: -1,
        },
        {
          action: "steer",
          id: "owned-verification-run",
          message: "Continue.",
          index: 0.5,
        },
        {
          action: "steer",
          id: "owned-verification-run",
          message: "Continue.",
          index: 1,
        },
        {
          action: "resume",
          id: "owned-verification-run",
          message: "Resume.",
          index: -1,
        },
        {
          action: "resume",
          id: "owned-verification-run",
          message: "Resume.",
          index: 0.5,
        },
        {
          action: "resume",
          id: "owned-verification-run",
          message: "Resume.",
          index: 1,
        },
        {
          action: "status",
          id: "owned-verification-run",
          agent: "scout",
        },
        {
          action: "status",
          id: "owned-verification-run",
          task: "Run another verifier.",
        },
        { action: "status", id: "owned-verification-run", tasks: [] },
        { action: "status", id: "owned-verification-run", chain: [] },
        { action: "status", id: "owned-verification-run", parallel: [] },
        { action: "status", id: "owned-verification-run", async: true },
        {
          action: "status",
          id: "owned-verification-run",
          context: "fresh",
        },
        {
          action: "status",
          id: "owned-verification-run",
          outputSchema: {},
        },
        {
          action: "status",
          id: "owned-verification-run",
          view: "transcript",
        },
        { action: "status", id: "owned-verification-run", lines: 80 },
        {
          action: "resume",
          id: "owned-verification-run",
          message: "Resume.",
          output: "verification.md",
        },
      ]) {
        expect((await toolCall({ toolName: "subagent", input }, ctx)).block).toBe(
          true,
        );
      }

      for (const input of [
        {
          action: "status",
          id: "owned-verification-run",
          view: "transcript",
          index: -1,
        },
        {
          action: "status",
          id: "owned-verification-run",
          view: "transcript",
          index: 1,
        },
        { action: "status", id: "owned-verification-run", index: 0 },
        { action: "stop", id: "owned-verification-run", index: 0 },
        { action: "interrupt", id: "owned-verification-run", index: 0 },
      ]) {
        const invalidIndex = await toolCall(
          { toolName: "subagent", input },
          ctx,
        );
        expect(invalidIndex.block).toBe(true);
        expect(invalidIndex.reason).toContain("index");
      }

      for (const input of [
        {
          action: "status",
          id: "owned-verification-run",
          view: "fleet",
        },
        {
          action: "steer",
          id: "owned-verification-run",
          message: "   ",
        },
        {
          action: "resume",
          id: "owned-verification-run",
          message: "",
        },
      ]) {
        expect((await toolCall({ toolName: "subagent", input }, ctx)).block).toBe(
          true,
        );
      }
    } finally {
      await rm(fixture.scopeDir, { recursive: true, force: true });
    }
  });

  it("excludes owned subagent controls and subagent_wait from Exploring evidence", async () => {
    const fixture = await createVerificationAsyncDirFixture("owned-verification-run");
    try {
      const api = createMockAPI();
      const ctx = createMockContext();
      installVerificationRpcBridge(
        api.events,
        "test-session-id",
        "owned-verification-run",
        fixture.asyncDir,
      );
      brainstormForcer(api.pi, {
        preflight: async (_sessionId, _cwd, agents) =>
          agents.map((agent) => ({ agent, ok: true })),
      });
      await enterPendingLocalCodeVerification(api, ctx);
      const ledgerEntriesBefore = api.entries.filter(
        (entry) => entry.customType === "brainstorm-forcer-ledger",
      );

      const controlResult = await api.handlers.get("tool_result")!(
        {
          type: "tool_result",
          toolCallId: "status-owned",
          toolName: "subagent",
          input: { action: "status", id: "owned-verification-run" },
          content: [{ type: "text", text: "needs attention" }],
          details: { mode: "management", results: [] },
          isError: false,
        },
        ctx,
      );
      const waitResult = await api.handlers.get("tool_result")!(
        {
          type: "tool_result",
          toolCallId: "wait-owned",
          toolName: "subagent_wait",
          input: { id: "owned-verification-run" },
          content: [{ type: "text", text: "still running" }],
          details: { completed: [], active: ["owned-verification-run"] },
          isError: false,
        },
        ctx,
      );

      expect(controlResult).toBeUndefined();
      expect(waitResult).toBeUndefined();
      expect(
        api.entries.filter(
          (entry) => entry.customType === "brainstorm-forcer-ledger",
        ),
      ).toEqual(ledgerEntriesBefore);
      await api.commands.get("brainstorm")!.handler("status", ctx);
      expect(ctx.ui.notify).toHaveBeenLastCalledWith(
        expect.stringContaining(
          "Exploring ledger: EV=1 | claims=1 active/1 historical | reviews=0 successful/0 total",
        ),
        "warning",
      );
    } finally {
      await rm(fixture.scopeDir, { recursive: true, force: true });
    }
  });

  it("bounds attention recovery to one wait and one pending steer", async () => {
    const fixture = await createVerificationAsyncDirFixture("bounded-recovery-run");
    try {
      const api = createMockAPI();
      const ctx = createMockContext();
      installVerificationRpcBridge(
        api.events,
        "test-session-id",
        "bounded-recovery-run",
        fixture.asyncDir,
      );
      brainstormForcer(api.pi, {
        preflight: async (_sessionId, _cwd, agents) =>
          agents.map((agent) => ({ agent, ok: true })),
      });
      await enterPendingLocalCodeVerification(api, ctx);
      const toolCall = api.handlers.get("tool_call")!;
      const toolResult = api.handlers.get("tool_result")!;

      expect(
        await toolCall(
          { toolName: "subagent_wait", input: { id: "bounded-recovery-run" } },
          ctx,
        ),
      ).toBeUndefined();
      await toolResult(
        {
          type: "tool_result",
          toolCallId: "wait-once",
          toolName: "subagent_wait",
          input: { id: "bounded-recovery-run" },
          content: [{ type: "text", text: "attention required" }],
          details: { mode: "management", results: [] },
          isError: false,
        },
        ctx,
      );
      expect(
        await toolCall(
          { toolName: "subagent_wait", input: { id: "bounded-recovery-run" } },
          ctx,
        ),
      ).toMatchObject({ block: true });

      expect(
        await toolCall(
          {
            toolName: "subagent",
            input: {
              action: "steer",
              id: "bounded-recovery-run",
              index: 0,
              message: "Return the bounded verdict.",
            },
          },
          ctx,
        ),
      ).toBeUndefined();
      await toolResult(
        {
          type: "tool_result",
          toolCallId: "steer-foreign",
          toolName: "subagent",
          input: {
            action: "steer",
            id: "bounded-recovery-run",
            index: 0,
            message: "Return the bounded verdict.",
          },
          content: [{ type: "text", text: "Foreign steering" }],
          details: {
            mode: "management",
            results: [],
            steering: {
              requestId: "foreign-request",
              state: "pending",
              sourceRunId: "foreign-run",
              targets: [{ index: 0, state: "routed" }],
            },
          },
          isError: false,
        },
        ctx,
      );
      await toolResult(
        {
          type: "tool_result",
          toolCallId: "steer-error",
          toolName: "subagent",
          input: {
            action: "steer",
            id: "bounded-recovery-run",
            index: 0,
            message: "Return the bounded verdict.",
          },
          content: [{ type: "text", text: "Steering failed" }],
          details: {
            mode: "management",
            results: [],
            steering: {
              requestId: "error-request",
              state: "pending",
              sourceRunId: "bounded-recovery-run",
              targets: [{ index: 0, state: "routed" }],
            },
          },
          isError: true,
        },
        ctx,
      );
      expect(
        await toolCall(
          {
            toolName: "subagent",
            input: {
              action: "steer",
              id: "bounded-recovery-run",
              index: 0,
              message: "Return the bounded verdict.",
            },
          },
          ctx,
        ),
      ).toBeUndefined();

      await toolResult(
        {
          type: "tool_result",
          toolCallId: "steer-once",
          toolName: "subagent",
          input: {
            action: "steer",
            id: "bounded-recovery-run",
            index: 0,
            message: "Return the bounded verdict.",
          },
          content: [{ type: "text", text: "Steering pending" }],
          details: {
            mode: "management",
            results: [],
            steering: {
              requestId: "request-1",
              state: "pending",
              sourceRunId: "bounded-recovery-run",
              targets: [{ index: 0, state: "routed" }],
            },
          },
          isError: false,
        },
        ctx,
      );

      expect(
        await toolCall(
          {
            toolName: "subagent",
            input: { action: "status", id: "bounded-recovery-run" },
          },
          ctx,
        ),
      ).toBeUndefined();
      for (const input of [
        {
          action: "steer",
          id: "bounded-recovery-run",
          index: 0,
          message: "Try again.",
        },
        {
          action: "resume",
          id: "bounded-recovery-run",
          index: 0,
          message: "Resume.",
        },
        { action: "interrupt", id: "bounded-recovery-run" },
        { action: "stop", id: "bounded-recovery-run" },
      ]) {
        expect(
          await toolCall({ toolName: "subagent", input }, ctx),
        ).toMatchObject({ block: true });
      }
      expect(
        await toolCall(
          { toolName: "subagent_wait", input: { id: "bounded-recovery-run" } },
          ctx,
        ),
      ).toMatchObject({ block: true });

      const context = await api.handlers.get("context")!({ messages: [] }, ctx);
      expect(context.messages[0].content).toContain(
        "Next action: manualIntervention",
      );
    } finally {
      await rm(fixture.scopeDir, { recursive: true, force: true });
    }
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

  it("keeps Exploring active when a force override has no user reason", async () => {
    const { pi, commands, entries } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    const command = commands.get("brainstorm")!;
    await command.handler("topic", ctx);
    await command.handler("phase exploring", ctx);

    await command.handler("next --force", ctx);

    const state = entries.filter((entry) => entry.customType === "brainstorm-forcer").at(-1);
    expect(state?.data).toMatchObject({ phase: "exploring" });
    expect(entries.some((entry: any) => entry.data?.record?.kind === "override")).toBe(false);
  });

  it("records a confirmed user override before force-leaving Exploring", async () => {
    const { pi, commands, entries } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    const command = commands.get("brainstorm")!;
    await command.handler("topic", ctx);
    await command.handler("phase exploring", ctx);
    (ctx.ui.input as any).mockResolvedValueOnce("Proceed with documented uncertainty.");
    (ctx.ui.select as any).mockResolvedValueOnce("Approve override");

    await command.handler("next --force", ctx);

    expect(entries.some((entry: any) => entry.data?.record?.id === "OV-001")).toBe(true);
    const state = entries.filter((entry) => entry.customType === "brainstorm-forcer").at(-1);
    expect(state?.data).toMatchObject({ phase: "presenting" });
  });

  it("records an override for deprecated force-next when leaving Exploring", async () => {
    const { pi, commands, entries } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    const command = commands.get("brainstorm")!;
    await command.handler("topic", ctx);
    await command.handler("phase exploring", ctx);
    (ctx.ui.input as any).mockResolvedValueOnce("Proceed with explicit uncertainty.");
    (ctx.ui.select as any).mockResolvedValueOnce("Approve override");

    await command.handler("force-next", ctx);

    expect(entries.some((entry: any) => entry.data?.record?.id === "OV-001")).toBe(true);
  });

  it("records an override for a forward phase jump that leaves Exploring", async () => {
    const { pi, commands, entries } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    const command = commands.get("brainstorm")!;
    await command.handler("topic", ctx);
    await command.handler("phase exploring", ctx);
    (ctx.ui.input as any).mockResolvedValueOnce("Proceed with explicit uncertainty.");
    (ctx.ui.select as any).mockResolvedValueOnce("Approve override");

    await command.handler("phase presenting", ctx);

    expect(entries.some((entry: any) => entry.data?.record?.id === "OV-001")).toBe(true);
    const state = entries.filter((entry) => entry.customType === "brainstorm-forcer").at(-1);
    expect(state?.data).toMatchObject({ phase: "presenting" });
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

  it("blocks Exploring submission without creating an artifact revision", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-exploring-gate-"));
    try {
      const { pi, handlers, commands, tools } = createMockAPI();
      const ctx = createMockContext(undefined, projectRoot);
      brainstormForcer(pi);
      await commands.get("brainstorm")!.handler("topic", ctx);
      await commands.get("brainstorm")!.handler("phase exploring", ctx);
      await handlers.get("tool_result")!(
        {
          type: "tool_result",
          toolCallId: "read-1",
          toolName: "read",
          input: { path: "missing.ts" },
          content: [{ type: "text", text: "ENOENT" }],
          details: undefined,
          isError: true,
        },
        ctx,
      );
      await tools.get("brainstorm_record_claim")!.execute(
        "claim-1",
        {
          assertion: "The missing source changes runtime behavior.",
          classification: "empirical",
          critical: true,
          verdict: "unresolved",
          evidenceIds: ["EV-001"],
          contradictoryEvidenceIds: [],
          impact: "Could invalidate the recommendation.",
          verificationDomain: "local-code",
          architectureImpact: false,
          mitigation: "Re-evaluate when source is available.",
        },
        undefined,
        undefined,
        ctx,
      );
      await tools.get("brainstorm_record_claim")!.execute(
        "claim-2",
        {
          assertion: "Use append-only session entries.",
          classification: "design-choice",
          critical: false,
          verdict: "unresolved",
          evidenceIds: [],
          contradictoryEvidenceIds: [],
          impact: "Avoids a second persistence layer.",
          verificationDomain: "local-code",
          architectureImpact: false,
          mitigation: "Bound records.",
        },
        undefined,
        undefined,
        ctx,
      );
      const filesBeforeSubmission = await readdir(projectRoot);
      const exploring = await tools.get("brainstorm_submit_exploring")!.execute(
        "exploring-1",
        {
          approaches: [
            {
              title: "Session ledger",
              summary: "Use session entries.",
              tradeoffs: ["Session grows."],
              claimIds: ["CL-001", "CL-002"],
              failureConditions: ["Records are unbounded."],
            },
            {
              title: "Artifact ledger",
              summary: "Use a separate file.",
              tradeoffs: ["Extra persistence."],
              claimIds: ["CL-002"],
              failureConditions: ["State diverges."],
            },
          ],
          recommendation: "Use session entries.",
          recommendationClaimIds: ["CL-002"],
          userChoice: "Session ledger",
          userChoiceEvidenceId: "EV-999",
        },
        undefined,
        undefined,
        ctx,
      );

      expect(exploring.details).toEqual({
        blocked: true,
        blockers: [
          "User choice must come from ask_user_question evidence.",
          "CL-001 requires a user-approved waiver.",
        ],
      });
      expect(exploring.content[0].text).toContain(
        "User choice must come from ask_user_question evidence.",
      );
      expect(exploring.content[0].text).toContain(
        "CL-001 requires a user-approved waiver.",
      );
      expect(await readdir(projectRoot)).toEqual(filesBeforeSubmission);
      await expectRejection(
        Promise.resolve(
          tools
            .get("brainstorm_transition")!
            .execute("next", { action: "next" }, undefined, undefined, ctx),
        ),
        "has not submitted an artifact",
      );
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("requires a new Exploring revision after ledger evidence changes", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-exploring-revision-"));
    try {
      const { pi, handlers, commands, tools } = createMockAPI();
      const ctx = createMockContext(undefined, projectRoot);
      brainstormForcer(pi);
      await commands.get("brainstorm")!.handler("topic", ctx);
      await commands.get("brainstorm")!.handler("phase exploring", ctx);
      for (const assertion of ["Use session entries.", "Keep evidence bounded."]) {
        await tools.get("brainstorm_record_claim")!.execute(
          "claim",
          {
            assertion,
            classification: "design-choice",
            critical: false,
            verdict: "unresolved",
            evidenceIds: [],
            contradictoryEvidenceIds: [],
            impact: "Shapes persistence.",
            verificationDomain: "local-code",
            architectureImpact: false,
            mitigation: "Document the trade-off.",
          },
          undefined,
          undefined,
          ctx,
        );
      }
      await handlers.get("tool_result")!(
        {
          type: "tool_result",
          toolCallId: "choice-1",
          toolName: "ask_user_question",
          input: { questions: [{ question: "Which approach?" }] },
          content: [{ type: "text", text: "Session ledger" }],
          details: {
            cancelled: false,
            answers: [
              {
                questionIndex: 0,
                question: "Which approach?",
                kind: "option",
                answer: "Session ledger",
              },
            ],
          },
          isError: false,
        },
        ctx,
      );
      const params = {
        approaches: [
          {
            title: "Session ledger",
            summary: "Use session entries.",
            tradeoffs: ["Session grows."],
            claimIds: ["CL-001", "CL-002"],
            failureConditions: ["Records are unbounded."],
          },
          {
            title: "Artifact ledger",
            summary: "Use a separate file.",
            tradeoffs: ["Extra persistence."],
            claimIds: ["CL-001"],
            failureConditions: ["State diverges."],
          },
        ],
        recommendation: "Use session entries.",
        recommendationClaimIds: ["CL-001"],
        userChoice: "Session ledger",
        userChoiceEvidenceId: "EV-001",
      };
      const first = await tools
        .get("brainstorm_submit_exploring")!
        .execute("exploring-1", params, undefined, undefined, ctx);
      expect(first.details.artifact.revision).toBe(1);

      await handlers.get("tool_result")!(
        {
          type: "tool_result",
          toolCallId: "read-1",
          toolName: "read",
          input: { path: "README.md" },
          content: [{ type: "text", text: "new evidence" }],
          details: undefined,
          isError: false,
        },
        ctx,
      );
      await expectRejection(
        Promise.resolve(
          tools
            .get("brainstorm_transition")!
            .execute("next", { action: "next" }, undefined, undefined, ctx),
        ),
        "ledger changed after the latest Exploring artifact",
      );

      const second = await tools
        .get("brainstorm_submit_exploring")!
        .execute("exploring-2", params, undefined, undefined, ctx);
      expect(second.details.artifact.revision).toBe(2);
      expect(second.details.artifact.path).toEndWith("03-exploring-r002.md");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
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

      (ctx.ui.input as any).mockResolvedValueOnce("Presenting-gate test override.");
      (ctx.ui.select as any).mockResolvedValueOnce("Approve override");
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

  it("injects the evidence-gated Exploring tool sequence", async () => {
    const { pi, handlers, commands } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    await commands.get("brainstorm")!.handler("topic", ctx);
    await commands.get("brainstorm")!.handler("phase exploring", ctx);

    const result = await handlers.get("before_agent_start")!(
      { systemPrompt: "BASE", prompt: "topic", images: undefined, systemPromptOptions: {} },
      ctx,
    );

    for (const expected of [
      "brainstorm_record_claim",
      "brainstorm_run_verification",
      "brainstorm_request_waiver",
      "dedicated async verification",
      "pi-subagents RPC v1",
      "userChoiceEvidenceId",
      "dedicated single-question",
      "direct corroboration",
      "No new subagent run",
      "status, steer, resume, interrupt, or stop",
      "`ask_user_question` remains blocked until terminal verification processing",
    ]) {
      expect(result.systemPrompt).toContain(expected);
    }
    expect(result.message.details.restriction).toContain("EV-*");
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
    expect(lastWidgetCall[1][0]).toContain(
      "ev:0 review:0/0 action:askDedicatedChoice",
    );
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

  it("automatically captures allowed Exploring tool results as EV records", async () => {
    const { pi, handlers, commands, entries } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    const command = commands.get("brainstorm")!;
    await command.handler("topic", ctx);
    await command.handler("phase exploring", ctx);

    const result = await handlers.get("tool_result")!(
      {
        type: "tool_result",
        toolCallId: "read-1",
        toolName: "read",
        input: { path: "/home/test/README.md", token: "must-not-persist" },
        content: [{ type: "text", text: "raw tool output" }],
        details: undefined,
        isError: false,
      },
      ctx,
    );

    const ledgerEntry = entries.find((entry) => entry.customType === "brainstorm-forcer-ledger");
    expect(ledgerEntry?.data).toMatchObject({
      runId: expect.stringMatching(/^brainstorm-/),
      record: {
        id: "EV-001",
        kind: "evidence",
        toolName: "read",
        status: "success",
      },
    });
    expect(JSON.stringify(ledgerEntry)).not.toContain("must-not-persist");
    expect(JSON.stringify(ledgerEntry)).not.toContain("raw tool output");
    expect(result.content.at(-1).text).toContain("Captured as EV-001");
  });

  it("labels a cancelled choice as semantically ineligible", async () => {
    const { pi, tools, handlers, commands, entries } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    const command = commands.get("brainstorm")!;
    await command.handler("topic", ctx);
    await command.handler("phase exploring", ctx);

    const result = await handlers.get("tool_result")!(
      {
        type: "tool_result",
        toolCallId: "choice-cancelled",
        toolName: "ask_user_question",
        input: { questions: [{ question: "Which approach?" }] },
        content: [{ type: "text", text: "User declined to answer questions" }],
        details: { answers: [], cancelled: true },
        isError: false,
      },
      ctx,
    );

    expect(entries.find((entry) => entry.customType === "brainstorm-forcer-ledger")?.data).toMatchObject({
      record: {
        id: "EV-001",
        status: "success",
        sourceKind: "ineligible",
        userChoiceCancelled: true,
      },
    });
    expect(result.content.at(-1).text).toContain(
      "transport=success; semantic=cancelled; final-choice=ineligible",
    );
    expect(
      (
        await tools
          .get("brainstorm_transition")!
          .execute("status", { action: "status" }, undefined, undefined, ctx)
      ).details.exploringStatus.finalChoice,
    ).toBe("cancelled");

    await handlers.get("tool_result")!(
      {
        type: "tool_result",
        toolCallId: "choice-error",
        toolName: "ask_user_question",
        input: { questions: [{ question: "Which approach?" }] },
        content: [{ type: "text", text: "Question failed" }],
        details: { answers: [], cancelled: true },
        isError: true,
      },
      ctx,
    );
    expect(
      (
        await tools
          .get("brainstorm_transition")!
          .execute("status", { action: "status" }, undefined, undefined, ctx)
      ).details.exploringStatus.finalChoice,
    ).toBe("required");
  });

  it("records a qualified Exploring claim through its dedicated tool", async () => {
    const { pi, handlers, commands, tools, entries } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    await commands.get("brainstorm")!.handler("topic", ctx);
    await commands.get("brainstorm")!.handler("phase exploring", ctx);
    await handlers.get("tool_result")!(
      {
        type: "tool_result",
        toolCallId: "read-1",
        toolName: "read",
        input: { path: "index.ts" },
        content: [{ type: "text", text: "observable result" }],
        details: undefined,
        isError: false,
      },
      ctx,
    );

    const result = await tools.get("brainstorm_record_claim")!.execute(
      "claim-1",
      {
        assertion: "The transition gate is centralized.",
        classification: "empirical",
        critical: true,
        verdict: "verified",
        evidenceIds: ["EV-001"],
        contradictoryEvidenceIds: [],
        impact: "Controls all forward transitions.",
        verificationDomain: "local-code",
        architectureImpact: false,
        mitigation: "Keep one shared blocker.",
      },
      undefined,
      undefined,
      ctx,
    );

    expect(result.details.record).toMatchObject({ id: "CL-001", kind: "claim" });
    expect(entries.at(-1)).toMatchObject({
      customType: "brainstorm-forcer-ledger",
      data: { record: { id: "CL-001" } },
    });
  });

  it("spawns one owned async verification and appends EV/RV only from exact structured completion", async () => {
    const fixture = await createVerificationAsyncDirFixture(
      "owned-verification-run",
    );
    try {
    const { pi, handlers, commands, tools, entries, events } = createMockAPI();
    const ctx = createMockContext();
    const rpcRequests = installVerificationRpcBridge(
      events,
      "test-session-id",
      "owned-verification-run",
      fixture.asyncDir,
    );
    let selectedPreflightAgents: readonly string[] | undefined;
    brainstormForcer(pi, {
      preflight: async (_sessionId, _cwd, agents) => {
        selectedPreflightAgents = agents;
        return agents.map((agent) => ({ agent, ok: true }));
      },
    });
    await commands.get("brainstorm")!.handler("topic", ctx);
    await commands.get("brainstorm")!.handler("phase exploring", ctx);
    await handlers.get("tool_result")!(
      {
        type: "tool_result",
        toolCallId: "read-1",
        toolName: "read",
        input: { path: "index.ts" },
        content: [{ type: "text", text: "observable result" }],
        details: undefined,
        isError: false,
      },
      ctx,
    );
    await tools.get("brainstorm_record_claim")!.execute(
      "claim-1",
      {
        assertion: "The transition gate is centralized.",
        classification: "empirical",
        critical: true,
        verdict: "verified",
        evidenceIds: ["EV-001"],
        contradictoryEvidenceIds: [],
        impact: "Controls all forward transitions.",
        verificationDomain: "local-code",
        architectureImpact: false,
        mitigation: "Keep one shared blocker.",
      },
      undefined,
      undefined,
      ctx,
    );

    const launch = await tools.get("brainstorm_run_verification")!.execute(
      "verification-1",
      { claimIds: ["CL-001"] },
      undefined,
      undefined,
      ctx,
    );
    expect(launch.details).toMatchObject({
      runId: "owned-verification-run",
      status: "pending",
      claimIds: ["CL-001"],
    });
    const spawn = rpcRequests.find((request) => request.method === "spawn")!;
    expect(spawn.params).toMatchObject({
      async: true,
      context: "fresh",
      clarify: false,
    });
    expect(JSON.stringify(spawn.params)).not.toContain('"agent":"architect"');
    expect(selectedPreflightAgents).toEqual(["scout"]);
    expect(entries.at(-1)).toMatchObject({
      customType: "brainstorm-forcer",
      data: {
        pendingVerification: {
          ownerSessionId: "test-session-id",
          ownerSessionFile: join(tmpdir(), "test-session-id.jsonl"),
        },
      },
    });

    await emitSuccessfulLocalCodeVerification(
      events,
      "owned-verification-run",
      join(tmpdir(), "test-session-id.jsonl"),
      fixture.asyncDir,
    );
    await Bun.sleep(0);

    const verificationRecords = entries
      .filter((entry) => entry.customType === "brainstorm-forcer-ledger")
      .map((entry) => (entry.data as any).record)
      .filter((record) => record.id === "EV-002" || record.id === "RV-001");
    expect(verificationRecords).toMatchObject([
      {
        id: "EV-002",
        sourceKind: "secondary",
        verifier: { agent: "scout", role: "verifier" },
      },
      {
        id: "RV-001",
        verifierEvidenceId: "EV-002",
        audit: { status: "success" },
      },
    ]);
    expect(entries.some((entry) => JSON.stringify(entry).includes("VR-"))).toBe(
      false,
    );

    const terminalLedgerCount = entries.filter(
      (entry) => entry.customType === "brainstorm-forcer-ledger",
    ).length;
    events.emit("subagent:async-complete", {
      runId: "owned-verification-run",
      sessionId: join(tmpdir(), "test-session-id.jsonl"),
    });
    await Bun.sleep(0);
    expect(
      entries.filter(
        (entry) => entry.customType === "brainstorm-forcer-ledger",
      ),
    ).toHaveLength(terminalLedgerCount);

    await tools.get("brainstorm_record_claim")!.execute(
      "claim-architecture",
      {
        assertion: "The verifier boundary is acyclic.",
        classification: "empirical",
        critical: false,
        verdict: "verified",
        evidenceIds: ["EV-001"],
        contradictoryEvidenceIds: [],
        impact: "Controls the dependency graph.",
        verificationDomain: "local-code",
        architectureImpact: true,
        mitigation: "Keep the boundary acyclic.",
      },
      undefined,
      undefined,
      ctx,
    );
    await tools.get("brainstorm_run_verification")!.execute(
      "verification-architecture",
      { claimIds: ["CL-002"] },
      undefined,
      undefined,
      ctx,
    );
    expect(selectedPreflightAgents).toEqual(["scout", "architect"]);
    } finally {
      await rm(fixture.scopeDir, { recursive: true, force: true });
    }
  });

  it("rejects a foreign RPC session file before spawning verification", async () => {
    const fixture = await createVerificationAsyncDirFixture(
      "foreign-owner-run",
    );
    const api = createMockAPI();
    const ctx = createMockContext();
    try {
      const requests = installVerificationRpcBridge(
        api.events,
        "test-session-id",
        "foreign-owner-run",
        fixture.asyncDir,
        join(tmpdir(), "foreign-session.jsonl"),
      );
      brainstormForcer(api.pi, {
        preflight: async (_sessionId, _cwd, agents) =>
          agents.map((agent) => ({ agent, ok: true })),
      });

      await expectRejection(
        enterPendingLocalCodeVerification(api, ctx),
        "RPC bridge session",
      );
      expect(requests.some((request) => request.method === "spawn")).toBe(
        false,
      );
    } finally {
      await rm(fixture.scopeDir, { recursive: true, force: true });
    }
  });

  it("uses the owned lifecycle-v3 artifact for natural completion details", async () => {
    const runId = "artifact-owned-run";
    const fixture = await createVerificationAsyncDirFixture(runId);
    const api = createMockAPI();
    const ctx = createMockContext();
    const sessionFile = ctx.sessionManager.getSessionFile()!;
    try {
      installVerificationRpcBridge(
        api.events,
        "test-session-id",
        runId,
        fixture.asyncDir,
        sessionFile,
      );
      brainstormForcer(api.pi, {
        preflight: async (_sessionId, _cwd, agents) =>
          agents.map((agent) => ({ agent, ok: true })),
      });
      await enterPendingLocalCodeVerification(api, ctx);
      const structuredOutput = {
        outcome: "supported",
        claimIds: ["CL-001"],
        evidenceIds: ["EV-001"],
        summary: "Trusted lifecycle output.",
      };
      await writeFile(
        join(fixture.asyncDir, "status.json"),
        JSON.stringify({
          lifecycleArtifactVersion: 3,
          runId,
          sessionId: sessionFile,
          mode: "chain",
          state: "complete",
          steps: [
            {
              agent: "scout",
              context: "fresh",
              outputName: "verify_local_code_supported",
              status: "complete",
              exitCode: 0,
              structuredOutput,
            },
          ],
          outputs: {
            "verify_local_code_supported": {
              agent: "scout",
              stepIndex: 0,
              structured: structuredOutput,
            },
          },
        }),
      );

      api.events.emit("subagent:async-complete", {
        runId,
        sessionId: sessionFile,
        success: true,
        state: "complete",
        exitCode: 0,
        results: [],
        outputs: {},
      });
      await Bun.sleep(0);

      expect(
        api.entries
          .filter(
            (entry) => entry.customType === "brainstorm-forcer-ledger",
          )
          .map((entry) => (entry.data as any).record)
          .find((record) => record.id === "RV-001"),
      ).toMatchObject({ audit: { status: "success" } });
    } finally {
      await rm(fixture.scopeDir, { recursive: true, force: true });
    }
  });

  it("records an owned stopped lifecycle artifact as failed, not malformed", async () => {
    const runId = "owned-stopped-run";
    const fixture = await createVerificationAsyncDirFixture(runId);
    const api = createMockAPI();
    const ctx = createMockContext();
    const sessionFile = ctx.sessionManager.getSessionFile()!;
    try {
      installVerificationRpcBridge(
        api.events,
        "test-session-id",
        runId,
        fixture.asyncDir,
        sessionFile,
      );
      brainstormForcer(api.pi, {
        preflight: async (_sessionId, _cwd, agents) =>
          agents.map((agent) => ({ agent, ok: true })),
      });
      await enterPendingLocalCodeVerification(api, ctx);
      await writeFile(
        join(fixture.asyncDir, "status.json"),
        JSON.stringify({
          lifecycleArtifactVersion: 3,
          runId,
          sessionId: sessionFile,
          mode: "chain",
          state: "stopped",
          stopped: true,
          error: "Subagent stopped by user.",
          steps: [
            {
              agent: "scout",
              context: "fresh",
              outputName: "verify_local_code_supported",
              status: "stopped",
              exitCode: 1,
              stopped: true,
              error: "Subagent stopped by user.",
            },
          ],
          outputs: {
            "verify_local_code_supported": {
              text: "Subagent stopped by user.",
              agent: "scout",
              stepIndex: 0,
            },
          },
        }),
      );

      api.events.emit("subagent:async-complete", {
        runId,
        sessionId: sessionFile,
        success: false,
        state: "stopped",
        stopped: true,
        error: "Subagent stopped by user.",
        exitCode: 1,
        results: [
          {
            agent: "scout",
            context: "fresh",
            status: "stopped",
            success: false,
            stopped: true,
            error: "Subagent stopped by user.",
          },
        ],
      });
      await Bun.sleep(0);

      const terminalRecords = api.entries
        .filter(
          (entry) => entry.customType === "brainstorm-forcer-ledger",
        )
        .map((entry) => (entry.data as any).record);
      expect(
        terminalRecords.find((record) => record.id === "RV-001"),
      ).toMatchObject({
        audit: {
          status: "failed",
          reason: "Subagent stopped by user.",
        },
      });
      expect(
        terminalRecords.some(
          (record) => record.kind === "evidence" && record.verifier,
        ),
      ).toBe(false);
      expect(api.entries.at(-1)).toMatchObject({
        customType: "brainstorm-forcer",
        data: { pendingVerification: null },
      });
    } finally {
      await rm(fixture.scopeDir, { recursive: true, force: true });
    }
  });

  it("ignores missing or foreign live owners and preserves pending", async () => {
    const runId = "foreign-live-owner-run";
    const fixture = await createVerificationAsyncDirFixture(runId);
    const api = createMockAPI();
    const ctx = createMockContext();
    try {
      installVerificationRpcBridge(
        api.events,
        "test-session-id",
        runId,
        fixture.asyncDir,
      );
      brainstormForcer(api.pi, {
        preflight: async (_sessionId, _cwd, agents) =>
          agents.map((agent) => ({ agent, ok: true })),
      });
      await enterPendingLocalCodeVerification(api, ctx);

      api.events.emit("subagent:async-complete", {
        runId,
        success: false,
        state: "failed",
        exitCode: 1,
      });
      api.events.emit("subagent:async-complete", {
        runId,
        sessionId: join(tmpdir(), "foreign-session.jsonl"),
        success: false,
        state: "failed",
        exitCode: 1,
      });
      await Bun.sleep(0);

      expect(
        api.entries.some(
          (entry) => (entry.data as any)?.record?.id === "RV-001",
        ),
      ).toBe(false);
      expect(api.entries.at(-1)).toMatchObject({
        customType: "brainstorm-forcer",
        data: { pendingVerification: { runId } },
      });
    } finally {
      await rm(fixture.scopeDir, { recursive: true, force: true });
    }
  });

  it("quarantines a legacy UUID-only pending snapshot on restore", async () => {
    const runId = "legacy-owner-run";
    const fixture = await createVerificationAsyncDirFixture(runId);
    try {
      const first = createMockAPI();
      const firstContext = createMockContext();
      installVerificationRpcBridge(
        first.events,
        "test-session-id",
        runId,
        fixture.asyncDir,
      );
      brainstormForcer(first.pi, {
        preflight: async (_sessionId, _cwd, agents) =>
          agents.map((agent) => ({ agent, ok: true })),
      });
      await enterPendingLocalCodeVerification(first, firstContext);

      const legacyEntries = structuredClone(
        first.entries.map((entry) => ({ type: "custom", ...entry })),
      );
      const legacySnapshot = legacyEntries.findLast(
        (entry) => entry.customType === "brainstorm-forcer",
      )!.data as any;
      delete legacySnapshot.pendingVerification.ownerSessionFile;

      const restored = createMockAPI();
      const restoredContext = createMockContext(legacyEntries);
      brainstormForcer(restored.pi, { rpcTimeoutMs: 20 });
      await restored.handlers.get("session_start")!(
        { type: "session_start" },
        restoredContext,
      );

      expect(restored.entries.at(-1)).toMatchObject({
        customType: "brainstorm-forcer",
        data: { pendingVerification: null },
      });
      expect(restoredContext.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("ownership metadata"),
        "warning",
      );
    } finally {
      await rm(fixture.scopeDir, { recursive: true, force: true });
    }
  });

  it("preserves restored pending when the RPC bridge has a foreign session file", async () => {
    const runId = "foreign-restored-owner-run";
    const fixture = await createVerificationAsyncDirFixture(runId);
    const sessionFile = join(tmpdir(), "test-session-id.jsonl");
    try {
      const first = createMockAPI();
      const firstContext = createMockContext();
      installVerificationRpcBridge(
        first.events,
        "test-session-id",
        runId,
        fixture.asyncDir,
        sessionFile,
      );
      brainstormForcer(first.pi, {
        preflight: async (_sessionId, _cwd, agents) =>
          agents.map((agent) => ({ agent, ok: true })),
      });
      await enterPendingLocalCodeVerification(first, firstContext);
      const structuredOutput = {
        outcome: "supported",
        claimIds: ["CL-001"],
        evidenceIds: ["EV-001"],
        summary: "Trusted lifecycle output.",
      };
      await writeFile(
        join(fixture.asyncDir, "status.json"),
        JSON.stringify({
          lifecycleArtifactVersion: 3,
          runId,
          sessionId: sessionFile,
          mode: "chain",
          state: "complete",
          steps: [
            {
              agent: "scout",
              context: "fresh",
              outputName: "verify_local_code_supported",
              status: "complete",
              exitCode: 0,
              structuredOutput,
            },
          ],
          outputs: {
            "verify_local_code_supported": {
              agent: "scout",
              stepIndex: 0,
              structured: structuredOutput,
            },
          },
        }),
      );

      const restored = createMockAPI();
      const restoredContext = createMockContext(
        first.entries.map((entry) => ({ type: "custom", ...entry })),
      );
      installVerificationRpcBridge(
        restored.events,
        "test-session-id",
        runId,
        fixture.asyncDir,
        join(tmpdir(), "foreign-session.jsonl"),
      );
      brainstormForcer(restored.pi);
      await restored.handlers.get("session_start")!(
        { type: "session_start" },
        restoredContext,
      );

      expect(
        restored.entries.some(
          (entry) => (entry.data as any)?.record?.id === "RV-001",
        ),
      ).toBe(false);
      expect(restored.entries.at(-1)).toMatchObject({
        customType: "brainstorm-forcer",
        data: { pendingVerification: { runId } },
      });
    } finally {
      await rm(fixture.scopeDir, { recursive: true, force: true });
    }
  });

  it("covers needs-attention→control→EV/RV→question→artifact→Presenting through registered extension seams", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-p1-"));
    const fixture = await createVerificationAsyncDirFixture(
      "p1-verification-run",
    );
    try {
      const { pi, handlers, commands, tools, entries, events } = createMockAPI();
      const ctx = createMockContext(
        undefined,
        projectRoot,
        "p1-verification-session",
      );
      installVerificationRpcBridge(
        events,
        "p1-verification-session",
        "p1-verification-run",
        fixture.asyncDir,
      );
      brainstormForcer(pi, {
        preflight: async (_sessionId, _cwd, agents) =>
          agents.map((agent) => ({ agent, ok: true })),
      });
      await commands.get("brainstorm")!.handler("P1 workflow", ctx);
      await commands.get("brainstorm")!.handler("phase exploring", ctx);
      await handlers.get("tool_result")!(
        {
          type: "tool_result",
          toolCallId: "read-p1",
          toolName: "read",
          input: { path: "index.ts" },
          content: [{ type: "text", text: "observable result" }],
          details: undefined,
          isError: false,
        },
        ctx,
      );
      await tools.get("brainstorm_record_claim")!.execute(
        "claim-p1",
        {
          assertion: "The transition gate is centralized.",
          classification: "empirical",
          critical: true,
          verdict: "verified",
          evidenceIds: ["EV-001"],
          contradictoryEvidenceIds: [],
          impact: "Controls all forward transitions.",
          verificationDomain: "local-code",
          architectureImpact: false,
          mitigation: "Keep one shared blocker.",
        },
        undefined,
        undefined,
        ctx,
      );
      await tools.get("brainstorm_run_verification")!.execute(
        "verify-p1",
        { claimIds: ["CL-001"] },
        undefined,
        undefined,
        ctx,
      );
      const blockedQuestion = await handlers.get("tool_call")!(
        { toolName: "ask_user_question", input: {} },
        ctx,
      );
      expect(blockedQuestion.reason).toContain(
        "blocked while verification run p1-verification-run is pending",
      );
      for (const input of [
        { action: "status", id: "p1-verification-run" },
        {
          action: "steer",
          id: "p1-verification-run",
          message: "Address the needs-attention blocker.",
          index: 0,
        },
      ]) {
        expect(
          await handlers.get("tool_call")!(
            { toolName: "subagent", input },
            ctx,
          ),
        ).toBeUndefined();
        expect(
          await handlers.get("tool_result")!(
            {
              type: "tool_result",
              toolCallId: `control-${input.action}`,
              toolName: "subagent",
              input,
              content: [
                {
                  type: "text",
                  text:
                    input.action === "status"
                      ? "Run needs attention."
                      : "Steering delivered.",
                },
              ],
              details: { mode: "management", results: [] },
              isError: false,
            },
            ctx,
          ),
        ).toBeUndefined();
      }
      expect(
        entries
          .filter(
            (entry) => entry.customType === "brainstorm-forcer-ledger",
          )
          .map((entry) => (entry.data as any).record.id),
      ).toEqual(["EV-001", "CL-001"]);
      const submission = {
        approaches: [
          {
            title: "Central gate",
            summary: "Keep one transition gate.",
            tradeoffs: ["The gate owns phase policy."],
            claimIds: ["CL-001"],
            failureConditions: ["A transition bypasses the gate."],
          },
          {
            title: "Distributed gates",
            summary: "Let each phase own a transition gate.",
            tradeoffs: ["Policy can diverge."],
            claimIds: ["CL-001"],
            failureConditions: ["Phase gates disagree."],
          },
        ],
        recommendation: "Use the central gate.",
        recommendationClaimIds: ["CL-001"],
        userChoice: "Central gate",
        userChoiceEvidenceId: "EV-999",
      };
      const pendingSubmission = await tools
        .get("brainstorm_submit_exploring")!
        .execute("submit-pending", submission, undefined, undefined, ctx);
      expect(pendingSubmission.details).toMatchObject({ blocked: true });
      expect(await readdir(projectRoot)).toEqual([]);

      await emitSuccessfulLocalCodeVerification(
        events,
        "p1-verification-run",
        join(tmpdir(), "p1-verification-session.jsonl"),
        fixture.asyncDir,
      );
      await Bun.sleep(0);
      expect(
        entries
          .filter(
            (entry) => entry.customType === "brainstorm-forcer-ledger",
          )
          .map((entry) => (entry.data as any).record.id),
      ).toEqual(["EV-001", "CL-001", "EV-002", "RV-001"]);
      expect(
        await handlers.get("tool_call")!(
          { toolName: "ask_user_question", input: {} },
          ctx,
        ),
      ).toBeUndefined();
      await handlers.get("tool_result")!(
        {
          type: "tool_result",
          toolCallId: "choice-p1",
          toolName: "ask_user_question",
          input: { questions: [{ question: "Which approach?" }] },
          content: [{ type: "text", text: "Central gate" }],
          details: {
            cancelled: false,
            answers: [
              {
                questionIndex: 0,
                question: "Which approach?",
                kind: "option",
                answer: "Central gate",
              },
            ],
          },
          isError: false,
        },
        ctx,
      );

      const exploring = await tools
        .get("brainstorm_submit_exploring")!
        .execute(
          "submit-complete",
          { ...submission, userChoiceEvidenceId: "EV-003" },
          undefined,
          undefined,
          ctx,
        );
      expect(exploring.details.artifact).toMatchObject({ revision: 1 });
      expect(exploring.details.artifact.path).toEndWith(
        "03-exploring-r001.md",
      );
      const manifest = JSON.parse(
        await readFile(
          join(projectRoot, exploring.details.artifact.manifestPath),
          "utf8",
        ),
      ) as {
        activeRevisions: { exploring?: number };
        revisions: Array<{
          phase: string;
          revision: number;
          status: string;
        }>;
      };
      expect(manifest.activeRevisions.exploring).toBe(1);
      const exploringRevisions = manifest.revisions.filter(
        (revision) => revision.phase === "exploring",
      );
      expect(exploringRevisions).toHaveLength(1);
      expect(exploringRevisions[0]).toMatchObject({
        revision: 1,
        status: "active",
      });

      const transition = await tools
        .get("brainstorm_transition")!
        .execute("next-p1", { action: "next" }, undefined, undefined, ctx);
      expect(transition.details).toMatchObject({
        phase: "presenting",
        approved: true,
      });
      await tools.get("brainstorm_submit_presenting")!.execute(
        "present-p1",
        {
          sections: [
            {
              title: "Architecture",
              content: "Use one transition gate.",
            },
          ],
          decisions: ["Keep the gate centralized."],
          approved: true,
        },
        undefined,
        undefined,
        ctx,
      );
      const manifestPath = join(
        projectRoot,
        exploring.details.artifact.manifestPath,
      );
      const manifestBeforeBlockedResubmission = await readFile(
        manifestPath,
        "utf8",
      );
      await tools
        .get("brainstorm_transition")!
        .execute("previous-p1", { action: "previous" }, undefined, undefined, ctx);
      const blockedResubmission = await tools
        .get("brainstorm_submit_exploring")!
        .execute(
          "blocked-resubmit-p1",
          {
            ...submission,
            userChoice: "Distributed gates",
            userChoiceEvidenceId: "EV-003",
          },
          undefined,
          undefined,
          ctx,
        );
      expect(blockedResubmission.details).toMatchObject({ blocked: true });
      expect(await readFile(manifestPath, "utf8")).toBe(
        manifestBeforeBlockedResubmission,
      );
      const returnedToPresenting = await tools
        .get("brainstorm_transition")!
        .execute(
          "return-presenting-p1",
          { action: "next" },
          undefined,
          undefined,
          ctx,
        );
      expect(returnedToPresenting.details).toMatchObject({
        phase: "presenting",
      });
      const advancedToDocumenting = await tools
        .get("brainstorm_transition")!
        .execute(
          "next-documenting-p1",
          { action: "next" },
          undefined,
          undefined,
          ctx,
        );
      expect(advancedToDocumenting.details).toMatchObject({
        phase: "documenting",
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(fixture.scopeDir, { recursive: true, force: true });
    }
  });

  it("audits malformed owned completion without accepting its outcome", async () => {
    const fixture = await createVerificationAsyncDirFixture(
      "owned-verification-run",
    );
    try {
    const { pi, handlers, commands, tools, entries, events } = createMockAPI();
    const ctx = createMockContext();
    installVerificationRpcBridge(
      events,
      "test-session-id",
      "owned-verification-run",
      fixture.asyncDir,
    );
    brainstormForcer(pi, {
      preflight: async (_sessionId, _cwd, agents) =>
        agents.map((agent) => ({ agent, ok: true })),
    });
    await commands.get("brainstorm")!.handler("topic", ctx);
    await commands.get("brainstorm")!.handler("phase exploring", ctx);
    await handlers.get("tool_result")!(
      {
        type: "tool_result",
        toolCallId: "read-1",
        toolName: "read",
        input: { path: "index.ts" },
        content: [{ type: "text", text: "observable result" }],
        details: undefined,
        isError: false,
      },
      ctx,
    );
    await tools.get("brainstorm_record_claim")!.execute(
      "claim-1",
      {
        assertion: "The transition gate is centralized.",
        classification: "empirical",
        critical: true,
        verdict: "verified",
        evidenceIds: ["EV-001"],
        contradictoryEvidenceIds: [],
        impact: "Controls all forward transitions.",
        verificationDomain: "local-code",
        architectureImpact: false,
        mitigation: "Keep one shared blocker.",
      },
      undefined,
      undefined,
      ctx,
    );
    await tools.get("brainstorm_run_verification")!.execute(
      "verification-1",
      { claimIds: ["CL-001"] },
      undefined,
      undefined,
      ctx,
    );

    await writeFile(
      join(fixture.asyncDir, "status.json"),
      JSON.stringify({
        lifecycleArtifactVersion: 3,
        runId: "owned-verification-run",
        sessionId: join(tmpdir(), "test-session-id.jsonl"),
        mode: "chain",
        state: "complete",
        steps: [
          {
            agent: "scout",
            context: "fresh",
            outputName: "verify_local_code_supported",
            status: "complete",
            exitCode: 0,
          },
        ],
        outputs: {},
      }),
    );
    events.emit("subagent:async-complete", {
      runId: "owned-verification-run",
      sessionId: join(tmpdir(), "test-session-id.jsonl"),
      success: true,
      state: "complete",
      exitCode: 0,
      results: [],
      outputs: {},
    });
    await Bun.sleep(0);

    const terminalRecords = entries
      .filter((entry) => entry.customType === "brainstorm-forcer-ledger")
      .map((entry) => (entry.data as any).record);
    expect(terminalRecords).toContainEqual(
      expect.objectContaining({
        id: "RV-001",
        audit: expect.objectContaining({ status: "malformed" }),
      }),
    );
    expect(
      terminalRecords.some(
        (record) => record.kind === "evidence" && record.verifier,
      ),
    ).toBe(false);
    } finally {
      await rm(fixture.scopeDir, { recursive: true, force: true });
    }
  });

  it("contains auditVerificationFailure errors at the async completion boundary", async () => {
    const fixture = await createVerificationAsyncDirFixture(
      "audit-boundary-run",
    );
    const api = createMockAPI();
    const ctx = createMockContext();
    try {
      installVerificationRpcBridge(
        api.events,
        "test-session-id",
        "audit-boundary-run",
        fixture.asyncDir,
      );
      brainstormForcer(api.pi, {
        preflight: async (_sessionId, _cwd, agents) =>
          agents.map((agent) => ({ agent, ok: true })),
      });
      await enterPendingLocalCodeVerification(api, ctx);

      await writeFile(
        join(fixture.asyncDir, "status.json"),
        JSON.stringify({
          lifecycleArtifactVersion: 3,
          runId: "audit-boundary-run",
          sessionId: join(tmpdir(), "test-session-id.jsonl"),
          mode: "chain",
          state: "failed",
          error: "   ",
          steps: [
            {
              agent: "scout",
              context: "fresh",
              outputName: "verify_local_code_supported",
              status: "failed",
              exitCode: 1,
            },
          ],
          outputs: {},
        }),
      );
      let unhandled: unknown;
      const captureUnhandled = (reason: unknown) => {
        unhandled = reason;
      };
      process.once("unhandledRejection", captureUnhandled);
      api.events.emit("subagent:async-complete", {
        runId: "audit-boundary-run",
        sessionId: join(tmpdir(), "test-session-id.jsonl"),
        success: false,
        state: "failed",
        exitCode: 1,
        error: "   ",
      });
      await Bun.sleep(10);
      process.off("unhandledRejection", captureUnhandled);

      expect(unhandled).toBeUndefined();
      expect(api.entries.at(-1)).toMatchObject({
        customType: "brainstorm-forcer",
        data: { pendingVerification: null },
      });
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("audit skipped"),
        "warning",
      );
    } finally {
      await rm(fixture.scopeDir, { recursive: true, force: true });
    }
  });

  it("contains audit notification failures during session_start reconciliation", async () => {
    const fixture = await createVerificationAsyncDirFixture(
      "eventbus-audit-boundary-run",
    );
    try {
      const first = createMockAPI();
      const firstContext = createMockContext(
        undefined,
        process.cwd(),
        "eventbus-audit-session",
      );
      installVerificationRpcBridge(
        first.events,
        "eventbus-audit-session",
        "eventbus-audit-boundary-run",
        fixture.asyncDir,
      );
      brainstormForcer(first.pi, {
        preflight: async (_sessionId, _cwd, agents) =>
          agents.map((agent) => ({ agent, ok: true })),
      });
      await enterPendingLocalCodeVerification(first, firstContext);

      const restored = createMockAPI();
      const restoredContext = createMockContext(
        first.entries.map((entry) => ({ type: "custom", ...entry })),
        process.cwd(),
        "eventbus-audit-session",
      );
      (restoredContext.ui.notify as any).mockImplementation(() => {
        throw new Error("notification renderer failed");
      });
      brainstormForcer(restored.pi, { rpcTimeoutMs: 1 });

      await expect(
        restored.handlers.get("session_start")!(
          { type: "session_start" },
          restoredContext,
        ),
      ).resolves.toBeUndefined();
      expect(restored.entries.at(-1)).toMatchObject({
        customType: "brainstorm-forcer",
        data: { pendingVerification: null },
      });
    } finally {
      await rm(fixture.scopeDir, { recursive: true, force: true });
    }
  });

  it("contains stderr failures at the final async completion boundary", async () => {
    const fixture = await createVerificationAsyncDirFixture(
      "stderr-boundary-run",
    );
    const api = createMockAPI();
    const ctx = createMockContext();
    const originalStderrWrite = process.stderr.write;
    let unhandled: unknown;
    const captureUnhandled = (reason: unknown) => {
      unhandled = reason;
    };
    try {
      installVerificationRpcBridge(
        api.events,
        "test-session-id",
        "stderr-boundary-run",
        fixture.asyncDir,
      );
      brainstormForcer(api.pi, {
        preflight: async (_sessionId, _cwd, agents) =>
          agents.map((agent) => ({ agent, ok: true })),
      });
      await enterPendingLocalCodeVerification(api, ctx);
      (ctx.ui.notify as any).mockImplementation(() => {
        throw new Error("x".repeat(2_000));
      });
      (process.stderr as any).write = () => {
        throw new Error("stderr failed");
      };
      process.once("unhandledRejection", captureUnhandled);

      await emitSuccessfulLocalCodeVerification(
        api.events,
        "stderr-boundary-run",
        join(tmpdir(), "test-session-id.jsonl"),
        fixture.asyncDir,
      );
      await Bun.sleep(10);
    } finally {
      process.off("unhandledRejection", captureUnhandled);
      (process.stderr as any).write = originalStderrWrite;
      await rm(fixture.scopeDir, { recursive: true, force: true });
    }
    expect(unhandled).toBeUndefined();
  });

  it("keeps one completion audit when post-commit notification fails during reconciliation", async () => {
    const restoredRunId = "restored-verification-run";
    const fixture = await createVerificationAsyncDirFixture(restoredRunId);
    const { asyncDir } = fixture;
    const sessionFile = join(
      tmpdir(),
      "reload-verification-session.jsonl",
    );
    try {
    const first = createMockAPI();
    const firstContext = createMockContext(
      undefined,
      process.cwd(),
      "reload-verification-session",
    );
    installVerificationRpcBridge(
      first.events,
      "reload-verification-session",
      restoredRunId,
      asyncDir,
    );
    brainstormForcer(first.pi, {
      preflight: async (_sessionId, _cwd, agents) =>
        agents.map((agent) => ({ agent, ok: true })),
    });
    await first.commands.get("brainstorm")!.handler("topic", firstContext);
    await first.commands.get("brainstorm")!.handler(
      "phase exploring",
      firstContext,
    );
    await first.handlers.get("tool_result")!(
      {
        type: "tool_result",
        toolCallId: "read-1",
        toolName: "read",
        input: { path: "index.ts" },
        content: [{ type: "text", text: "observable result" }],
        details: undefined,
        isError: false,
      },
      firstContext,
    );
    await first.tools.get("brainstorm_record_claim")!.execute(
      "claim-1",
      {
        assertion: "The transition gate is centralized.",
        classification: "empirical",
        critical: true,
        verdict: "verified",
        evidenceIds: ["EV-001"],
        contradictoryEvidenceIds: [],
        impact: "Controls all forward transitions.",
        verificationDomain: "local-code",
        architectureImpact: false,
        mitigation: "Keep one shared blocker.",
      },
      undefined,
      undefined,
      firstContext,
    );
    await first.tools.get("brainstorm_run_verification")!.execute(
      "verification-1",
      { claimIds: ["CL-001"] },
      undefined,
      undefined,
      firstContext,
    );
    await writeFile(
      join(asyncDir, "status.json"),
      JSON.stringify({
        lifecycleArtifactVersion: 3,
        runId: restoredRunId,
        sessionId: sessionFile,
        mode: "chain",
        state: "running",
        startedAt: Date.now(),
        steps: [
          {
            agent: "scout",
            context: "fresh",
            outputName: "verify_local_code_supported",
            status: "running",
          },
        ],
      }),
    );

    const restoredEntries = first.entries.map((entry) => ({
      type: "custom",
      ...entry,
    }));
    expect(JSON.stringify(restoredEntries)).toContain(`"asyncDir":"${asyncDir}"`);
    const second = createMockAPI();
    const secondContext = createMockContext(
      restoredEntries,
      process.cwd(),
      "reload-verification-session",
    );
    const requests = installVerificationRpcBridge(
      second.events,
      "reload-verification-session",
      "unused",
      asyncDir,
    );
    brainstormForcer(second.pi, {
      preflight: async (_sessionId, _cwd, agents) =>
        agents.map((agent) => ({ agent, ok: true })),
    });
    await second.handlers.get("session_start")!({}, secondContext);

    expect(requests.some((request) => request.method === "status")).toBe(true);
    const statusContext = await second.handlers.get("context")!(
      { messages: [] },
      secondContext,
    );
    expect(statusContext.messages[0].content).toContain(
      "Verification: pending restored-verification-run",
    );
    expect(statusContext.messages[0].content).toContain(
      "Required successful reviews missing: CL-001",
    );
    expect(
      (secondContext.ui.setWidget as any).mock.calls
        .at(-1)[1][0],
    ).toContain("action:waitVerification");

    const structuredOutput = {
      outcome: "supported",
      claimIds: ["CL-001"],
      evidenceIds: ["EV-001"],
      summary: "Critical claim is supported by direct evidence.",
    };
    const terminalEvent = {
      runId: restoredRunId,
      sessionId: sessionFile,
      success: true,
      state: "complete",
      exitCode: 0,
      results: [
        {
          agent: "scout",
          context: "fresh",
          status: "completed",
          success: true,
          structuredOutput,
        },
      ],
      outputs: {
        "verify_local_code_supported": {
          text: JSON.stringify(structuredOutput),
          structured: structuredOutput,
          agent: "scout",
          stepIndex: 0,
        },
      },
    };
    await writeFile(
      join(asyncDir, "status.json"),
      JSON.stringify({
        lifecycleArtifactVersion: 3,
        runId: restoredRunId,
        sessionId: sessionFile,
        mode: "chain",
        state: "complete",
        startedAt: Date.now() - 100,
        endedAt: Date.now(),
        steps: [
          {
            agent: "scout",
            context: "fresh",
            outputName: "verify_local_code_supported",
            status: "completed",
            exitCode: 0,
            structuredOutput,
          },
        ],
        outputs: terminalEvent.outputs,
      }),
    );
    (secondContext.ui.notify as any).mockImplementation((message: string) => {
      if (message.includes("completed and audited"))
        throw new Error("post-commit notification failed");
    });
    await expect(
      second.handlers.get("session_start")!({}, secondContext),
    ).rejects.toThrow("post-commit notification failed");

    expect(
      second.entries
        .filter((entry) => entry.customType === "brainstorm-forcer-ledger")
        .map((entry) => (entry.data as any).record.id),
    ).toEqual(["EV-002", "RV-001"]);
    expect(
      (second.entries.at(-1)!.data as any).pendingVerification,
    ).toBeNull();
    const terminalLedgerCount = second.entries.filter(
      (entry) => entry.customType === "brainstorm-forcer-ledger",
    ).length;
    second.events.emit("subagent:async-complete", terminalEvent);
    await Bun.sleep(0);
    expect(
      second.entries.filter(
        (entry) => entry.customType === "brainstorm-forcer-ledger",
      ),
    ).toHaveLength(terminalLedgerCount);
    } finally {
      await rm(fixture.scopeDir, { recursive: true, force: true });
    }
  });

  for (const scenario of [
    { name: "ping", pauseAt: "ping", reject: false },
    { name: "status", pauseAt: "status", reject: false },
    { name: "rejected ping", pauseAt: "ping", reject: true },
  ] as const) it(`abandons reconciliation when navigation changes ownership during ${scenario.name}`, async () => {
    const sessionManager = SessionManager.inMemory(process.cwd());
    const api = createMockAPI(sessionManager);
    const branchAContext = createSessionManagerContext(sessionManager);
    const branchBContext = createSessionManagerContext(sessionManager);
    const fixture = await createVerificationAsyncDirFixture(
      "ping-race-verification-run",
    );
    try {
      const bridge = installControllableVerificationRpcBridge(
        api.events,
        sessionManager.getSessionId(),
        "ping-race-verification-run",
        fixture.asyncDir,
      );
      brainstormForcer(api.pi, {
        preflight: async (_sessionId, _cwd, agents) =>
          agents.map((agent) => ({ agent, ok: true })),
      });
      await enterPendingLocalCodeVerification(api, branchAContext);
      const branchALeafId = sessionManager.getLeafId()!;
      const branchPointId = sessionManager
        .getBranch()
        .find(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "brainstorm-forcer-ledger" &&
            (entry.data as any).record?.id === "CL-001",
        )!.id;

      sessionManager.branch(branchPointId);
      const branchBLeafId = sessionManager.appendCustomEntry(
        "branch-marker",
        {},
      );
      sessionManager.branch(branchALeafId);
      bridge.defer(scenario.pauseAt);
      const reconciling = api.handlers.get("session_tree")!(
        {
          type: "session_tree",
          newLeafId: branchALeafId,
          oldLeafId: branchBLeafId,
        },
        branchAContext,
      );
      await Bun.sleep(0);

      sessionManager.branch(branchBLeafId);
      await api.handlers.get("session_tree")!(
        {
          type: "session_tree",
          newLeafId: branchBLeafId,
          oldLeafId: branchALeafId,
        },
        branchBContext,
      );
      if (scenario.reject) bridge.reject(scenario.pauseAt);
      else bridge.release(scenario.pauseAt);
      await reconciling;

      expect(
        bridge.requests.filter((request) => request.method === "status"),
      ).toHaveLength(scenario.pauseAt === "ping" ? 0 : 1);
      expect(
        sessionManager
          .getBranch()
          .some(
            (entry) =>
              entry.type === "custom" &&
              entry.customType === "brainstorm-forcer" &&
              (entry.data as any).pendingVerification?.runId ===
                "ping-race-verification-run",
          ),
      ).toBe(false);
      expect(
        api.entries.some(
          (entry) => (entry.data as any)?.record?.kind === "review",
        ),
      ).toBe(false);
    } finally {
      await rm(fixture.scopeDir, { recursive: true, force: true });
    }
  });

  it("quarantines branch-A pending CL-004/CL-005 when session_tree selects a sibling branch without those records", async () => {
    const sessionManager = SessionManager.inMemory(process.cwd());
    const api = createMockAPI(sessionManager);
    const ctx = createSessionManagerContext(sessionManager);
    const sessionFile = ctx.sessionManager.getSessionFile()!;
    const runId = "branch-a-verification-run";
    const fixture = await createVerificationAsyncDirFixture(runId);
    try {
      installVerificationRpcBridge(
        api.events,
        sessionManager.getSessionId(),
        runId,
        fixture.asyncDir,
      );
      brainstormForcer(api.pi, {
        preflight: async (_sessionId, _cwd, agents) =>
          agents.map((agent) => ({ agent, ok: true })),
        rpcTimeoutMs: 20,
      });
      await api.commands.get("brainstorm")!.handler("topic", ctx);
      await api.commands.get("brainstorm")!.handler("phase exploring", ctx);
      await api.handlers.get("tool_result")!(
        {
          type: "tool_result",
          toolCallId: "read-1",
          toolName: "read",
          input: { path: "index.ts" },
          content: [{ type: "text", text: "observable result" }],
          details: undefined,
          isError: false,
        },
        ctx,
      );
      for (let index = 1; index <= 5; index += 1) {
        await api.tools.get("brainstorm_record_claim")!.execute(
          `claim-${index}`,
          {
            assertion: `Branch claim ${index}.`,
            classification: "empirical",
            critical: true,
            verdict: "verified",
            evidenceIds: ["EV-001"],
            contradictoryEvidenceIds: [],
            impact: `Controls branch behavior ${index}.`,
            verificationDomain: "local-code",
            architectureImpact: false,
            mitigation: "Keep branch state isolated.",
          },
          undefined,
          undefined,
          ctx,
        );
        if (index === 3)
          expect(
            sessionManager.getBranch().at(-1),
          ).toMatchObject({ type: "custom", customType: "brainstorm-forcer-ledger" });
      }
      const branchPointId = sessionManager.getBranch().at(-3)!.id;
      expect(
        sessionManager
          .getBranch(branchPointId)
          .flatMap((entry) =>
            entry.type === "custom" &&
            entry.customType === "brainstorm-forcer-ledger"
              ? [(entry.data as any).record.id]
              : [],
          ),
      ).toEqual(["EV-001", "CL-001", "CL-002", "CL-003"]);

      await api.tools.get("brainstorm_run_verification")!.execute(
        "verification-1",
        { claimIds: ["CL-004", "CL-005"] },
        undefined,
        undefined,
        ctx,
      );
      const branchALeafId = sessionManager.getLeafId()!;
      const staleSnapshot = structuredClone(
        (
          sessionManager
            .getBranch()
            .findLast(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === "brainstorm-forcer",
            ) as any
        ).data,
      );

      sessionManager.branch(branchPointId);
      sessionManager.appendCustomEntry("brainstorm-forcer", staleSnapshot);
      const branchBLeafId = sessionManager.getLeafId()!;
      expect(
        sessionManager
          .getBranch()
          .some(
            (entry) =>
              entry.type === "custom" &&
              entry.customType === "brainstorm-forcer-ledger" &&
              ["CL-004", "CL-005"].includes((entry.data as any).record?.id),
          ),
      ).toBe(false);
      expect(
        sessionManager
          .getEntries()
          .some(
            (entry) =>
              entry.type === "custom" &&
              entry.customType === "brainstorm-forcer-ledger" &&
              ["CL-004", "CL-005"].includes((entry.data as any).record?.id),
          ),
      ).toBe(true);

      await expect(
        api.handlers.get("session_tree")!(
          {
            type: "session_tree",
            newLeafId: branchBLeafId,
            oldLeafId: branchALeafId,
          },
          ctx,
        ),
      ).resolves.toBeUndefined();

      const persisted = sessionManager.getBranch().at(-1);
      expect(persisted).toMatchObject({
        type: "custom",
        customType: "brainstorm-forcer",
        data: { pendingVerification: null },
      });
      expect(
        api.entries.some(
          (entry) => (entry.data as any)?.record?.kind === "review",
        ),
      ).toBe(false);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining(
          "CL-004, CL-005 are absent from the active branch",
        ),
        "warning",
      );
      const ledgerCountAfterQuarantine = api.entries.filter(
        (entry) => entry.customType === "brainstorm-forcer-ledger",
      ).length;
      api.events.emit("subagent:async-complete", {
        runId,
        sessionId: sessionFile,
        success: false,
        state: "failed",
        exitCode: 1,
        error: "Late completion from branch A.",
      });
      await Bun.sleep(0);
      expect(
        api.entries.filter(
          (entry) => entry.customType === "brainstorm-forcer-ledger",
        ),
      ).toHaveLength(ledgerCountAfterQuarantine);

      await api.tools.get("brainstorm_run_verification")!.execute(
        "verification-branch-b",
        { claimIds: ["CL-001"] },
        undefined,
        undefined,
        ctx,
      );
      const branchBPendingLeafId = sessionManager.getLeafId()!;
      const runningStatus = {
        lifecycleArtifactVersion: 3,
        runId,
        sessionId: sessionFile,
        mode: "chain",
        state: "running",
        startedAt: Date.now(),
        steps: [
          {
            agent: "scout",
            context: "fresh",
            outputName: "verify_local_code_supported",
            status: "running",
          },
        ],
      };
      await writeFile(
        join(fixture.asyncDir, "status.json"),
        JSON.stringify(runningStatus),
      );
      sessionManager.branch(branchALeafId);
      await api.handlers.get("session_tree")!(
        {
          type: "session_tree",
          newLeafId: branchALeafId,
          oldLeafId: branchBLeafId,
        },
        ctx,
      );
      expect(sessionManager.getBranch().at(-1)).toMatchObject({
        type: "custom",
        customType: "brainstorm-forcer",
        data: {
          pendingVerification: {
            runId,
            claimIds: ["CL-004", "CL-005"],
          },
        },
      });
      expect(
        (ctx.ui.notify as any).mock.calls.filter(
          ([message]: [string]) => message.includes("quarantined"),
        ),
      ).toHaveLength(1);

      (ctx.ui.notify as any).mockImplementation((message: string) => {
        if (message.includes(`Verification ${runId} completed and audited.`))
          throw new Error("notification renderer failed");
      });
      const structuredOutput = {
        outcome: "supported",
        claimIds: ["CL-004", "CL-005"],
        evidenceIds: ["EV-001"],
        summary: "Both branch-A claims remain supported.",
      };
      const outputs = {
        "verify_local_code_supported": {
          text: JSON.stringify(structuredOutput),
          structured: structuredOutput,
          agent: "scout",
          stepIndex: 0,
        },
      };
      await writeFile(
        join(fixture.asyncDir, "status.json"),
        JSON.stringify({
          ...runningStatus,
          state: "complete",
          steps: [
            {
              ...runningStatus.steps[0],
              status: "complete",
              exitCode: 0,
              structuredOutput,
            },
          ],
          outputs,
        }),
      );
      api.events.emit("subagent:async-complete", {
        runId,
        sessionId: sessionFile,
        success: true,
        state: "complete",
        exitCode: 0,
        results: [
          {
            agent: "scout",
            context: "fresh",
            status: "completed",
            success: true,
            structuredOutput,
          },
        ],
        outputs,
      });
      await writeFile(
        join(fixture.asyncDir, "status.json"),
        JSON.stringify(runningStatus),
      );
      sessionManager.branch(branchBPendingLeafId);
      await api.handlers.get("session_tree")!(
        {
          type: "session_tree",
          newLeafId: branchBPendingLeafId,
          oldLeafId: branchALeafId,
        },
        ctx,
      );
      await Bun.sleep(10);
      expect(sessionManager.getBranch().at(-1)).toMatchObject({
        type: "custom",
        customType: "brainstorm-forcer",
        data: {
          pendingVerification: {
            runId,
            claimIds: ["CL-001"],
          },
        },
      });
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Active pending preserved"),
        "warning",
      );
    } finally {
      await rm(fixture.scopeDir, { recursive: true, force: true });
    }
  });

  it("restarts a corrupted session by clearing a pending run whose evidence is absent", async () => {
    const sessionManager = SessionManager.inMemory(process.cwd());
    const fixture = await createVerificationAsyncDirFixture(
      "missing-evidence-run",
    );
    try {
      const first = createMockAPI(sessionManager);
      const firstContext = createSessionManagerContext(sessionManager);
      installVerificationRpcBridge(
        first.events,
        sessionManager.getSessionId(),
        "missing-evidence-run",
        fixture.asyncDir,
      );
      brainstormForcer(first.pi, {
        preflight: async (_sessionId, _cwd, agents) =>
          agents.map((agent) => ({ agent, ok: true })),
      });
      await enterPendingLocalCodeVerification(first, firstContext);
      const missingEvidenceId = `EV-${"9".repeat(1_200)}`;
      const pendingSnapshot = structuredClone(
        (
          sessionManager
            .getBranch()
            .findLast(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === "brainstorm-forcer",
            ) as any
        ).data,
      );
      pendingSnapshot.pendingVerification.expectedSteps[0].evidenceIds = [
        missingEvidenceId,
      ];
      sessionManager.appendCustomEntry("brainstorm-forcer", pendingSnapshot);

      const restored = createMockAPI(sessionManager);
      const restoredContext = createSessionManagerContext(sessionManager);
      brainstormForcer(restored.pi, { rpcTimeoutMs: 20 });
      await expect(
        restored.handlers.get("session_start")!(
          { type: "session_start" },
          restoredContext,
        ),
      ).resolves.toBeUndefined();

      expect(restored.entries.at(-1)).toMatchObject({
        customType: "brainstorm-forcer",
        data: { pendingVerification: null },
      });
      expect(
        restored.entries.some(
          (entry) => (entry.data as any)?.record?.kind === "review",
        ),
      ).toBe(false);
      const warning = (restoredContext.ui.notify as any).mock.calls.find(
        ([message]: [string]) => message.includes("quarantined"),
      );
      expect(warning?.[0]).toContain(
        "is absent from the active branch evidence history",
      );
      expect(warning?.[0].length).toBeLessThanOrEqual(700);
      expect(warning?.[1]).toBe("warning");
    } finally {
      await rm(fixture.scopeDir, { recursive: true, force: true });
    }
  });

  it("restores and audits a pending claim that remains in branch history after supersession", async () => {
    const sessionManager = SessionManager.inMemory(process.cwd());
    const fixture = await createVerificationAsyncDirFixture(
      "superseded-claim-run",
    );
    try {
      const first = createMockAPI(sessionManager);
      const firstContext = createSessionManagerContext(sessionManager);
      const sessionFile = firstContext.sessionManager.getSessionFile()!;
      installVerificationRpcBridge(
        first.events,
        sessionManager.getSessionId(),
        "superseded-claim-run",
        fixture.asyncDir,
      );
      brainstormForcer(first.pi, {
        preflight: async (_sessionId, _cwd, agents) =>
          agents.map((agent) => ({ agent, ok: true })),
      });
      await enterPendingLocalCodeVerification(first, firstContext);
      await first.tools.get("brainstorm_record_claim")!.execute(
        "claim-2",
        {
          assertion: "The superseding claim refines the original.",
          classification: "empirical",
          critical: true,
          verdict: "verified",
          evidenceIds: ["EV-001"],
          contradictoryEvidenceIds: [],
          impact: "The original remains immutable history.",
          verificationDomain: "local-code",
          architectureImpact: false,
          mitigation: "Audit the pending run against historical records.",
          supersedesClaimId: "CL-001",
        },
        undefined,
        undefined,
        firstContext,
      );
      await writeFile(
        join(fixture.asyncDir, "status.json"),
        JSON.stringify({
          lifecycleArtifactVersion: 3,
          runId: "superseded-claim-run",
          sessionId: sessionFile,
          mode: "chain",
          state: "running",
          startedAt: Date.now(),
          steps: [
            {
              agent: "scout",
              context: "fresh",
              outputName: "verify_local_code_supported",
              status: "running",
            },
          ],
        }),
      );

      const restored = createMockAPI(sessionManager);
      const restoredContext = createSessionManagerContext(sessionManager);
      installVerificationRpcBridge(
        restored.events,
        sessionManager.getSessionId(),
        "superseded-claim-run",
        fixture.asyncDir,
      );
      brainstormForcer(restored.pi);
      await restored.handlers.get("session_start")!(
        { type: "session_start" },
        restoredContext,
      );
      expect(
        (restoredContext.ui.notify as any).mock.calls.some(
          ([message]: [string]) => message.includes("quarantined"),
        ),
      ).toBe(false);

      await writeFile(
        join(fixture.asyncDir, "status.json"),
        JSON.stringify({
          lifecycleArtifactVersion: 3,
          runId: "superseded-claim-run",
          sessionId: sessionFile,
          mode: "chain",
          state: "failed",
          error: "Verifier process exited before producing output.",
          steps: [
            {
              agent: "scout",
              context: "fresh",
              outputName: "verify_local_code_supported",
              status: "failed",
              exitCode: 1,
            },
          ],
          outputs: {},
        }),
      );
      restored.events.emit("subagent:async-complete", {
        runId: "superseded-claim-run",
        sessionId: sessionFile,
        success: false,
        state: "failed",
        exitCode: 1,
        error: "Verifier process exited before producing output.",
      });
      await Bun.sleep(0);

      expect(
        restored.entries
          .filter(
            (entry) => entry.customType === "brainstorm-forcer-ledger",
          )
          .map((entry) => (entry.data as any).record),
      ).toContainEqual(
        expect.objectContaining({
          kind: "review",
          claimIds: ["CL-001"],
          audit: expect.objectContaining({
            status: "failed",
            verificationRunId: "superseded-claim-run",
          }),
        }),
      );
    } finally {
      await rm(fixture.scopeDir, { recursive: true, force: true });
    }
  });

  it("does not create a waiver when the user rejects its approval dialog", async () => {
    const { pi, handlers, commands, tools, entries } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    await commands.get("brainstorm")!.handler("topic", ctx);
    await commands.get("brainstorm")!.handler("phase exploring", ctx);
    await handlers.get("tool_result")!(
      {
        type: "tool_result",
        toolCallId: "read-1",
        toolName: "read",
        input: { path: "missing.ts" },
        content: [{ type: "text", text: "ENOENT" }],
        details: undefined,
        isError: true,
      },
      ctx,
    );
    await tools.get("brainstorm_record_claim")!.execute(
      "claim-1",
      {
        assertion: "The missing file changes runtime behavior.",
        classification: "empirical",
        critical: true,
        verdict: "unresolved",
        evidenceIds: ["EV-001"],
        contradictoryEvidenceIds: [],
        impact: "Could invalidate the recommendation.",
        verificationDomain: "local-code",
        architectureImpact: false,
        mitigation: "Re-evaluate when the source is available.",
      },
      undefined,
      undefined,
      ctx,
    );
    expect(
      (
        await tools
          .get("brainstorm_transition")!
          .execute("status", { action: "status" }, undefined, undefined, ctx)
      ).details.exploringStatus.nextAction,
    ).toBe("requestWaiver");
    (ctx.ui.select as any).mockResolvedValueOnce("Reject");

    const result = await tools.get("brainstorm_request_waiver")!.execute(
      "waiver-1",
      {
        claimId: "CL-001",
        reason: "Primary source is temporarily unavailable.",
        impact: "Recommendation retains uncertainty.",
        mitigation: "Do not treat the claim as verified.",
        reevaluateWhen: "The source becomes available.",
      },
      undefined,
      undefined,
      ctx,
    );

    expect(result.details).toEqual({ approved: false, claimId: "CL-001" });
    expect(entries.some((entry: any) => entry.data?.record?.kind === "waiver")).toBe(false);
  });

  it("persists a waiver only after explicit user approval", async () => {
    const { pi, handlers, commands, tools, entries } = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(pi);
    await commands.get("brainstorm")!.handler("topic", ctx);
    await commands.get("brainstorm")!.handler("phase exploring", ctx);
    await handlers.get("tool_result")!(
      {
        type: "tool_result",
        toolCallId: "read-1",
        toolName: "read",
        input: { path: "missing.ts" },
        content: [{ type: "text", text: "ENOENT" }],
        details: undefined,
        isError: true,
      },
      ctx,
    );
    await tools.get("brainstorm_record_claim")!.execute(
      "claim-1",
      {
        assertion: "The missing file changes runtime behavior.",
        classification: "empirical",
        critical: true,
        verdict: "unresolved",
        evidenceIds: ["EV-001"],
        contradictoryEvidenceIds: [],
        impact: "Could invalidate the recommendation.",
        verificationDomain: "local-code",
        architectureImpact: false,
        mitigation: "Re-evaluate when the source is available.",
      },
      undefined,
      undefined,
      ctx,
    );
    (ctx.ui.select as any).mockResolvedValueOnce("Approve waiver");

    const result = await tools.get("brainstorm_request_waiver")!.execute(
      "waiver-1",
      {
        claimId: "CL-001",
        reason: "Primary source is temporarily unavailable.",
        impact: "Recommendation retains uncertainty.",
        mitigation: "Do not treat the claim as verified.",
        reevaluateWhen: "The source becomes available.",
      },
      undefined,
      undefined,
      ctx,
    );

    expect(result.details).toMatchObject({
      approved: true,
      record: {
        id: "WV-001",
        claimId: "CL-001",
        reevaluateWhen: "The source becomes available.",
      },
    });
    expect(entries.at(-1)).toMatchObject({
      customType: "brainstorm-forcer-ledger",
      data: { record: { id: "WV-001", kind: "waiver" } },
    });
  });

  it("restores the current-run ledger and continues EV identifiers", async () => {
    const first = createMockAPI();
    const firstContext = createMockContext();
    brainstormForcer(first.pi);
    await first.commands.get("brainstorm")!.handler("topic", firstContext);
    await first.commands.get("brainstorm")!.handler("phase exploring", firstContext);
    await first.handlers.get("tool_result")!(
      {
        type: "tool_result",
        toolCallId: "read-1",
        toolName: "read",
        input: { path: "README.md" },
        content: [{ type: "text", text: "result" }],
        details: undefined,
        isError: false,
      },
      firstContext,
    );

    const restoredEntries = first.entries.map((entry) => ({ type: "custom", ...entry }));
    const second = createMockAPI();
    const secondContext = createMockContext(restoredEntries);
    brainstormForcer(second.pi);
    await second.handlers.get("session_start")!({}, secondContext);
    await second.handlers.get("tool_result")!(
      {
        type: "tool_result",
        toolCallId: "grep-1",
        toolName: "grep",
        input: { pattern: "appendEntry", path: "index.ts" },
        content: [{ type: "text", text: "match" }],
        details: undefined,
        isError: false,
      },
      secondContext,
    );

    const latestLedger = second.entries.find((entry) => entry.customType === "brainstorm-forcer-ledger");
    expect(latestLedger?.data).toMatchObject({ record: { id: "EV-002" } });
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

  it("registers verifier capability ceiling on brainstorm start and disposes on shutdown", async () => {
    const { pi, commands, handlers } = createMockAPI();
    const ctx = createMockContext(undefined, process.cwd(), "ceiling-lifecycle-session");
    brainstormForcer(pi);
    await commands.get("brainstorm")!.handler("topic", ctx);

    const ceiling = resolveSubagentCapabilityCeiling("ceiling-lifecycle-session");
    expect(ceiling).toBeDefined();
    expect(ceiling!.denyExtensions).toBe(false);
    expect(ceiling!.sources).toContain("brainstorm-forcer");

    await handlers.get("session_shutdown")!({}, ctx);
    expect(
      resolveSubagentCapabilityCeiling("ceiling-lifecycle-session"),
    ).toBeUndefined();
  });

  it("createCapabilityCeilingManager registers, updates, and disposes by session ID", () => {
    const manager = createCapabilityCeilingManager();
    manager.register("lifecycle-test-session");
    let ceiling = resolveSubagentCapabilityCeiling("lifecycle-test-session");
    expect(ceiling).toBeDefined();
    expect(ceiling!.denyExtensions).toBe(false);

    manager.dispose();
    expect(
      resolveSubagentCapabilityCeiling("lifecycle-test-session"),
    ).toBeUndefined();
  });
});
