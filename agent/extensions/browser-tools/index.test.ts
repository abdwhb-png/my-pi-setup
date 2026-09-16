import { describe, expect, mock, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  TestHooks,
  mountPolicy,
  trackPolicyCleanup,
} from "../__tests__/policy-fixture.ts";
import { getToolPolicy } from "../_shared/tool-policy/index.ts";

type CapturedWidget = {
  id: string;
  label?: string;
  description?: string;
  row?: number;
  order?: number;
  align?: string;
  icon?: unknown;
  styled?: boolean;
  render: (ctx: { theme: Theme | undefined }) => unknown;
};

// Capture the contributed footer widget instead of loading pi-fancy-footer.
const widgetState: {
  def: CapturedWidget | null;
  updates: Array<string | null | undefined>;
  removed: number;
} = { def: null, updates: [], removed: 0 };

mock.module("../_shared/fancy-footer.ts", () => ({
  createWidget: (_pi: unknown, def: CapturedWidget) => {
    widgetState.def = def;
    return {
      active: false,
      update: (_ctx: unknown, text?: string | null) => {
        widgetState.updates.push(text);
      },
      remove: () => {
        widgetState.removed += 1;
      },
    };
  },
}));

const { default: browserToolsExtension } = await import("./index.ts");

function fakeTheme(): Theme {
  return {
    fg: (color: string, text: string) => `fg:${color}:${text}`,
  } as unknown as Theme;
}

function renderWidget(theme: Theme | undefined = fakeTheme()): string {
  if (!widgetState.def) throw new Error("footer widget was not contributed");
  return String(widgetState.def.render({ theme }));
}

function registerRuntime(options: {
  requested?: string[];
  childAllowed?: string[];
  nativeOrder?: "absent" | "after" | "before";
} = {}) {
  const tools = new Map<string, { name: string }>();
  const commands = new Map<string, { handler: Function }>();
  const hooks = new TestHooks();
  const eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  let activeTools = ["read"];
  const entries: Array<{ type: string; customType?: string; data?: unknown }> =
    [];
  const pi = {
    registerTool(definition: { name: string }) {
      tools.set(definition.name, definition);
      if (!activeTools.includes(definition.name)) activeTools.push(definition.name);
    },
    registerCommand(name: string, definition: { handler: Function }) {
      commands.set(name, definition);
    },
    appendEntry(customType: string, data?: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    on(event: string, handler: (...args: any[]) => unknown) {
      hooks.set(event, handler);
    },
    events: {
      on(event: string, handler: (payload: unknown) => void) {
        const listeners = eventHandlers.get(event) ?? new Set();
        listeners.add(handler);
        eventHandlers.set(event, listeners);
        return () => listeners.delete(handler);
      },
      emit(event: string, payload: unknown) {
        for (const listener of eventHandlers.get(event) ?? []) listener(payload);
      },
    },
    getAllTools: () => [...tools.values()],
    getActiveTools: () => [...activeTools],
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
  };
  const sessionManager = {
    getEntries: () => [...entries],
    getSessionId: () => "test-session",
  };
  const registerNativeTools = () => {
    pi.registerTool({ name: "agent_browser" });
    pi.registerTool({ name: "agent_browser_web_search" });
  };
  const nativeOrder = options.nativeOrder ?? "before";
  if (nativeOrder === "before") registerNativeTools();
  const host = {
    registered: () => ["read", ...tools.keys()],
    active: pi.getActiveTools,
    apply: pi.setActiveTools,
  };
  if (options.requested || options.childAllowed) {
    const policy = getToolPolicy();
    const detach = policy.bind(host, {
      groups: {},
      requested: options.requested,
      childAllowed: options.childAllowed,
      resolveMcp: () => [],
    });
    trackPolicyCleanup(detach);
    hooks.afterStart = () => policy.start();
  } else {
    mountPolicy(host, hooks);
  }
  pi.events.on("pi-roles:tool-policy", (payload) =>
    getToolPolicy().setRole(payload as any),
  );
  browserToolsExtension(pi as any);
  if (nativeOrder === "after") registerNativeTools();
  return { commands, entries, hooks, pi, sessionManager, tools };
}

describe("browser-tools", () => {
  test("does not register or own the native Agent Browser tools", () => {
    const runtime = registerRuntime({ nativeOrder: "absent" });
    expect(runtime.tools.size).toBe(0);
  });

  test.each(["before", "after"] as const)(
    "hides a native extension loaded %s the policy wrapper until the user grants access",
    async (nativeOrder) => {
      const runtime = registerRuntime({ nativeOrder });
      const notices: Array<[string, string | undefined]> = [];
      const ctx = {
        ui: {
          notify(message: string, level?: string) {
            notices.push([message, level]);
          },
        },
        sessionManager: runtime.sessionManager,
      };

      runtime.hooks.get("session_start")!({ reason: "startup" }, ctx);
      expect(runtime.pi.getActiveTools()).toEqual(["read"]);

      await runtime.commands.get("browser-tools")!.handler("on", ctx);
      expect(runtime.pi.getActiveTools()).toEqual(["read", "agent_browser"]);
      expect(notices.at(-1)).toEqual(["Browser tools: manual", "info"]);
    },
  );

  test("revokes access and blocks stale calls without stopping upstream ownership", async () => {
    const runtime = registerRuntime();
    const ctx = { ui: { notify() {} }, sessionManager: runtime.sessionManager };
    runtime.hooks.get("session_start")!({ reason: "startup" }, ctx);

    await runtime.commands.get("browser-tools")!.handler("on", ctx);
    expect(runtime.pi.getActiveTools()).toEqual(["read", "agent_browser"]);
    expect(
      runtime.hooks.get("tool_call")!({ toolName: "agent_browser" }, ctx),
    ).toBeUndefined();

    await runtime.commands.get("browser-tools")!.handler("off", ctx);
    expect(runtime.pi.getActiveTools()).toEqual(["read"]);
    expect(
      runtime.hooks.get("tool_call")!({ toolName: "agent_browser" }, ctx),
    ).toEqual({
      block: true,
      reason: "Agent Browser is hidden. Ask the user to run /browser-tools on.",
    });
  });

  test("always hides and blocks the optional web-search tool", async () => {
    const runtime = registerRuntime();
    const ctx = { ui: { notify() {} }, sessionManager: runtime.sessionManager };
    runtime.hooks.get("session_start")!({ reason: "startup" }, ctx);
    await runtime.commands.get("browser-tools")!.handler("on", ctx);

    expect(runtime.pi.getActiveTools()).not.toContain("agent_browser_web_search");
    expect(
      runtime.hooks.get("tool_call")!(
        { toolName: "agent_browser_web_search" },
        ctx,
      ),
    ).toEqual({
      block: true,
      reason: "Agent Browser Web Search is not enabled by browser-tools.",
    });
  });

	test("reports hidden, restricted, unavailable, and invalid command states", async () => {
    const notices: Array<[string, string | undefined]> = [];
    const restricted = registerRuntime({ requested: ["read"] });
    const ctx = {
      ui: {
        notify(message: string, level?: string) {
          notices.push([message, level]);
        },
      },
      sessionManager: restricted.sessionManager,
    };

    restricted.hooks.get("session_start")!({ reason: "startup" }, ctx);

    await restricted.commands.get("browser-tools")!.handler("", ctx);
    expect(notices.at(-1)).toEqual(["Browser tools: hidden", "info"]);
    await restricted.commands.get("browser-tools")!.handler("on", ctx);
    expect(notices.at(-1)).toEqual([
      "Browser tools: manual (restricted)",
      "info",
    ]);
    await restricted.commands.get("browser-tools")!.handler("wat", ctx);
    expect(notices.at(-1)).toEqual([
      "Usage: /browser-tools [on|off|status]",
      "warning",
    ]);

    restricted.hooks.get("session_shutdown")!({}, ctx);
    const unavailable = registerRuntime({ nativeOrder: "absent" });
    const unavailableCtx = {
      ui: {
        notify(message: string, level?: string) {
          notices.push([message, level]);
        },
      },
      sessionManager: unavailable.sessionManager,
    };
    unavailable.hooks.get("session_start")!({ reason: "startup" }, unavailableCtx);
    await unavailable.commands.get("browser-tools")!.handler("on", unavailableCtx);
		expect(notices.at(-1)).toEqual(["Browser tools: unavailable", "warning"]);
	});

	test.each([
		["CLI", { requested: ["read"] }],
		["child", { childAllowed: ["read"] }],
	])("keeps the %s tool ceiling above a manual grant", async (_name, options) => {
		const runtime = registerRuntime(options);
		const notices: Array<[string, string | undefined]> = [];
		const ctx = {
			ui: {
				notify(message: string, level?: string) {
					notices.push([message, level]);
				},
			},
			sessionManager: runtime.sessionManager,
		};
		runtime.hooks.get("session_start")!({ reason: "startup" }, ctx);

		await runtime.commands.get("browser-tools")!.handler("on", ctx);
		expect(runtime.pi.getActiveTools()).toEqual(["read"]);
		expect(notices.at(-1)).toEqual([
			"Browser tools: manual (restricted)",
			"info",
		]);
	});

  test("does not activate from a role policy without a manual grant", async () => {
    const runtime = registerRuntime();
    const ctx = { ui: { notify() {} }, sessionManager: runtime.sessionManager };
    runtime.hooks.get("session_start")!({ reason: "startup" }, ctx);
    runtime.pi.events.emit("pi-roles:tool-policy", {
      version: 1,
      roleName: "browser-specialist",
      mode: "set",
      toolNames: ["read", "agent_browser"],
    });

    expect(runtime.pi.getActiveTools()).toEqual(["read"]);
    await runtime.commands.get("browser-tools")!.handler("on", ctx);
    expect(runtime.pi.getActiveTools()).toEqual(["read", "agent_browser"]);
  });

  test("keeps the grant across reload and resume, and clears it on shutdown", async () => {
    const runtime = registerRuntime();
    const ctx = { ui: { notify() {} }, sessionManager: runtime.sessionManager };
    runtime.hooks.get("session_start")!({ reason: "startup" }, ctx);

    await runtime.commands.get("browser-tools")!.handler("on", ctx);
    expect(runtime.pi.getActiveTools()).toContain("agent_browser");

    for (const reason of ["reload", "resume"] as const) {
      runtime.hooks.get("session_start")!({ reason }, ctx);
      expect(runtime.pi.getActiveTools()).toContain("agent_browser");
      expect(
        runtime.hooks.get("tool_call")!({ toolName: "agent_browser" }, ctx),
      ).toBeUndefined();
    }

    runtime.hooks.get("session_shutdown")!({ reason: "quit" }, ctx);
    expect(
      runtime.hooks.get("tool_call")!({ toolName: "agent_browser" }, ctx),
    ).toEqual({
      block: true,
      reason: "Agent Browser is hidden. Ask the user to run /browser-tools on.",
    });
  });

  test("records the grant in the session transcript", async () => {
    const runtime = registerRuntime();
    const ctx = { ui: { notify() {} }, sessionManager: runtime.sessionManager };
    runtime.hooks.get("session_start")!({ reason: "startup" }, ctx);

    await runtime.commands.get("browser-tools")!.handler("on", ctx);
    expect(runtime.entries).toEqual([
      { type: "custom", customType: "browser-tools:grant", data: { granted: true } },
    ]);

    await runtime.commands.get("browser-tools")!.handler("off", ctx);
    expect(runtime.entries.at(-1)).toEqual({
      type: "custom",
      customType: "browser-tools:grant",
      data: { granted: false },
    });

    const recorded = runtime.entries.length;
    await runtime.commands.get("browser-tools")!.handler("off", ctx);
    expect(runtime.entries.length).toBe(recorded);
  });

  test("starts hidden in a new or forked session even with a recorded grant", async () => {
    const runtime = registerRuntime();
    const ctx = { ui: { notify() {} }, sessionManager: runtime.sessionManager };
    runtime.hooks.get("session_start")!({ reason: "startup" }, ctx);
    await runtime.commands.get("browser-tools")!.handler("on", ctx);

    for (const reason of ["new", "fork"] as const) {
      runtime.hooks.get("session_start")!({ reason }, ctx);
      expect(runtime.pi.getActiveTools()).toEqual(["read"]);
      expect(
        runtime.hooks.get("tool_call")!({ toolName: "agent_browser" }, ctx),
      ).toEqual({
        block: true,
        reason: "Agent Browser is hidden. Ask the user to run /browser-tools on.",
      });
    }
  });

  test("takes the last recorded grant and ignores foreign or malformed entries", async () => {
    const runtime = registerRuntime();
    const ctx = { ui: { notify() {} }, sessionManager: runtime.sessionManager };
    runtime.hooks.get("session_start")!({ reason: "startup" }, ctx);
    runtime.entries.push(
      { type: "custom", customType: "other:grant", data: { granted: true } },
      { type: "message" },
      { type: "custom", customType: "browser-tools:grant", data: { granted: true } },
      { type: "custom", customType: "browser-tools:grant", data: "nope" },
      { type: "custom", customType: "browser-tools:grant", data: { granted: "yes" } },
    );

    runtime.hooks.get("session_start")!({ reason: "resume" }, ctx);
    expect(runtime.pi.getActiveTools()).toContain("agent_browser");

    runtime.entries.push({
      type: "custom",
      customType: "browser-tools:grant",
      data: { granted: false },
    });
    runtime.hooks.get("session_start")!({ reason: "resume" }, ctx);
    expect(runtime.pi.getActiveTools()).toEqual(["read"]);
  });

  test("records a revocation when a restored grant outlives the native tool", async () => {
    const runtime = registerRuntime({ nativeOrder: "absent" });
    const ctx = { ui: { notify() {} }, sessionManager: runtime.sessionManager };
    runtime.entries.push({
      type: "custom",
      customType: "browser-tools:grant",
      data: { granted: true },
    });
    runtime.hooks.get("session_start")!({ reason: "resume" }, ctx);

    await runtime.commands.get("browser-tools")!.handler("on", ctx);
    expect(runtime.entries.at(-1)).toEqual({
      type: "custom",
      customType: "browser-tools:grant",
      data: { granted: false },
    });
  });

  test("re-derives the grant on the first input when session start saw no entries", async () => {
    const runtime = registerRuntime();
    const ctx = { ui: { notify() {} }, sessionManager: runtime.sessionManager };
    runtime.hooks.get("session_start")!({ reason: "resume" }, ctx);
    expect(runtime.pi.getActiveTools()).toEqual(["read"]);

    runtime.entries.push({
      type: "custom",
      customType: "browser-tools:grant",
      data: { granted: true },
    });
    expect(runtime.hooks.get("input")!({}, ctx)).toEqual({
      action: "continue",
    });
    expect(runtime.pi.getActiveTools()).toContain("agent_browser");
  });

  test("keeps an explicit command authoritative before the first input", async () => {
    const runtime = registerRuntime();
    const ctx = { ui: { notify() {} }, sessionManager: runtime.sessionManager };
    runtime.hooks.get("session_start")!({ reason: "resume" }, ctx);

    await runtime.commands.get("browser-tools")!.handler("on", ctx);
    expect(runtime.hooks.get("input")!({}, ctx)).toEqual({
      action: "continue",
    });
    expect(runtime.pi.getActiveTools()).toContain("agent_browser");

    await runtime.commands.get("browser-tools")!.handler("off", ctx);
    expect(runtime.hooks.get("before_agent_start")!({}, ctx)).toBeUndefined();
    expect(runtime.pi.getActiveTools()).toEqual(["read"]);
  });

  test("reconciles the policy before input and agent start", async () => {
    const runtime = registerRuntime();
    const ctx = { ui: { notify() {} }, sessionManager: runtime.sessionManager };
    runtime.hooks.get("session_start")!({ reason: "startup" }, ctx);
    await runtime.commands.get("browser-tools")!.handler("on", ctx);

    expect(runtime.hooks.get("input")!({}, ctx)).toEqual({
      action: "continue",
    });
    expect(runtime.hooks.get("before_agent_start")!({}, ctx)).toBeUndefined();
    expect(runtime.pi.getActiveTools()).toEqual(["read", "agent_browser"]);
  });

  test("contributes a row-2 footer widget without a footer icon field", () => {
    const runtime = registerRuntime();
    const ctx = { ui: { notify() {} }, sessionManager: runtime.sessionManager };
    runtime.hooks.get("session_start")!({ reason: "startup" }, ctx);

    expect(widgetState.def?.id).toBe("browser-tools");
    expect(widgetState.def?.label).toBe("Browser Tools");
    expect(widgetState.def?.row).toBe(2);
    expect(widgetState.def?.order).toBe(3);
    expect(widgetState.def?.align).toBe("left");
    expect(widgetState.def?.styled).toBe(true);
    // The emoji lives in the rendered label; a second footer icon would double it.
    expect(widgetState.def?.icon).toBeUndefined();
    expect(renderWidget()).toBe("fg:dim:🌐 browser: fg:dim:hidden");
  });

  test("shows the manual grant in the widget and pushes fallback text", async () => {
    const runtime = registerRuntime();
    const themed = {
      hasUI: true,
      ui: { notify() {}, theme: fakeTheme() },
      sessionManager: runtime.sessionManager,
    };
    runtime.hooks.get("session_start")!({ reason: "startup" }, themed);
    widgetState.updates = [];

    await runtime.commands.get("browser-tools")!.handler("on", themed);
    expect(renderWidget()).toBe("fg:dim:🌐 browser: fg:success:manual");
    expect(widgetState.updates.at(-1)).toBe(
      "fg:dim:🌐 browser: fg:success:manual",
    );

    await runtime.commands.get("browser-tools")!.handler("off", themed);
    expect(renderWidget()).toBe("fg:dim:🌐 browser: fg:dim:hidden");

    // A ctx without a theme still receives plain fallback text.
    const plain = { ui: { notify() {} }, sessionManager: runtime.sessionManager };
    await runtime.commands.get("browser-tools")!.handler("on", plain);
    expect(widgetState.updates.at(-1)).toBe("🌐 browser: manual");
  });

  test("renders the restricted and unavailable states and removes the widget on shutdown", async () => {
    const restricted = registerRuntime({ requested: ["read"] });
    const ctx = { ui: { notify() {} }, sessionManager: restricted.sessionManager };
    restricted.hooks.get("session_start")!({ reason: "startup" }, ctx);
    await restricted.commands.get("browser-tools")!.handler("on", ctx);
    expect(renderWidget()).toBe(
      "fg:dim:🌐 browser: fg:warning:manual (restricted)",
    );

    const removedBefore = widgetState.removed;
    restricted.hooks.get("session_shutdown")!({}, ctx);
    expect(widgetState.removed).toBe(removedBefore + 1);

    const unavailable = registerRuntime({ nativeOrder: "absent" });
    unavailable.hooks.get("session_start")!(
      { reason: "startup" },
      { ui: { notify() {} }, sessionManager: unavailable.sessionManager },
    );
    expect(renderWidget()).toBe("fg:dim:🌐 browser: fg:error:unavailable");
  });
});
