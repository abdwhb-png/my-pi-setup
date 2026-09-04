import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  createEventBus,
  type ExtensionAPI,
  type SlashCommandInfo,
  type SourceInfo,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  isMarkdownLinkTransformRequest,
  MARKDOWN_LINKS_TRANSFORM_EVENT,
} from "../_shared/markdown-links.ts";
import piSkillLoader from "./index";

function makeSourceInfo(overrides: Partial<SourceInfo> = {}): SourceInfo {
  return {
    path: "",
    source: "user",
    scope: "user",
    origin: "top-level",
    ...overrides,
  };
}

function makeSkillCommand(name: string, path: string, description = `Description for ${name}`): SlashCommandInfo {
  return {
    name: `skill:${name}`,
    description,
    source: "skill",
    sourceInfo: makeSourceInfo({ path }),
  };
}

function createMockAPI(customCommands?: SlashCommandInfo[]) {
  const commands: SlashCommandInfo[] = customCommands ?? [
    makeSkillCommand("tdd", "/skills/tdd/SKILL.md", "Test-driven development"),
    makeSkillCommand("bun-test", "/skills/bun-test/SKILL.md", "Bun test runner"),
    makeSkillCommand("systematic-debugging", "/skills/debug/SKILL.md", "Debug systematically"),
    { name: "some-ext-cmd", source: "extension", sourceInfo: makeSourceInfo({ path: "/ext/cmd.ts" }) },
  ];

  const registeredTools = new Map<string, ToolDefinition>();
  const registeredCommands = new Map<string, {
    description?: string;
    getArgumentCompletions?: (prefix: string) => { value: string; label: string; description?: string }[] | null;
    handler: (args: string, ctx?: { cwd: string }) => Promise<void>;
  }>();
  let activeTools: string[] = ["read", "edit", "write"];
  const sentMessages: Array<{ customType: string; content: string; display: boolean }> = [];
  const handlers = new Map<string, (event: object, ctx?: object) => Promise<void> | void>();
  const events = createEventBus();

  const pi = {
    events,
    getCommands: () => commands,
    registerTool(tool: ToolDefinition) {
      registeredTools.set(tool.name, tool);
    },
    registerCommand(
      name: string,
      opts: {
        description?: string;
        getArgumentCompletions?: (prefix: string) => { value: string; label: string; description?: string }[] | null;
        handler: (args: string, ctx?: unknown) => Promise<void>;
      },
    ) {
      registeredCommands.set(name, opts);
    },
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => {
      activeTools = tools;
    },
    sendMessage(msg: { customType: string; content: string; display: boolean }) {
      sentMessages.push(msg);
    },
    on(event: string, handler: (event: object, ctx?: object) => Promise<void> | void) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  return { pi, commands, registeredTools, registeredCommands, activeTools, sentMessages, handlers };
}

// Mock readFile
const readFileMock = mock();

mock.module("node:fs/promises", () => ({
  readFile: readFileMock,
}));

/** Helper: load extension and fire session_start */
async function initExtension(
  mockApi: ReturnType<typeof createMockAPI>,
): Promise<void> {
  piSkillLoader(mockApi.pi);
  await mockApi.handlers.get("session_start")?.({}, {});
}

/** Helper: call tool.execute with full 5-arg signature and extract text content */
async function execTool(
  tool: ToolDefinition | undefined,
  toolName: string,
  params: Record<string, unknown>,
): Promise<string> {
  if (!tool?.execute) throw new Error(`${toolName} not registered`);
  const result = await tool.execute(
    "call1",
    params,
    undefined,
    undefined,
    { cwd: "/workspace" } as any,
  );
  return result.content.find((c) => c.type === "text")?.text as string ?? "";
}

describe("pi-skill-loader", () => {
  beforeEach(() => {
    readFileMock.mockReset();
  });

  afterEach(() => {
    readFileMock.mockReset();
  });

  describe("tool registration", () => {
    it("registers search_skill, find_skill, load_skill tools", async () => {
      const { pi, registeredTools, handlers } = createMockAPI();
      piSkillLoader(pi);
      await handlers.get("session_start")?.({}, {});

      expect(registeredTools.has("search_skill")).toBe(true);
      expect(registeredTools.has("find_skill")).toBe(true);
      expect(registeredTools.has("load_skill")).toBe(true);
    });

    it("adds new tools to active tools", async () => {
      const { pi, handlers } = createMockAPI();
      piSkillLoader(pi);
      await handlers.get("session_start")?.({}, {});

      const active = pi.getActiveTools();
      expect(active).toContain("search_skill");
      expect(active).toContain("find_skill");
      expect(active).toContain("load_skill");
    });

    it("adds tools to active tools non-destructively (keeps existing tools)", async () => {
      const { pi, handlers } = createMockAPI();
      piSkillLoader(pi);
      await handlers.get("session_start")?.({}, {});

      const active = pi.getActiveTools();
      expect(active).toContain("read");
      expect(active).toContain("edit");
      expect(active).toContain("write");
    });
  });

  describe("search_skill execute", () => {
    it("returns matching skills for query", async () => {
      const { pi, registeredTools, handlers } = createMockAPI();
      piSkillLoader(pi);
      await handlers.get("session_start")?.({}, {});

      const text = await execTool(registeredTools.get("search_skill"), "search_skill", { query: "test" });
      expect(text).toContain("tdd");
      expect(text).toContain("bun-test");
    });

    it("returns empty message when no skills match", async () => {
      const { pi, registeredTools, handlers } = createMockAPI();
      piSkillLoader(pi);
      await handlers.get("session_start")?.({}, {});

      const text = await execTool(registeredTools.get("search_skill"), "search_skill", { query: "zzz_nonexistent" });
      expect(text).toContain("No skills found");
    });

    it("refreshes skill list from getCommands on each call", async () => {
      const { pi, registeredTools, handlers } = createMockAPI();
      piSkillLoader(pi);
      await handlers.get("session_start")?.({}, {});

      // Override getCommands to return different skills mid-session
      (pi as any).getCommands = () => [
        makeSkillCommand("session-cron", "/skills/cron/SKILL.md"),
      ];

      const text = await execTool(registeredTools.get("search_skill"), "search_skill", { query: "cron" });
      expect(text).toContain("session-cron");
    });
  });

  describe("find_skill execute", () => {
    it("returns skill metadata for exact match", async () => {
      const { pi, registeredTools, handlers } = createMockAPI();
      piSkillLoader(pi);
      await handlers.get("session_start")?.({}, {});

      const text = await execTool(registeredTools.get("find_skill"), "find_skill", { name: "tdd" });
      expect(text).toContain("Skill: tdd");
      expect(text).toContain("/skills/tdd/SKILL.md");
    });

    it("returns not-found message for missing skill", async () => {
      const { pi, registeredTools, handlers } = createMockAPI();
      piSkillLoader(pi);
      await handlers.get("session_start")?.({}, {});

      const text = await execTool(registeredTools.get("find_skill"), "find_skill", { name: "nonexistent" });
      expect(text).toContain("not found");
    });
  });

  describe("load_skill execute", () => {
    it("returns SKILL.md content for valid skill", async () => {
      readFileMock.mockResolvedValue(Buffer.from("# TDD Skill\n\nWrite tests first."));

      const { pi, registeredTools, handlers } = createMockAPI();
      piSkillLoader(pi);
      await handlers.get("session_start")?.({}, {});

      const text = await execTool(registeredTools.get("load_skill"), "load_skill", { name: "tdd" });
      expect(text).toContain("# TDD Skill");
      expect(text).toContain("Write tests first.");
    });

    it("requests source-aware Markdown rewriting for loaded content", async () => {
      readFileMock.mockResolvedValue(Buffer.from("Read [guide](guide.md)"));
      const { pi, registeredTools, handlers } = createMockAPI();
      pi.events.on(MARKDOWN_LINKS_TRANSFORM_EVENT, (value) => {
        if (!isMarkdownLinkTransformRequest(value)) return;
        expect(value.sourcePath).toBe("/skills/tdd/SKILL.md");
        expect(value.sourceKind).toBe("load-skill-tool");
        value.result = "Read [guide](/skills/tdd/guide.md)";
      });
      piSkillLoader(pi);
      await handlers.get("session_start")?.({}, {});

      const text = await execTool(registeredTools.get("load_skill"), "load_skill", { name: "tdd" });

      expect(text).toBe("Read [guide](/skills/tdd/guide.md)");
    });

    it("returns error when skill file cannot be read", async () => {
      readFileMock.mockRejectedValue(new Error("ENOENT: no such file"));

      const { pi, registeredTools, handlers } = createMockAPI();
      piSkillLoader(pi);
      await handlers.get("session_start")?.({}, {});

      const text = await execTool(registeredTools.get("load_skill"), "load_skill", { name: "tdd" });
      expect(text).toContain("Failed to read skill file");
    });

    it("returns not-found message for missing skill", async () => {
      const { pi, registeredTools, handlers } = createMockAPI();
      piSkillLoader(pi);
      await handlers.get("session_start")?.({}, {});

      const text = await execTool(registeredTools.get("load_skill"), "load_skill", { name: "nonexistent" });
      expect(text).toContain("not found");
    });
  });

  describe("/load-skills command", () => {
    it("autocomplete returns matching skill names for prefix", async () => {
      const { pi, registeredCommands, handlers } = createMockAPI();
      piSkillLoader(pi);
      await handlers.get("session_start")?.({}, {});

      const cmd = registeredCommands.get("load-skills");
      if (!cmd?.getArgumentCompletions) throw new Error("load-skills not registered");

      const completions = cmd.getArgumentCompletions("td") ?? [];
      expect(completions.length).toBeGreaterThan(0);
      expect(completions[0].value).toBe("tdd");
    });

    it("autocomplete excludes already-matched skills in multi-arg", async () => {
      const { pi, registeredCommands, handlers } = createMockAPI();
      piSkillLoader(pi);
      await handlers.get("session_start")?.({}, {});

      const cmd = registeredCommands.get("load-skills");
      if (!cmd?.getArgumentCompletions) throw new Error("load-skills not registered");

      const completions = cmd.getArgumentCompletions("tdd bun") ?? [];
      const values = completions.map((c) => c.value);
      // "bun" should match "bun-test" but NOT "tdd" (already matched)
      expect(values).toContain("bun-test");
      expect(values).not.toContain("tdd");
    });

    it("autocomplete returns empty for unmatched prefix", async () => {
      const { pi, registeredCommands, handlers } = createMockAPI();
      piSkillLoader(pi);
      await handlers.get("session_start")?.({}, {});

      const cmd = registeredCommands.get("load-skills");
      if (!cmd?.getArgumentCompletions) throw new Error("load-skills not registered");

      const completions = cmd.getArgumentCompletions("zzz") ?? [];
      expect(completions).toHaveLength(0);
    });

    it("handler loads multiple skills and sends messages", async () => {
      readFileMock.mockImplementation((path: string) => {
        if (path === "/skills/tdd/SKILL.md") return Promise.resolve(Buffer.from("# TDD Skill"));
        if (path === "/skills/bun-test/SKILL.md") return Promise.resolve(Buffer.from("# Bun Test Skill"));
        throw new Error("ENOENT");
      });

      const { pi, registeredCommands, sentMessages, handlers } = createMockAPI();
      piSkillLoader(pi);
      await handlers.get("session_start")?.({}, {});

      const cmd = registeredCommands.get("load-skills");
      if (!cmd?.handler) throw new Error("load-skills not registered");

      await cmd.handler("tdd bun-test", { cwd: "/workspace" });

      expect(sentMessages.length).toBe(2);
      expect(sentMessages[0].content).toContain("# TDD Skill");
      expect(sentMessages[1].content).toContain("# Bun Test Skill");
    });

    it("rewrites Markdown before /load-skills sends it", async () => {
      readFileMock.mockResolvedValue(Buffer.from("Read [guide](guide.md)"));
      const { pi, registeredCommands, sentMessages, handlers } = createMockAPI();
      pi.events.on(MARKDOWN_LINKS_TRANSFORM_EVENT, (value) => {
        if (!isMarkdownLinkTransformRequest(value)) return;
        expect(value.sourceKind).toBe("load-skills-command");
        value.result = "Read [guide](/skills/tdd/guide.md)";
      });
      piSkillLoader(pi);
      await handlers.get("session_start")?.({}, {});

      const cmd = registeredCommands.get("load-skills");
      if (!cmd?.handler) throw new Error("load-skills not registered");
      await cmd.handler("tdd", { cwd: "/workspace" });

      expect(sentMessages[0].content).toContain(
        "Read [guide](/skills/tdd/guide.md)",
      );
    });

    it("handler skips unknown skills silently", async () => {
      readFileMock.mockResolvedValue(Buffer.from("# TDD Skill"));

      const { pi, registeredCommands, sentMessages, handlers } = createMockAPI();
      piSkillLoader(pi);
      await handlers.get("session_start")?.({}, {});

      const cmd = registeredCommands.get("load-skills");
      if (!cmd?.handler) throw new Error("load-skills not registered");

      await cmd.handler("nonexistent tdd", { cwd: "/workspace" });

      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].content).toContain("# TDD Skill");
    });
  });

  describe("session_start auto-refresh", () => {
    it("refreshes skill list on session start", async () => {
      const { pi, handlers, registeredTools } = createMockAPI();
      piSkillLoader(pi);

      // Firing session_start should work without error
      await handlers.get("session_start")?.({}, {});

      const tool = registeredTools.get("search_skill");
      if (!tool?.execute) throw new Error("search_skill not registered");

      const result = await tool.execute("call1", { query: "tdd" }, undefined, undefined, {} as any);
      expect(result.content.length).toBeGreaterThan(0);
    });
  });
});
