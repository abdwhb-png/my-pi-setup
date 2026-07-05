import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Container, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resetAuditState, setActiveProfile } from "../_shared/audit-mode/audit-state";
import piOverrides, {
  auditAwareLsOperations,
  auditAwareFindOperations,
} from "./index";

function createMockTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

function createMockExtensionApi() {
  const handlers = new Map<string, (event: object, ctx: object) => Promise<void> | void>();
  const registeredTools = new Map<string, { name: string; renderResult?: (...args: [object, object, object, object]) => object }>();
  let activeTools: string[] = ["read", "bash", "edit", "write"];
  const pi = {
    on(event: string, handler: (event: object, ctx: object) => Promise<void> | void) {
      handlers.set(event, handler);
    },
    registerTool(tool: { name: string; renderResult?: (...args: [object, object, object, object]) => object }) {
      registeredTools.set(tool.name, tool);
    },
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => { activeTools = tools; },
  } as ExtensionAPI;
  return { pi, handlers, registeredTools, getActiveTools: () => activeTools };
}

describe("pi-overrides", () => {
  beforeEach(() => {
    resetAuditState("standard");
  });

  afterEach(() => {
    resetAuditState("standard");
  });

  it("registers read grep ls find and augments active toolset", async () => {
    const { pi, handlers, registeredTools, getActiveTools } = createMockExtensionApi();
    piOverrides(pi);
    expect(getActiveTools()).toEqual(["read", "bash", "edit", "write"]);
    await handlers.get("session_start")?.({}, { cwd: "/home/abdwhb/.pi/agent" });
    expect(Array.from(registeredTools.keys()).toSorted()).toEqual(["find", "grep", "ls", "read"]);
    expect(getActiveTools()).toContain("grep");
    expect(getActiveTools()).toContain("find");
    expect(getActiveTools()).toContain("ls");
    expect(getActiveTools()).toContain("read");
    expect(getActiveTools()).toContain("bash");
    expect(getActiveTools()).toContain("edit");
    expect(getActiveTools()).toContain("write");
  });

  it("wraps read renderResult with compression footer when compression details exist", async () => {
    const { pi, handlers, registeredTools } = createMockExtensionApi();
    piOverrides(pi);
    await handlers.get("session_start")?.({}, { cwd: "/home/abdwhb/.pi/agent" });
    const readTool = registeredTools.get("read");
    if (!readTool?.renderResult) throw new Error("read tool not registered");

    const component = readTool.renderResult(
      {
        content: [{ type: "text", text: "hello" }],
        details: {
          compression: {
            originalLength: 100,
            compressedLength: 40,
            savedBytes: 60,
            savedPct: 60,
          },
        },
        isError: false,
      },
      { expanded: false, isPartial: false },
      createMockTheme(),
      {
        args: { path: "/tmp/x" },
        toolCallId: "1",
        invalidate() {},
        lastComponent: undefined,
        state: {},
        cwd: "/tmp",
        executionStarted: false,
        argsComplete: true,
        isPartial: false,
        expanded: false,
        showImages: true,
        isError: false,
      },
    );

    expect(component instanceof Container || component instanceof Text).toBe(true);
    expect(component).toBeInstanceOf(Container);
  });

  // ─── Audit-aware ls operations (unit-level) ──────────────────────────────
  //
  // Tests call auditAwareLsOperations.readdir() directly so we exercise the
  // real filtering logic without going through the tool factory. /tmp is a
  // reliable choice because it always contains dotfiles (.ICE-unix, .config,
  // .X11-unix, etc.) on Linux.

  describe("auditAwareLsOperations.readdir", () => {
    it("hides dotfiles in standard mode", async () => {
      resetAuditState("standard");
      const entries = await auditAwareLsOperations.readdir("/tmp");
      expect(entries.length).toBeGreaterThan(0);
      const dotEntries = entries.filter((e) => e.startsWith("."));
      expect(dotEntries).toEqual([]);
    });

    it("shows dotfiles in audit mode", async () => {
      setActiveProfile("audit");
      const entries = await auditAwareLsOperations.readdir("/tmp");
      const dotEntries = entries.filter((e) => e.startsWith("."));
      expect(dotEntries.length).toBeGreaterThan(0);
    });

    it("shows dotfiles in advanced mode", async () => {
      setActiveProfile("advanced");
      const entries = await auditAwareLsOperations.readdir("/tmp");
      const dotEntries = entries.filter((e) => e.startsWith("."));
      expect(dotEntries.length).toBeGreaterThan(0);
    });

    it("standard mode hides dots that audit mode reveals — same directory, different policy", async () => {
      // Core behavioral contract: same directory, different results per profile.
      setActiveProfile("audit");
      const auditEntries = await auditAwareLsOperations.readdir("/tmp");
      const auditDots = auditEntries.filter((e) => e.startsWith("."));

      resetAuditState("standard");
      const standardEntries = await auditAwareLsOperations.readdir("/tmp");
      const standardDots = standardEntries.filter((e) => e.startsWith("."));

      expect(auditDots.length).toBeGreaterThan(0);
      expect(standardDots.length).toBe(0);
    });
  });

  // ─── ls integration: tool execute reflects the active policy ─────────────────

  describe("ls audit-mode: listing.showHidden via tool execute", () => {
    it("filters dotfiles from ls results in standard mode", async () => {
      resetAuditState("standard");
      const { pi, handlers, registeredTools } = createMockExtensionApi();
      piOverrides(pi);
      await handlers.get("session_start")?.({}, { cwd: "/tmp" });

      const lsTool = registeredTools.get("ls") as {
        execute?: (id: string, args: object, signal: AbortSignal) => Promise<{ content: Array<{ type: string; text: string }> }>;
      };
      if (!lsTool?.execute) throw new Error("ls tool execute not present");

      const result = await lsTool.execute("call1", { path: "/tmp" }, new AbortController().signal);
      const text = result.content.find((c) => c.type === "text")?.text ?? "";
      const lines = text.split("\n").filter(Boolean);
      expect(lines.every((l) => !l.startsWith("."))).toBe(true);
    });

    it("includes dotfiles in ls results in audit mode", async () => {
      setActiveProfile("audit");
      const { pi, handlers, registeredTools } = createMockExtensionApi();
      piOverrides(pi);
      await handlers.get("session_start")?.({}, { cwd: "/tmp" });

      const lsTool = registeredTools.get("ls") as {
        execute?: (id: string, args: object, signal: AbortSignal) => Promise<{ content: Array<{ type: string; text: string }> }>;
      };
      if (!lsTool?.execute) throw new Error("ls tool execute not present");

      const result = await lsTool.execute("call2", { path: "/tmp" }, new AbortController().signal);
      const text = result.content.find((c) => c.type === "text")?.text ?? "";
      const lines = text.split("\n").filter(Boolean);
      // /tmp always has dotfiles (.ICE-unix etc.) — audit mode must reveal at least one
      const dotLines = lines.filter((l) => l.startsWith("."));
      expect(dotLines.length).toBeGreaterThan(0);
    });
  });

  // ─── Audit-mode: tool registration uses audit-aware operations ────────────────

  describe("audit-mode: tool registration uses audit-aware operations", () => {
    it("registers ls grep find in standard mode", async () => {
      resetAuditState("standard");
      const { pi, handlers, registeredTools } = createMockExtensionApi();
      piOverrides(pi);
      await handlers.get("session_start")?.({}, { cwd: "/tmp" });
      expect(registeredTools.has("ls")).toBe(true);
      expect(registeredTools.has("grep")).toBe(true);
      expect(registeredTools.has("find")).toBe(true);
    });

    it("registers ls in audit mode", async () => {
      setActiveProfile("audit");
      const { pi, handlers, registeredTools } = createMockExtensionApi();
      piOverrides(pi);
      await handlers.get("session_start")?.({}, { cwd: "/tmp" });
      expect(registeredTools.has("ls")).toBe(true);
    });

    it("registers ls in advanced mode", async () => {
      setActiveProfile("advanced");
      const { pi, handlers, registeredTools } = createMockExtensionApi();
      piOverrides(pi);
      await handlers.get("session_start")?.({}, { cwd: "/tmp" });
      expect(registeredTools.has("ls")).toBe(true);
    });
  });

  // ─── Audit-aware find operations (unit-level) ──────────────────────────────────
  //
  // glob() spawns the fd binary. We test it directly against a real directory
  // so that any FD_BIN path breakage is caught early.
  // The --no-ignore behaviour difference is verified against node_modules/:
  // standard mode respects .gitignore (node_modules hidden), audit mode does
  // not (node_modules visible). /home/abdwhb/.pi/agent has a .gitignore that
  // ignores node_modules/ and has a populated node_modules tree.

  describe("auditAwareFindOperations.glob", () => {
    const AGENT_DIR = "/home/abdwhb/.pi/agent";

    it("glob runs without error in standard mode (fd binary is reachable)", async () => {
      resetAuditState("standard");
      const results = await auditAwareFindOperations.glob("*.json", AGENT_DIR, {
        ignore: [],
        limit: 10,
      });
      expect(Array.isArray(results)).toBe(true);
    });

    it("glob runs without error in audit mode (fd binary is reachable)", async () => {
      setActiveProfile("audit");
      const results = await auditAwareFindOperations.glob("*.json", AGENT_DIR, {
        ignore: [],
        limit: 10,
      });
      expect(Array.isArray(results)).toBe(true);
    });

    it("standard mode respects gitignore: node_modules package.json hidden", async () => {
      resetAuditState("standard");
      const results = await auditAwareFindOperations.glob(
        "**/node_modules/*/package.json",
        AGENT_DIR,
        { ignore: [], limit: 500 },
      );
      // With .gitignore respected, node_modules is excluded — very few or zero results
      expect(results.length).toBeLessThan(50);
    });

    it("audit mode ignores gitignore: node_modules package.json visible", async () => {
      setActiveProfile("audit");
      const results = await auditAwareFindOperations.glob(
        "**/node_modules/*/package.json",
        AGENT_DIR,
        { ignore: [], limit: 500 },
      );
      // With --no-ignore, fd traverses node_modules freely — many results
      expect(results.length).toBeGreaterThan(10);
    });

    it("audit sees more gitignored content than standard — canonical behavioral contract", async () => {
      setActiveProfile("audit");
      const auditResults = await auditAwareFindOperations.glob(
        "**/node_modules/*/package.json",
        AGENT_DIR,
        { ignore: [], limit: 1000 },
      );

      resetAuditState("standard");
      const standardResults = await auditAwareFindOperations.glob(
        "**/node_modules/*/package.json",
        AGENT_DIR,
        { ignore: [], limit: 1000 },
      );

      expect(auditResults.length).toBeGreaterThan(standardResults.length);
    });
  });

  // ─── Audit-mode: grep.ignoreGitignore (BLOCKED) ──────────────────────────────────
  //
  // grep.ignoreGitignore is NOT implemented. The createGrepToolDefinition()
  // factory has no hook to inject --no-ignore into the rg invocation.
  // See the BLOCKERS comment in index.ts for full evidence.
  //
  // These tests document the current state accurately:
  //   - grep IS registered (factory works).
  //   - grep.ignoreGitignore has NO behavioral effect — we do NOT assert
  //     otherwise, as that would give false confidence.

  describe("grep audit-mode: grep.ignoreGitignore is blocked (documented)", () => {
    it("grep tool is registered in standard mode", async () => {
      resetAuditState("standard");
      const { pi, handlers, registeredTools } = createMockExtensionApi();
      piOverrides(pi);
      await handlers.get("session_start")?.({}, { cwd: "/home/abdwhb/.pi/agent" });
      expect(registeredTools.has("grep")).toBe(true);
      // NOTE: grep.ignoreGitignore is NOT enforced. rg --no-ignore cannot be
      // injected via the current factory API. Both profiles behave identically
      // with respect to .gitignore. See BLOCKERS in index.ts.
    });

    it("grep tool is registered in audit mode", async () => {
      setActiveProfile("audit");
      const { pi, handlers, registeredTools } = createMockExtensionApi();
      piOverrides(pi);
      await handlers.get("session_start")?.({}, { cwd: "/home/abdwhb/.pi/agent" });
      expect(registeredTools.has("grep")).toBe(true);
      // NOTE: See above — grep.ignoreGitignore is blocked (no factory hook).
    });
  });

  // ─── LLM-disambiguation: pattern vs description docs ─────────────────────────
  //
  // Lighter LLMs repeatedly confuse JSON-Schema field `description` (which
  // annotates the `pattern` prop on pi's schemas) for a tool argument. They
  // emit { "description": "pattern: php" } instead of { "pattern": "php" }
  // and loop forever on validation errors. Pi does NOT silently repair args
  // — we steer the LLM via three official doc channels (description,
  // promptSnippet, promptGuidelines). promptGuidelines lands in the
  // Guidelines section of the system prompt every turn.

  describe("LLM-disambiguation: docs steer LLM away from `description` confusion", () => {
    it("grep tool surfaces pattern/description disambiguation in docs", async () => {
      resetAuditState("standard");
      const { pi, handlers, registeredTools } = createMockExtensionApi();
      piOverrides(pi);
      await handlers.get("session_start")?.({}, { cwd: "/tmp" });
      const grep = registeredTools.get("grep") as {
        description?: string;
        promptSnippet?: string;
        promptGuidelines?: string[];
      };
      if (!grep) throw new Error("grep tool not registered");
      // Description must name `pattern` as the required argument
      expect(grep.description).toMatch(/`pattern`/);
      // Description must explicitly warn against the `description` failure mode
      expect(grep.description?.toLowerCase()).toContain("do not use `description`");
      // Prompt snippet must mention `pattern`
      expect(grep.promptSnippet).toMatch(/`pattern`/);
      // Prompt guidelines present and at least one explicitly mentions the `pattern` arg
      expect(Array.isArray(grep.promptGuidelines)).toBe(true);
      expect(grep.promptGuidelines!.length).toBeGreaterThan(0);
      expect(grep.promptGuidelines!.some((g) => /`pattern`/i.test(g))).toBe(true);
    });

    it("find tool surfaces pattern/description disambiguation in docs", async () => {
      resetAuditState("standard");
      const { pi, handlers, registeredTools } = createMockExtensionApi();
      piOverrides(pi);
      await handlers.get("session_start")?.({}, { cwd: "/tmp" });
      const find = registeredTools.get("find") as {
        description?: string;
        promptSnippet?: string;
        promptGuidelines?: string[];
      };
      if (!find) throw new Error("find tool not registered");
      expect(find.description).toMatch(/`pattern`/);
      expect(find.promptSnippet).toMatch(/`pattern`/);
      expect(Array.isArray(find.promptGuidelines)).toBe(true);
      expect(find.promptGuidelines!.some((g) => /`pattern`/i.test(g))).toBe(true);
    });

    it("ls tool surfaces `path` argument in docs", async () => {
      resetAuditState("standard");
      const { pi, handlers, registeredTools } = createMockExtensionApi();
      piOverrides(pi);
      await handlers.get("session_start")?.({}, { cwd: "/tmp" });
      const ls = registeredTools.get("ls") as {
        promptGuidelines?: string[];
      };
      if (!ls) throw new Error("ls tool not registered");
      expect(Array.isArray(ls.promptGuidelines)).toBe(true);
      expect(ls.promptGuidelines!.some((g) => /`path`/i.test(g))).toBe(true);
    });

    it("read tool surfaces `path` argument in docs", async () => {
      resetAuditState("standard");
      const { pi, handlers, registeredTools } = createMockExtensionApi();
      piOverrides(pi);
      await handlers.get("session_start")?.({}, { cwd: "/tmp" });
      const read = registeredTools.get("read") as {
        promptGuidelines?: string[];
      };
      if (!read) throw new Error("read tool not registered");
      expect(Array.isArray(read.promptGuidelines)).toBe(true);
      expect(read.promptGuidelines!.some((g) => /`path`/i.test(g))).toBe(true);
    });
  });
});
