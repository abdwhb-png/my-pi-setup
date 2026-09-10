import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  TestHooks,
  mountPolicy,
  trackPolicyCleanup,
} from "../__tests__/policy-fixture.ts";
import { getToolPolicy } from "../_shared/tool-policy/index.ts";

let upstreamAvailable = true;
let upstreamCalls = 0;

mock.module(
  "pi-agent-browser-native/dist/extensions/agent-browser/index.js",
  () => ({
    default(pi: { registerTool(definition: { name: string }): void }) {
      upstreamCalls += 1;
      if (!upstreamAvailable) return;
      pi.registerTool({ name: "agent_browser" });
      pi.registerTool({ name: "agent_browser_web_search" });
    },
  }),
);

const { default: browserToolsExtension } = await import("./index.ts");

function registerRuntime(options: {
  requested?: string[];
  childAllowed?: string[];
} = {}) {
  const tools = new Map<string, { name: string }>();
  const commands = new Map<string, { handler: Function }>();
  const hooks = new TestHooks();
  const eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  let activeTools = ["read"];
  const pi = {
    registerTool(definition: { name: string }) {
      tools.set(definition.name, definition);
      if (!activeTools.includes(definition.name)) activeTools.push(definition.name);
    },
    registerCommand(name: string, definition: { handler: Function }) {
      commands.set(name, definition);
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
  return { commands, hooks, pi, tools };
}

beforeEach(() => {
  upstreamAvailable = true;
  upstreamCalls = 0;
});

describe("browser-tools", () => {
  test("loads the native extension but hides its tools until the user grants access", async () => {
    const runtime = registerRuntime();
    const notices: Array<[string, string | undefined]> = [];
    const ctx = {
      ui: {
        notify(message: string, level?: string) {
          notices.push([message, level]);
        },
      },
    };

    runtime.hooks.get("session_start")!({ reason: "startup" }, ctx);
    expect(upstreamCalls).toBe(1);
    expect(runtime.pi.getActiveTools()).toEqual(["read"]);

    await runtime.commands.get("browser-tools")!.handler("on", ctx);
    expect(runtime.pi.getActiveTools()).toEqual(["read", "agent_browser"]);
    expect(notices.at(-1)).toEqual(["Browser tools: manual", "info"]);
  });

  test("revokes access and blocks stale calls without stopping upstream ownership", async () => {
    const runtime = registerRuntime();
    const ctx = { ui: { notify() {} } };
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
    const ctx = { ui: { notify() {} } };
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
    const ctx = {
      ui: {
        notify(message: string, level?: string) {
          notices.push([message, level]);
        },
      },
    };
    const restricted = registerRuntime({ requested: ["read"] });
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
    upstreamAvailable = false;
    const unavailable = registerRuntime();
    unavailable.hooks.get("session_start")!({ reason: "startup" }, ctx);
    await unavailable.commands.get("browser-tools")!.handler("on", ctx);
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
    const ctx = { ui: { notify() {} } };
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

  test("clears the manual grant on reload, resume, and shutdown", async () => {
    const runtime = registerRuntime();
    const ctx = { ui: { notify() {} } };
    runtime.hooks.get("session_start")!({ reason: "startup" }, ctx);

    for (const reason of ["reload", "resume"] as const) {
      await runtime.commands.get("browser-tools")!.handler("on", ctx);
      expect(runtime.pi.getActiveTools()).toContain("agent_browser");
      runtime.hooks.get("session_start")!({ reason }, ctx);
      expect(runtime.pi.getActiveTools()).toEqual(["read"]);
    }

    await runtime.commands.get("browser-tools")!.handler("on", ctx);
    runtime.hooks.get("session_shutdown")!({}, ctx);
    expect(
      runtime.hooks.get("tool_call")!({ toolName: "agent_browser" }, ctx),
    ).toEqual({
      block: true,
      reason: "Agent Browser is hidden. Ask the user to run /browser-tools on.",
    });
  });

  test("reconciles the policy before input and agent start", async () => {
    const runtime = registerRuntime();
    const ctx = { ui: { notify() {} } };
    runtime.hooks.get("session_start")!({ reason: "startup" }, ctx);
    await runtime.commands.get("browser-tools")!.handler("on", ctx);

    expect(runtime.hooks.get("input")!({}, ctx)).toEqual({
      action: "continue",
    });
    expect(runtime.hooks.get("before_agent_start")!({}, ctx)).toBeUndefined();
    expect(runtime.pi.getActiveTools()).toEqual(["read", "agent_browser"]);
  });
});
