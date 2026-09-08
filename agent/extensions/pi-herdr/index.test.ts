import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import herdrExtension from "./index";

const currentPane = {
	pane_id: "w1:p1",
	workspace_id: "w1",
	tab_id: "w1:t1",
	focused: false,
	cwd: "/repo",
	foreground_cwd: "/repo",
	agent: "pi",
	agent_status: "working",
};

const reviewer = {
	name: "reviewer",
	agent: "codex",
	display_agent: "Codex",
	agent_status: "idle",
	workspace_id: "w1",
	tab_id: "w1:t1",
	pane_id: "w1:p2",
	focused: false,
	cwd: "/repo",
};

function response(result: unknown, stdout?: string) {
	return {
		stdout: stdout ?? JSON.stringify({ id: "test", result }),
		stderr: "",
		code: 0,
		killed: false,
	};
}

type ExecResponse = ReturnType<typeof response>;

function isExecResponse(value: unknown): value is ExecResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		"stdout" in value &&
		"stderr" in value &&
		"code" in value &&
		"killed" in value
	);
}

function registerRuntime(
	handler: (args: string[]) => unknown | string | ExecResponse,
) {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, any>();
	const eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
	let activeTools = ["read"];
	const pi = {
		registerTool(definition: any) {
			tools.set(definition.name, definition);
			if (!activeTools.includes(definition.name)) activeTools.push(definition.name);
		},
		registerCommand(name: string, definition: any) {
			commands.set(name, definition);
		},
		on(event: string, handler: any) {
			handlers.set(event, handler);
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
		getActiveTools: () => [...activeTools],
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
		async exec(command: string, args: string[]) {
			expect(command).toBe("herdr");
			const result = handler(args);
			if (isExecResponse(result)) return result;
			return typeof result === "string" ? response(undefined, result) : response(result);
		},
	};
	herdrExtension(pi as any);
	return { tools, commands, handlers, pi };
}

function registerTools(
	handler: (args: string[]) => unknown | string | ExecResponse,
) {
	return registerRuntime(handler).tools;
}

beforeEach(() => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = currentPane.pane_id;
});

afterEach(() => {
	delete process.env.HERDR_ENV;
	delete process.env.HERDR_PANE_ID;
});

describe("pi-herdr", () => {
	test("registers only inside Herdr", () => {
		delete process.env.HERDR_ENV;
		const runtime = registerRuntime(() => ({}));
		expect(runtime.tools.size).toBe(0);
		expect(runtime.commands.size).toBe(0);
	});

	test("lets the user activate and deactivate Herdr tools for the current session", async () => {
		const runtime = registerRuntime(() => ({}));
		const notices: Array<[string, string | undefined]> = [];
		const ctx = {
			ui: {
				notify(message: string, level?: string) {
					notices.push([message, level]);
				},
			},
		};

		runtime.handlers.get("session_start")({ reason: "startup" }, ctx);
		expect(runtime.pi.getActiveTools()).toEqual(["read"]);

		await runtime.commands.get("herdr-tools").handler("on", ctx);
		expect(runtime.pi.getActiveTools()).toEqual([
			"read",
			"herdr_layout",
			"herdr_pane",
			"herdr_agent",
		]);
		expect(notices.at(-1)?.[0]).toContain("manual");

		await runtime.commands.get("herdr-tools").handler("off", ctx);
		expect(runtime.pi.getActiveTools()).toEqual(["read"]);
		expect(
			runtime.handlers.get("tool_call")({ toolName: "herdr_pane" }, ctx),
		).toEqual({
			block: true,
			reason: "Herdr tools are hidden. Use /herdr-tools on or switch to herdr-orchestrator.",
		});
	});

	test("activates for herdr-orchestrator and keeps role and manual grants independent", async () => {
		const runtime = registerRuntime(() => ({}));
		const ctx = { ui: { notify() {} } };
		const herdrPolicy = {
			version: 1,
			roleName: "herdr-orchestrator",
			mode: "set",
			toolNames: ["read", "herdr_layout", "herdr_pane", "herdr_agent"],
		};

		runtime.handlers.get("session_start")({ reason: "startup" }, ctx);
		runtime.pi.events.emit("pi-roles:tool-policy", herdrPolicy);
		expect(runtime.pi.getActiveTools()).toEqual([
			"read",
			"herdr_layout",
			"herdr_pane",
			"herdr_agent",
		]);

		await runtime.commands.get("herdr-tools").handler("on", ctx);
		await runtime.commands.get("herdr-tools").handler("off", ctx);
		expect(runtime.pi.getActiveTools()).toContain("herdr_agent");

		runtime.pi.events.emit("pi-roles:tool-policy", {
			version: 1,
			roleName: "reviewer",
			mode: "set",
			toolNames: ["read"],
		});
		expect(runtime.pi.getActiveTools()).toEqual(["read"]);
	});

	test("clears a manual grant when the session reloads", async () => {
		const runtime = registerRuntime(() => ({}));
		const ctx = { ui: { notify() {} } };

		await runtime.commands.get("herdr-tools").handler("on", ctx);
		expect(runtime.pi.getActiveTools()).toContain("herdr_layout");

		runtime.handlers.get("session_start")({ reason: "reload" }, ctx);
		expect(runtime.pi.getActiveTools()).toEqual(["read"]);
	});

	test("registers separate layout, pane, and agent primitives", () => {
		const tools = registerTools(() => ({}));
		expect([...tools.keys()]).toEqual(["herdr_layout", "herdr_pane", "herdr_agent"]);
		expect(tools.get("herdr_layout").description).toContain("Workspaces contain tabs; tabs contain panes");
		expect(tools.get("herdr_pane").description).toContain("ordinary processes");
		expect(tools.get("herdr_agent").description).toContain("existing Herdr pane");
	});

	test("splits the caller pane from geometry while preserving cwd and focus", async () => {
		const calls: string[][] = [];
		const splitPane = { ...currentPane, pane_id: "w1:p2", agent: undefined, agent_status: "unknown" };
		const tools = registerTools((args) => {
			calls.push(args);
			if (args[0] === "pane" && args[1] === "current") return { type: "pane_current", pane: currentPane };
			if (args[0] === "pane" && args[1] === "layout") {
				return {
					type: "pane_layout",
					layout: {
						workspace_id: "w1",
						tab_id: "w1:t1",
						zoomed: false,
						focused_pane_id: "w1:p1",
						area: { x: 0, y: 0, width: 160, height: 40 },
						panes: [{ pane_id: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 160, height: 40 } }],
						splits: [],
					},
				};
			}
			if (args[0] === "pane" && args[1] === "split") return { type: "pane_info", pane: splitPane };
			throw new Error(`unexpected command: ${args.join(" ")}`);
		});

		const result = await tools.get("herdr_layout").execute(
			"test",
			{ action: "pane_split" },
			undefined,
			undefined,
			{},
		);

		expect(calls).toContainEqual(["pane", "layout", "--pane", "w1:p1"]);
		expect(calls).toContainEqual([
			"pane",
			"split",
			"w1:p1",
			"--direction",
			"right",
			"--cwd",
			"/repo",
			"--no-focus",
		]);
		expect(result.details.pane.pane_id).toBe("w1:p2");
	});

	test("waits for ordinary output through pane wait-output", async () => {
		const calls: string[][] = [];
		const tools = registerTools((args) => {
			calls.push(args);
			return {
				type: "pane_output_matched",
				pane_id: "w1:p2",
				matched_line: "server ready",
				read: { text: "booting\nserver ready\n" },
			};
		});

		const result = await tools.get("herdr_pane").execute(
			"test",
			{ action: "wait_output", pane: "w1:p2", match: "ready", timeout: 30000 },
			undefined,
			undefined,
			{},
		);

		expect(calls).toEqual([["pane", "wait-output", "w1:p2", "--match", "ready", "--timeout", "30000"]]);
		expect(result.content[0].text).toContain("server ready");
	});

	test("accepts empty successful output for pane mutations", async () => {
		const calls: string[][] = [];
		const tools = registerTools((args) => {
			calls.push(args);
			if (args[0] === "pane" && args[1] === "current") {
				return { type: "pane_current", pane: currentPane };
			}
			return "";
		});
		const pane = tools.get("herdr_pane");

		await pane.execute("run", { action: "run", pane: "w1:p2", command: "bun dev" });
		await pane.execute("text", { action: "send_text", pane: "w1:p2", text: "hello" });
		await pane.execute("keys", { action: "send_keys", pane: "w1:p2", keys: ["enter"] });
		await pane.execute("close", { action: "close", pane: "w1:p2" });

		expect(calls).toEqual([
			["pane", "run", "w1:p2", "bun dev"],
			["pane", "send-text", "w1:p2", "hello"],
			["pane", "send-keys", "w1:p2", "enter"],
			["pane", "current", "--current"],
			["pane", "close", "w1:p2"],
		]);
	});

	test("reports non-zero, cancelled, and invalid JSON commands without retrying", async () => {
		let nonZeroCalls = 0;
		const failed = registerTools(() => {
			nonZeroCalls += 1;
			return {
				stdout: "",
				stderr: JSON.stringify({
					error: { code: "pane_busy", message: "pane is busy" },
				}),
				code: 7,
				killed: false,
			};
		});
		await expect(
			failed.get("herdr_pane").execute(
				"failed",
				{ action: "run", pane: "w1:p2", command: "bun dev" },
				undefined,
				undefined,
				{},
			),
		).rejects.toThrow("pane is busy");
		expect(nonZeroCalls).toBe(1);

		const cancelled = registerTools(() => ({
			stdout: "",
			stderr: "",
			code: 0,
			killed: true,
		}));
		await expect(
			cancelled.get("herdr_pane").execute(
				"cancelled",
				{ action: "run", pane: "w1:p2", command: "bun dev" },
				undefined,
				undefined,
				{},
			),
		).rejects.toThrow("Aborted");

		const invalidJson = registerTools(() => "not-json");
		await expect(
			invalidJson.get("herdr_layout").execute(
				"invalid-json",
				{ action: "current" },
				undefined,
				undefined,
				{},
			),
		).rejects.toThrow("Failed to parse JSON");
	});

	test("refuses to close the caller pane", async () => {
		const tools = registerTools((args) => {
			if (args[0] === "pane" && args[1] === "current") return { type: "pane_current", pane: currentPane };
			throw new Error(`unexpected command: ${args.join(" ")}`);
		});

		expect(
			tools.get("herdr_pane").execute(
				"test",
				{ action: "close", pane: "w1:p1" },
				undefined,
				undefined,
				{},
			),
		).rejects.toThrow("Refusing to close");
	});

	test("starts a named agent in an existing pane", async () => {
		const calls: string[][] = [];
		const tools = registerTools((args) => {
			calls.push(args);
			return { type: "agent_started", agent: reviewer, argv: ["codex", "-m", "gpt-5.4"] };
		});

		const result = await tools.get("herdr_agent").execute(
			"test",
			{
				action: "start",
				name: "reviewer",
				kind: "codex",
				pane: "w1:p2",
				agentArgs: ["-m", "gpt-5.4"],
			},
			undefined,
			undefined,
			{},
		);

		expect(calls).toEqual([
			["agent", "start", "reviewer", "--kind", "codex", "--pane", "w1:p2", "--", "-m", "gpt-5.4"],
		]);
		expect(result.details.agent.name).toBe("reviewer");
	});

	test("prompts through the agent surface and waits by default", async () => {
		const calls: string[][] = [];
		const tools = registerTools((args) => {
			calls.push(args);
			return { type: "agent_prompted", agent: { ...reviewer, agent_status: "done" } };
		});

		const result = await tools.get("herdr_agent").execute(
			"test",
			{
				action: "prompt",
				target: "reviewer",
				prompt: "Review the current diff",
				until: ["idle", "done"],
				timeout: 120000,
			},
			undefined,
			undefined,
			{},
		);

		expect(calls).toEqual([
			[
				"agent",
				"prompt",
				"reviewer",
				"Review the current diff",
				"--wait",
				"--until",
				"idle",
				"--until",
				"done",
				"--timeout",
				"120000",
			],
		]);
		expect(result.details.agent.agent_status).toBe("done");
	});

	test("reads through the resolved agent surface", async () => {
		const calls: string[][] = [];
		const tools = registerTools((args) => {
			calls.push(args);
			return "review complete\n";
		});

		const result = await tools.get("herdr_agent").execute(
			"test",
			{ action: "read", target: "reviewer", lines: 120 },
			undefined,
			undefined,
			{},
		);

		expect(calls).toEqual([
			["agent", "read", "reviewer", "--source", "recent-unwrapped", "--lines", "120"],
		]);
		expect(result.content[0].text).toBe("review complete\n");
	});

	test("sends validated keys without expecting agent data in the response", async () => {
		const calls: string[][] = [];
		const tools = registerTools((args) => {
			calls.push(args);
			return "";
		});

		const result = await tools.get("herdr_agent").execute(
			"test",
			{ action: "send_keys", target: "reviewer", keys: ["esc", "ctrl+c"] },
			undefined,
			undefined,
			{},
		);

		expect(calls).toEqual([["agent", "send-keys", "reviewer", "esc", "ctrl+c"]]);
		expect(result.content[0].text).toBe("Sent esc ctrl+c to reviewer");
	});
});
