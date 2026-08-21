/// <reference types="bun" />

import { beforeEach, afterEach, describe, expect, it, mock } from "bun:test";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { resolveSubagentCapabilityCeiling } from "pi-subagents/capability-ceiling";
import { snapshotExternalRuns } from "pi-subagents/external-runs";
import { getBrainstormAgentEntry } from "./brainstorm-agents";

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

function customRecordId(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = (data as { record?: unknown }).record;
  if (!record || typeof record !== "object" || Array.isArray(record))
    return undefined;
  return typeof (record as { id?: unknown }).id === "string"
    ? (record as { id: string }).id
    : undefined;
}

function clearsPendingVerification(data: unknown): boolean {
  return (
    !!data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    (data as { pendingVerification?: unknown }).pendingVerification === null
  );
}

function customRecordAuditStatus(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = (data as { record?: unknown }).record;
  if (!record || typeof record !== "object" || Array.isArray(record))
    return undefined;
  const audit = (record as { audit?: unknown }).audit;
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) return undefined;
  return typeof (audit as { status?: unknown }).status === "string"
    ? (audit as { status: string }).status
    : undefined;
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
  let isolatedAgentDir: string | undefined;
  let previousAgentDirEnv: string | undefined;

  beforeEach(async () => {
    isolatedAgentDir = await mkdtemp(join(tmpdir(), "brainstorm-agents-iso-"));
    await mkdir(join(isolatedAgentDir, "agents"), { recursive: true });
    previousAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
  });

  afterEach(async () => {
    if (previousAgentDirEnv === undefined)
      delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDirEnv;
    if (isolatedAgentDir) {
      await rm(isolatedAgentDir, { recursive: true, force: true });
    }
    isolatedAgentDir = undefined;
  });

  it("rejects preflight agent names outside the verifier allowlist", async () => {
    await expect(
      preflightVerifierAgents("test-session", process.cwd(), ["worker"]),
    ).rejects.toThrow(/not allowed/i);
  });

  it("uses the dedicated local-code verifier when another discovered agent shares scout's local name", async () => {
    const sessionId = "brainstorm-code-scout-preflight";
    const root = await mkdtemp(join(tmpdir(), "brainstorm-agent-collision-"));
    const agentsDir = join(root, ".pi", "agents");
    const manager = createCapabilityCeilingManager();
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, "code-analysis.scout.md"),
      "---\nname: scout\npackage: code-analysis\ndescription: Colliding project scout\ntools: '@inspect'\n---\n",
    );
    await writeFile(
      join(agentsDir, "brainstorm-code-scout.md"),
      getBrainstormAgentEntry("brainstorm-code-scout")!.markdown,
    );
    manager.register(sessionId);
    try {
      const { resolveSubagentLaunchContract } = await import("pi-subagents/preflight");
      await expect(
        resolveSubagentLaunchContract({
          agent: "scout",
          cwd: root,
          context: "fresh",
        }),
      ).resolves.toMatchObject({
        ok: false,
        code: "ambiguous_agent",
        message: expect.stringContaining("Ambiguous agent name 'scout'"),
      });
      await expect(
        preflightVerifierAgents(sessionId, root, ["brainstorm-code-scout"]),
      ).resolves.toEqual([
        expect.objectContaining({ agent: "brainstorm-code-scout", ok: true }),
      ]);
    } finally {
      manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

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
    const api = createMockAPI();
    const ctx = createMockContext();
    const requests: Array<Record<string, unknown>> = [];
    let leafId = "branch-a";
    (ctx.sessionManager as any).getLeafId = () => leafId;
    api.events.on("prompt-template:subagent:request", (raw) => {
      requests.push(raw as Record<string, unknown>);
    });
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
    expect(requests).toEqual([]);
    expect(
      (
        api.entries
          .filter((entry) => entry.customType === "brainstorm-forcer")
          .at(-1)?.data as any
      )?.pendingVerification,
    ).toBeNull();
  });

  it("rolls back a started verification when persisting pending state fails", async () => {
    const api = createMockAPI();
    const ctx = createMockContext();
    const requests: Array<Record<string, unknown>> = [];
    const cancellations: Array<Record<string, unknown>> = [];
    api.events.on("prompt-template:subagent:request", (raw) => {
      requests.push(raw as Record<string, unknown>);
    });
    api.events.on("prompt-template:subagent:cancel", (raw) => {
      cancellations.push(raw as Record<string, unknown>);
    });
    brainstormForcer(api.pi, {
      preflight: async (_sessionId, _cwd, agents) =>
        agents.map((agent) => ({ agent, ok: true })),
    });
    await enterLocalCodeClaim(api, ctx);
    const appendEntry = (api.pi as any).appendEntry;
    (api.pi as any).appendEntry = (customType: string, data?: unknown) => {
      if (customType === "brainstorm-forcer")
        throw new Error("Injected pending-state persistence failure.");
      appendEntry(customType, data);
    };

    await expect(
      api.tools.get("brainstorm_run_verification")!.execute(
        "verification-save-failure",
        { claimIds: ["CL-001"] },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("Injected pending-state persistence failure.");
    const request = requests[0]!;
    expect(cancellations).toEqual([
      {
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
      },
    ]);
    expect(snapshotExternalRuns(ctx.sessionManager.getSessionFile()!)).toEqual([]);

    const entriesAfterFailure = api.entries.length;
    api.events.emit("prompt-template:subagent:response", {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      status: "completed",
      result: { kind: "structured", value: {} },
    });
    await Bun.sleep(0);
    expect(api.entries).toHaveLength(entriesAfterFailure);
    (api.pi as any).appendEntry = appendEntry;
    await expect(
      api.tools.get("brainstorm_run_verification")!.execute(
        "verification-after-rollback",
        { claimIds: ["CL-001"] },
        undefined,
        undefined,
        ctx,
      ),
    ).resolves.toMatchObject({ details: { status: "pending" } });
    await api.commands.get("brainstorm")!.handler("stop", ctx);
  });

  it("stops the old structured run before session_tree restores branch state", async () => {
    const api = createMockAPI();
    const ctx = createMockContext();
    let leafId = "branch-a";
    (ctx.sessionManager as any).getLeafId = () => leafId;
    const requests: Array<Record<string, unknown>> = [];
    const cancellations: Array<Record<string, unknown>> = [];
    api.events.on("prompt-template:subagent:request", (raw) => {
      requests.push(raw as Record<string, unknown>);
    });
    api.events.on("prompt-template:subagent:cancel", (raw) => {
      cancellations.push(raw as Record<string, unknown>);
    });
    brainstormForcer(api.pi, {
      preflight: async (_sessionId, _cwd, agents) =>
        agents.map((agent) => ({ agent, ok: true })),
    });
    await enterPendingLocalCodeVerification(api, ctx);
    const request = requests[0]!;
    const entriesBeforeTree = api.entries.length;
    leafId = "branch-b";

    await api.handlers.get("session_tree")!(
      { type: "session_tree", oldLeafId: "branch-a", newLeafId: "branch-b" },
      ctx,
    );

    expect(cancellations).toEqual([
      {
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
      },
    ]);
    expect(snapshotExternalRuns(ctx.sessionManager.getSessionFile()!)).toEqual([]);
    api.events.emit("prompt-template:subagent:response", {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      status: "completed",
      result: { kind: "structured", value: {} },
    });
    await Bun.sleep(0);
    expect(api.entries).toHaveLength(entriesBeforeTree);
  });

  it("stops a structured verifier when branch ownership changes after launch", async () => {
    const api = createMockAPI();
    const ctx = createMockContext();
    let leafId = "branch-a";
    (ctx.sessionManager as any).getLeafId = () => leafId;
    const requests: Array<Record<string, unknown>> = [];
    const cancellations: Array<Record<string, unknown>> = [];
    api.events.on("prompt-template:subagent:request", (raw) => {
      requests.push(raw as Record<string, unknown>);
      leafId = "branch-b";
    });
    api.events.on("prompt-template:subagent:cancel", (raw) => {
      cancellations.push(raw as Record<string, unknown>);
    });
    brainstormForcer(api.pi, {
      preflight: async (_sessionId, _cwd, agents) =>
        agents.map((agent) => ({ agent, ok: true })),
    });
    await enterLocalCodeClaim(api, ctx);

    await expect(
      api.tools.get("brainstorm_run_verification")!.execute(
        "verification-branch-race",
        { claimIds: ["CL-001"] },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("launch ownership changed");
    const request = requests[0]!;
    expect(cancellations).toEqual([
      {
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
      },
    ]);
    expect(snapshotExternalRuns(ctx.sessionManager.getSessionFile()!)).toEqual([]);
    expect(
      api.entries
        .filter((entry) => entry.customType === "brainstorm-forcer")
        .at(-1)?.data,
    ).not.toMatchObject({ pendingVerification: expect.anything() });
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

  it("requires legacy claims to be superseded before verification after branch restore", async () => {
    const runId = "brainstorm-legacy-branch";
    const entries = [
      {
        type: "custom",
        customType: "brainstorm-forcer-ledger",
        data: {
          runId,
          record: {
            id: "EV-001",
            kind: "evidence",
            runId,
            phase: "exploring",
            sequence: 1,
            timestamp: "2026-01-01T00:00:00.000Z",
            toolCallId: "read-legacy",
            toolName: "read",
            status: "success",
            inputHash: "a".repeat(64),
            responseHash: "b".repeat(64),
            sourceKind: "direct",
            staleness: "fresh",
          },
        },
      },
      {
        type: "custom",
        customType: "brainstorm-forcer-ledger",
        data: {
          runId,
          record: {
            id: "CL-001",
            kind: "claim",
            runId,
            phase: "exploring",
            sequence: 2,
            timestamp: "2026-01-01T00:00:01.000Z",
            assertion: "Runtime source exists.",
            classification: "empirical",
            critical: true,
            verdict: "verified",
            evidenceIds: ["EV-001"],
            contradictoryEvidenceIds: [],
            impact: "Determines recommendation.",
            mitigation: "Keep source evidence.",
          },
        },
      },
      {
        type: "custom",
        customType: "brainstorm-forcer",
        data: {
          active: true,
          phase: "exploring",
          topic: { raw: "Legacy branch", display: "Legacy branch" },
          runId,
          startedAt: "2026-01-01T00:00:00.000Z",
          artifacts: {},
        },
      },
    ];
    const { pi, tools, handlers } = createMockAPI();
    const ctx = createMockContext(entries);
    brainstormForcer(pi);
    await handlers.get("session_start")!({ type: "session_start" }, ctx);

    const result = await tools
      .get("brainstorm_transition")!
      .execute("status", { action: "status" }, undefined, undefined, ctx);

    expect(result.details.exploringStatus).toMatchObject({
      routingMetadataRequiredClaimIds: ["CL-001"],
      missingSuccessfulReviewClaimIds: ["CL-001"],
      nextAction: "supersedeClaims",
    });
    expect(result.content[0].text).toContain(
      "Routing metadata supersession required: CL-001",
    );
    expect(result.content[0].text).toContain(
      "brainstorm_record_claim with supersedesClaimId",
    );
    await expectRejection(
      Promise.resolve(
        tools
          .get("brainstorm_run_verification")!
          .execute(
            "verify-legacy",
            { claimIds: ["CL-001"] },
            undefined,
            undefined,
            ctx,
          ),
      ),
      "Use brainstorm_record_claim with supersedesClaimId",
    );
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

  it("blocks direct legacy controls and leaves the pending snapshot unchanged", async () => {
    const api = createMockAPI();
    const ctx = createMockContext();
    brainstormForcer(api.pi, {
      preflight: async (_sessionId, _cwd, agents) =>
        agents.map((agent) => ({ agent, ok: true })),
    });
    await enterPendingLocalCodeVerification(api, ctx);
    const ledgerEntriesBefore = api.entries.filter(
      (entry) => entry.customType === "brainstorm-forcer-ledger",
    );
    const stateEntriesBefore = api.entries.filter(
      (entry) => entry.customType === "brainstorm-forcer",
    );
    const pendingRunId = (stateEntriesBefore.at(-1)?.data as any)
      .pendingVerification.runId;
    const toolCall = api.handlers.get("tool_call")!;

      expect(
        await toolCall(
          { toolName: "subagent_wait", input: { id: pendingRunId } },
          ctx,
        ),
      ).toMatchObject({ block: true });
      expect(
        await toolCall(
          {
            toolName: "subagent",
            input: { action: "steer", id: pendingRunId, message: "Continue." },
          },
          ctx,
        ),
      ).toMatchObject({ block: true });

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
          input: { id: pendingRunId },
          content: [{ type: "text", text: "still running" }],
          details: { completed: [], active: ["owned-verification-run"] },
          isError: false,
        },
        ctx,
      );
      const steerResult = await api.handlers.get("tool_result")!(
        {
          type: "tool_result",
          toolCallId: "steer-owned",
          toolName: "subagent",
          input: { action: "steer", id: pendingRunId, message: "Continue." },
          content: [{ type: "text", text: "steering queued" }],
          details: {
            mode: "management",
            steering: {
              requestId: "steer-1",
              sourceRunId: pendingRunId,
              state: "pending",
              targets: [{ index: 0, state: "routed" }],
            },
          },
          isError: false,
        },
        ctx,
      );

      expect(controlResult).toBeUndefined();
      expect(waitResult).toBeUndefined();
      expect(steerResult).toBeUndefined();
      expect(
        api.entries.filter(
          (entry) => entry.customType === "brainstorm-forcer-ledger",
        ),
      ).toEqual(ledgerEntriesBefore);
      expect(
        api.entries.filter((entry) => entry.customType === "brainstorm-forcer"),
      ).toEqual(stateEntriesBefore);
      await api.commands.get("brainstorm")!.handler("status", ctx);
      expect(ctx.ui.notify).toHaveBeenLastCalledWith(
        expect.stringContaining(
          "Exploring ledger: EV=1 | claims=1 active/1 historical | reviews=0 successful/0 total",
        ),
        "warning",
      );
      await api.commands.get("brainstorm")!.handler("stop", ctx);
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
      "dedicated foreground leaves",
      "structured delegation",
      "userChoiceEvidenceId",
      "dedicated single-question",
      "direct corroboration",
      "Do not call `subagent` or `subagent_wait` directly",
      "/brainstorm stop",
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

  it("runs one owned structured verification and appends EV/RV only from its exact completion", async () => {
    const { pi, handlers, commands, tools, entries, events } = createMockAPI();
    const ctx = createMockContext();
    const delegationRequests: Array<Record<string, unknown>> = [];
    const delegationCancellations: Array<Record<string, unknown>> = [];
    events.on("prompt-template:subagent:request", (raw) => {
      delegationRequests.push(raw as Record<string, unknown>);
    });
    events.on("prompt-template:subagent:cancel", (raw) => {
      delegationCancellations.push(raw as Record<string, unknown>);
    });
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
      status: "pending",
      claimIds: ["CL-001"],
    });
    const runId = launch.details.runId as string;
    const request = delegationRequests[0];
    expect(request).toMatchObject({
      ownerRunId: runId,
      nodeId: "verify_local_code_supported",
      agent: "brainstorm-code-scout",
      context: "fresh",
      result: { kind: "structured" },
    });
    expect(request).not.toHaveProperty("chain");
    expect(request).not.toHaveProperty("tasks");
    expect(request).not.toHaveProperty("parallel");
    expect(selectedPreflightAgents).toEqual(["brainstorm-code-scout"]);
    expect(entries.at(-1)).toMatchObject({
      customType: "brainstorm-forcer",
      data: {
        pendingVerification: {
          ownerSessionId: "test-session-id",
          ownerSessionFile: join(tmpdir(), "test-session-id.jsonl"),
        },
      },
    });

    events.emit("prompt-template:subagent:response", {
      requestId: request.requestId,
      ownerRunId: runId,
      nodeId: request.nodeId,
      status: "completed",
      result: {
        kind: "structured",
        value: {
          outcome: "supported",
          claimIds: ["CL-001"],
          evidenceIds: ["EV-001"],
          summary: "The transition gate is centralized.",
        },
      },
    });
    await Bun.sleep(0);

    const verificationRecords = entries
      .filter((entry) => entry.customType === "brainstorm-forcer-ledger")
      .map((entry) => (entry.data as any).record)
      .filter((record) => record.id === "EV-002" || record.id === "RV-001");
    expect(verificationRecords).toMatchObject([
      {
        id: "EV-002",
        sourceKind: "secondary",
        verifier: { agent: "brainstorm-code-scout", role: "verifier" },
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
    expect(selectedPreflightAgents).toEqual(["brainstorm-code-scout", "architect"]);
    const activeRequest = delegationRequests.at(-1)!;
    await commands.get("brainstorm")!.handler("stop", ctx);
    expect(delegationCancellations.at(-1)).toEqual({
      requestId: activeRequest.requestId,
      ownerRunId: activeRequest.ownerRunId,
      nodeId: activeRequest.nodeId,
    });
  });

  it("recovers a verifier completion atomically across terminal journal, EV, RV, and snapshot failures", async () => {
    for (const boundary of ["commit", "ev", "rv", "snapshot"] as const) {
      const sessionManager = SessionManager.inMemory(process.cwd());
      const first = createMockAPI(sessionManager);
      const firstContext = createSessionManagerContext(sessionManager);
      const requests: Array<Record<string, unknown>> = [];
      first.events.on("prompt-template:subagent:request", (raw) => {
        requests.push(raw as Record<string, unknown>);
      });
      brainstormForcer(first.pi, {
        preflight: async (_sessionId, _cwd, agents) =>
          agents.map((agent) => ({ agent, ok: true })),
      });
      await enterPendingLocalCodeVerification(first, firstContext);

      const appendEntry = (first.pi as any).appendEntry;
      let injected = false;
      (first.pi as any).appendEntry = (customType: string, data?: unknown) => {
        const shouldFail =
          (boundary === "commit" && customType === "brainstorm-forcer-terminal-commit") ||
          (boundary === "ev" &&
            customType === "brainstorm-forcer-ledger" &&
            customRecordId(data) === "EV-002") ||
          (boundary === "rv" &&
            customType === "brainstorm-forcer-ledger" &&
            customRecordId(data) === "RV-001") ||
          (boundary === "snapshot" &&
            customType === "brainstorm-forcer" &&
            clearsPendingVerification(data));
        if (!injected && shouldFail) {
          injected = true;
          throw new Error(`Injected ${boundary} boundary failure.`);
        }
        appendEntry(customType, data);
      };

      const request = requests[0]!;
      first.events.emit("prompt-template:subagent:response", {
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        status: "completed",
        result: {
          kind: "structured",
          value: {
            outcome: "supported",
            claimIds: ["CL-001"],
            evidenceIds: ["EV-001"],
            summary: "The transition gate is centralized.",
          },
        },
      });
      await Bun.sleep(0);
      expect(injected, boundary).toBe(true);

      const restored = createMockAPI(sessionManager);
      const restoredContext = createSessionManagerContext(sessionManager);
      brainstormForcer(restored.pi);
      await restored.handlers.get("session_start")!(
        { type: "session_start" },
        restoredContext,
      );

      const terminalRecords = sessionManager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "brainstorm-forcer-ledger",
        )
        .map((entry) => (entry as any).data.record)
        .filter(
          (record) =>
            record?.verifier?.verificationRunId === request.ownerRunId ||
            record?.audit?.verificationRunId === request.ownerRunId,
        );
      const verifierEvidence = terminalRecords.filter(
        (record) => record?.kind === "evidence",
      );
      const reviews = terminalRecords.filter(
        (record) => record?.kind === "review",
      );
      const completeSuccess =
        verifierEvidence.length === 1 &&
        reviews.length === 1 &&
        reviews[0]?.audit?.status === "success" &&
        reviews[0]?.verifierEvidenceId === verifierEvidence[0]?.id;
      const completeFailure =
        verifierEvidence.length === 0 &&
        reviews.length === 1 &&
        reviews[0]?.audit?.status === "failed";
      expect(completeSuccess || completeFailure, boundary).toBe(true);
      expect(
        (
          sessionManager
            .getBranch()
            .findLast(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === "brainstorm-forcer",
            ) as any
        ).data.pendingVerification,
        boundary,
      ).toBeNull();
    }
  });

  it("recovers multi-group terminal failure audits atomically across persistence and reload failures", async () => {
    for (const boundary of ["commit", "rv1", "rv2", "snapshot", "reload-rv2"] as const) {
      const sessionManager = SessionManager.inMemory(process.cwd());
      const first = createMockAPI(sessionManager);
      const firstContext = createSessionManagerContext(sessionManager);
      const requests: Array<Record<string, unknown>> = [];
      first.events.on("prompt-template:subagent:request", (raw) => {
        requests.push(raw as Record<string, unknown>);
      });
      brainstormForcer(first.pi, {
        preflight: async (_sessionId, _cwd, agents) =>
          agents.map((agent) => ({ agent, ok: true })),
      });
      await enterLocalCodeClaim(first, firstContext);
      await first.tools.get("brainstorm_record_claim")!.execute(
        "external-claim",
        {
          assertion: "The external route is deterministic.",
          classification: "empirical",
          critical: true,
          verdict: "verified",
          evidenceIds: ["EV-001"],
          contradictoryEvidenceIds: [],
          impact: "Controls the external verifier.",
          verificationDomain: "external",
          architectureImpact: false,
          mitigation: "Keep the route closed.",
        },
        undefined,
        undefined,
        firstContext,
      );
      await first.tools.get("brainstorm_run_verification")!.execute(
        "multi-failure",
        { claimIds: ["CL-001", "CL-002"] },
        undefined,
        undefined,
        firstContext,
      );
      expect(requests).toHaveLength(2);

      const initialAppend = (first.pi as any).appendEntry;
      let initialInjected = false;
      (first.pi as any).appendEntry = (customType: string, data?: unknown) => {
        const recordId = customRecordId(data);
        const shouldFail =
          (boundary === "commit" && customType === "brainstorm-forcer-terminal-commit") ||
          ((boundary === "rv1" || boundary === "rv2" || boundary === "reload-rv2") &&
            customType === "brainstorm-forcer-ledger" &&
            recordId === (boundary === "rv1" ? "RV-001" : "RV-002")) ||
          (boundary === "snapshot" &&
            customType === "brainstorm-forcer" &&
            clearsPendingVerification(data));
        if (!initialInjected && shouldFail) {
          initialInjected = true;
          throw new Error(`Injected ${boundary} initial failure.`);
        }
        initialAppend(customType, data);
      };

      for (const request of requests) {
        first.events.emit("prompt-template:subagent:response", {
          requestId: request.requestId,
          ownerRunId: request.ownerRunId,
          nodeId: request.nodeId,
          status: "timed_out",
          error: "deadline exceeded",
          result: { kind: "text", text: "" },
        });
      }
      await Bun.sleep(0);
      expect(initialInjected, boundary).toBe(true);

      const firstReload = createMockAPI(sessionManager);
      const firstReloadContext = createSessionManagerContext(sessionManager);
      let reloadInjected = false;
      if (boundary === "reload-rv2") {
        const reloadAppend = (firstReload.pi as any).appendEntry;
        (firstReload.pi as any).appendEntry = (customType: string, data?: unknown) => {
          if (
            !reloadInjected &&
            customType === "brainstorm-forcer-ledger" &&
            customRecordId(data) === "RV-002"
          ) {
            reloadInjected = true;
            throw new Error("Injected first reload RV-002 failure.");
          }
          reloadAppend(customType, data);
        };
      }
      brainstormForcer(firstReload.pi);
      await firstReload.handlers.get("session_start")!(
        { type: "session_start" },
        firstReloadContext,
      );

      if (boundary === "reload-rv2") {
        expect(reloadInjected).toBe(true);
        const pendingAfterFailedRecovery = (
          sessionManager
            .getBranch()
            .findLast(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === "brainstorm-forcer",
            ) as { data: { pendingVerification: unknown } }
        ).data.pendingVerification;
        expect(pendingAfterFailedRecovery).not.toBeNull();
      }

      const secondReload = createMockAPI(sessionManager);
      const secondReloadContext = createSessionManagerContext(sessionManager);
      brainstormForcer(secondReload.pi);
      await secondReload.handlers.get("session_start")!(
        { type: "session_start" },
        secondReloadContext,
      );

      const failureReviews = sessionManager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "brainstorm-forcer-ledger",
        )
        .map((entry) => (entry as { data: unknown }).data)
        .filter((data) => ["RV-001", "RV-002"].includes(customRecordId(data) ?? ""));
      expect(failureReviews).toHaveLength(2);
      expect(
        failureReviews.map((data) => customRecordId(data)).sort(),
      ).toEqual(["RV-001", "RV-002"]);
      expect(
        failureReviews.map(customRecordAuditStatus),
      ).toEqual([
        boundary === "commit" ? "failed" : "timeout",
        boundary === "commit" ? "failed" : "timeout",
      ]);
      expect(
        (
          sessionManager
            .getBranch()
            .findLast(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === "brainstorm-forcer",
            ) as { data: { pendingVerification: unknown } }
        ).data.pendingVerification,
      ).toBeNull();
    }
  });

  it("commits every multi-group failed, malformed, and timeout audit as one terminal outcome", async () => {
    for (const scenario of [
      { status: "timed_out", auditStatus: "timeout", error: "deadline exceeded" },
      { status: "failed", auditStatus: "failed", error: "verifier crashed" },
      {
        status: "completed",
        auditStatus: "malformed",
        result: {
          kind: "structured",
          value: {
            outcome: "supported",
            claimIds: ["CL-999"],
            evidenceIds: ["EV-001"],
            summary: "Wrong owned claim.",
          },
        },
      },
    ] as const) {
      const api = createMockAPI();
      const ctx = createMockContext();
      const requests: Array<Record<string, unknown>> = [];
      api.events.on("prompt-template:subagent:request", (raw) => {
        requests.push(raw as Record<string, unknown>);
      });
      brainstormForcer(api.pi, {
        preflight: async (_sessionId, _cwd, agents) =>
          agents.map((agent) => ({ agent, ok: true })),
      });
      await enterLocalCodeClaim(api, ctx);
      await api.tools.get("brainstorm_record_claim")!.execute(
        "external-claim",
        {
          assertion: "The external route is deterministic.",
          classification: "empirical",
          critical: true,
          verdict: "verified",
          evidenceIds: ["EV-001"],
          contradictoryEvidenceIds: [],
          impact: "Controls the external verifier.",
          verificationDomain: "external",
          architectureImpact: false,
          mitigation: "Keep the route closed.",
        },
        undefined,
        undefined,
        ctx,
      );
      await api.tools.get("brainstorm_run_verification")!.execute(
        `multi-${scenario.auditStatus}`,
        { claimIds: ["CL-001", "CL-002"] },
        undefined,
        undefined,
        ctx,
      );

      for (const request of requests) {
        api.events.emit("prompt-template:subagent:response", {
          requestId: request.requestId,
          ownerRunId: request.ownerRunId,
          nodeId: request.nodeId,
          status: scenario.status,
          ...(scenario.error ? { error: scenario.error } : {}),
          result: scenario.result ?? { kind: "text", text: "" },
        });
      }
      await Bun.sleep(0);

      const failureReviews = api.entries
        .filter((entry) => entry.customType === "brainstorm-forcer-ledger")
        .map((entry) => entry.data)
        .filter((data) => ["RV-001", "RV-002"].includes(customRecordId(data) ?? ""));
      expect(failureReviews).toHaveLength(2);
      expect(failureReviews.map(customRecordAuditStatus)).toEqual([
        scenario.auditStatus,
        scenario.auditStatus,
      ]);
      expect(api.entries.at(-1)).toMatchObject({
        customType: "brainstorm-forcer",
        data: { pendingVerification: null },
      });
    }
  });

  it("audits timeout, failure, and malformed terminal structured delegation outcomes", async () => {
    for (const scenario of [
      { name: "timeout", status: "timed_out", auditStatus: "timeout", error: "deadline exceeded" },
      { name: "failure", status: "failed", auditStatus: "failed", error: "verifier crashed" },
      {
        name: "malformed",
        status: "completed",
        auditStatus: "malformed",
        result: {
          kind: "structured",
          value: {
            outcome: "supported",
            claimIds: ["CL-999"],
            evidenceIds: ["EV-001"],
            summary: "Wrong owned claim.",
          },
        },
      },
    ] as const) {
      const api = createMockAPI();
      const ctx = createMockContext();
      const delegationRequests: Array<Record<string, unknown>> = [];
      const delegationCancellations: Array<Record<string, unknown>> = [];
      api.events.on("prompt-template:subagent:request", (raw) => {
        delegationRequests.push(raw as Record<string, unknown>);
      });
      api.events.on("prompt-template:subagent:cancel", (raw) => {
        delegationCancellations.push(raw as Record<string, unknown>);
      });
      brainstormForcer(api.pi, {
        preflight: async (_sessionId, _cwd, agents) =>
          agents.map((agent) => ({ agent, ok: true })),
      });
      await enterPendingLocalCodeVerification(api, ctx);
      const request = delegationRequests[0]!;
      api.events.emit("prompt-template:subagent:response", {
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        status: scenario.status,
        ...(scenario.error ? { error: scenario.error } : {}),
        result: scenario.result ?? { kind: "text", text: "" },
      });
      await Bun.sleep(0);

      const review = api.entries
        .filter((entry) => entry.customType === "brainstorm-forcer-ledger")
        .map((entry) => (entry.data as any).record)
        .find((record) => record?.id === "RV-001");
      expect(review).toMatchObject({
        id: "RV-001",
        audit: { status: scenario.auditStatus },
      });
      expect(api.entries.at(-1)).toMatchObject({
        customType: "brainstorm-forcer",
        data: { pendingVerification: null },
      });
      expect(snapshotExternalRuns(ctx.sessionManager.getSessionFile()!)).toEqual([]);
      expect(delegationCancellations, scenario.name).toEqual([]);
    }
  });

  it("keeps successful structured verifier RV audits when the architect advisory fails", async () => {
    const api = createMockAPI();
    const ctx = createMockContext();
    const delegationRequests: Array<Record<string, unknown>> = [];
    const delegationCancellations: Array<Record<string, unknown>> = [];
    api.events.on("prompt-template:subagent:request", (raw) => {
      delegationRequests.push(raw as Record<string, unknown>);
    });
    api.events.on("prompt-template:subagent:cancel", (raw) => {
      delegationCancellations.push(raw as Record<string, unknown>);
    });
    brainstormForcer(api.pi, {
      preflight: async (_sessionId, _cwd, agents) =>
        agents.map((agent) => ({ agent, ok: true })),
    });
    await enterLocalCodeClaim(api, ctx);
    await api.tools.get("brainstorm_record_claim")!.execute(
      "architecture-claim",
      {
        assertion: "The Pi lifecycle boundary is safe.",
        classification: "empirical",
        critical: true,
        verdict: "verified",
        evidenceIds: ["EV-001"],
        contradictoryEvidenceIds: [],
        impact: "Controls the architecture advisory.",
        verificationDomain: "pi",
        architectureImpact: true,
        mitigation: "Keep lifecycle ownership explicit.",
      },
      undefined,
      undefined,
      ctx,
    );
    await api.tools.get("brainstorm_run_verification")!.execute(
      "architecture-verification",
      { claimIds: ["CL-001", "CL-002"] },
      undefined,
      undefined,
      ctx,
    );
    expect(delegationRequests).toHaveLength(2);
    for (const request of delegationRequests) {
      const claimId = request.nodeId === "verify_pi_supported" ? "CL-002" : "CL-001";
      api.events.emit("prompt-template:subagent:response", {
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        status: "completed",
        result: {
          kind: "structured",
          value: {
            outcome: "supported",
            claimIds: [claimId],
            evidenceIds: ["EV-001"],
            summary: `${claimId} is supported.`,
          },
        },
      });
    }
    await Bun.sleep(0);
    await Bun.sleep(0);
    const architectRequest = delegationRequests[2]!;
    expect(architectRequest).toMatchObject({
      nodeId: "architect_advisory",
      agent: "architect",
    });
    api.events.emit("prompt-template:subagent:response", {
      requestId: architectRequest.requestId,
      ownerRunId: architectRequest.ownerRunId,
      nodeId: architectRequest.nodeId,
      status: "failed",
      error: "architect unavailable",
      result: { kind: "text", text: "" },
    });
    await Bun.sleep(0);

    const reviews = api.entries
      .filter((entry) => entry.customType === "brainstorm-forcer-ledger")
      .map((entry) => (entry.data as any).record)
      .filter((record) => record?.kind === "review");
    expect(reviews).toMatchObject([
      {
        id: "RV-001",
        audit: {
          status: "success",
          advisoryFailure: {
            claimIds: ["CL-002"],
            evidenceIds: ["EV-001"],
            reason: "architect unavailable",
          },
        },
      },
      { id: "RV-002", audit: { status: "success" } },
    ]);
    expect(api.entries.at(-1)).toMatchObject({
      customType: "brainstorm-forcer",
      data: { pendingVerification: null },
    });
    expect(snapshotExternalRuns(ctx.sessionManager.getSessionFile()!)).toEqual([]);
    expect(delegationCancellations).toEqual([]);
  });

  it("cancels every owned child and removes the Fleet projection on session shutdown", async () => {
    const api = createMockAPI();
    const { pi, handlers, tools, events, entries } = api;
    const sessionId = "brainstorm-owner-uuid";
    const sessionFile = join(tmpdir(), "brainstorm-owner-session.jsonl");
    const ctx = createMockContext(undefined, process.cwd(), sessionId, sessionFile);
    const delegationRequests: Array<Record<string, unknown>> = [];
    const delegationCancellations: Array<Record<string, unknown>> = [];
    events.on("prompt-template:subagent:request", (raw) => {
      delegationRequests.push(raw as Record<string, unknown>);
    });
    events.on("prompt-template:subagent:cancel", (raw) => {
      delegationCancellations.push(raw as Record<string, unknown>);
    });
    brainstormForcer(pi, {
      preflight: async (_sessionId, _cwd, agents) =>
        agents.map((agent) => ({ agent, ok: true })),
    });
    await handlers.get("session_start")!({ type: "session_start" }, ctx);
    await enterLocalCodeClaim(api, ctx);
    await tools.get("brainstorm_record_claim")!.execute(
      "claim-pi",
      {
        assertion: "The harness exposes session lifecycle events.",
        classification: "empirical",
        critical: true,
        verdict: "verified",
        evidenceIds: ["EV-001"],
        contradictoryEvidenceIds: [],
        impact: "Controls shutdown cleanup.",
        verificationDomain: "pi",
        architectureImpact: true,
        mitigation: "Use the public lifecycle hook.",
      },
      undefined,
      undefined,
      ctx,
    );

    const launch = await tools.get("brainstorm_run_verification")!.execute(
      "shutdown-verification",
      { claimIds: ["CL-001", "CL-002"] },
      undefined,
      undefined,
      ctx,
    );
    const runId = launch.details.runId as string;
    expect(delegationRequests).toHaveLength(2);
    expect(snapshotExternalRuns(sessionFile)).toHaveLength(1);

    await handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);

    expect(delegationCancellations).toEqual(
      delegationRequests.map((request) => ({
        requestId: request.requestId,
        ownerRunId: runId,
        nodeId: request.nodeId,
      })),
    );
    expect(snapshotExternalRuns(sessionFile)).toEqual([]);
    const entriesAfterShutdown = entries.length;
    for (const request of delegationRequests) {
      events.emit("prompt-template:subagent:response", {
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        status: "completed",
        result: {
          kind: "structured",
          value: { outcome: "supported", claimIds: [], evidenceIds: [] },
        },
      });
    }
    await Bun.sleep(0);
    expect(delegationRequests).toHaveLength(2);
    expect(entries).toHaveLength(entriesAfterShutdown);
    expect(snapshotExternalRuns(sessionFile)).toEqual([]);
  });

  it("quarantines a legacy UUID-only pending snapshot on restore", async () => {
    const first = createMockAPI();
    const firstContext = createMockContext();
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
      brainstormForcer(restored.pi);
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
  });

  it("restarts a corrupted session by clearing a pending run whose evidence is absent", async () => {
    const sessionManager = SessionManager.inMemory(process.cwd());
    const first = createMockAPI(sessionManager);
    const firstContext = createSessionManagerContext(sessionManager);
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
      brainstormForcer(restored.pi);
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
