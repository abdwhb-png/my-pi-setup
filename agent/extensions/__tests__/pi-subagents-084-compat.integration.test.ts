import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	calls,
	createMockPi,
	createTestSession,
	says,
	type TestSession,
	when,
} from "@abdwhb-png/pi-test-harness";
import * as piAgentCore from "@earendil-works/pi-agent-core";
import * as piAi from "@earendil-works/pi-ai";
import * as piAiCompat from "@earendil-works/pi-ai/compat";
import * as piAiOauth from "@earendil-works/pi-ai/oauth";
import * as piAiProviders from "@earendil-works/pi-ai/providers/all";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import * as typebox from "typebox";
import * as typeboxCompile from "typebox/compile";
import * as typeboxValue from "typebox/value";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { delimiter, join, resolve } from "node:path";

const CHILD_ENV = "PI_SUBAGENT_CHILD";
const FANOUT_CHILD_ENV = "PI_SUBAGENT_FANOUT_CHILD";
const PARENT_SESSION_ENV = "PI_SUBAGENT_PARENT_SESSION";
const PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";
const FANOUT_CHILD_EXTENSION_PATH = resolve(
	fileURLToPath(import.meta.resolve("pi-subagents")),
	"../src/extension/fanout-child.ts",
);
const PI_SUBAGENTS_ENTRY_PATH = fileURLToPath(import.meta.resolve("pi-subagents"));
const MANAGED_GIT_ENTRY_PATH = join(
	homedir(),
	".pi/agent/git/github.com/abdwhb-png/pi-subagents/index.ts",
);

// Match Pi's extension loader aliases while importing the package through Bun.
// pi-subagents resolves its own runtime dependencies from its locked install.
mock.module("@earendil-works/pi-agent-core", () => piAgentCore);
mock.module("@earendil-works/pi-ai", () => piAi);
mock.module("@earendil-works/pi-ai/compat", () => piAiCompat);
mock.module("@earendil-works/pi-ai/oauth", () => piAiOauth);
mock.module("@earendil-works/pi-ai/providers/all", () => piAiProviders);
mock.module("@earendil-works/pi-coding-agent", () => piCodingAgent);
mock.module("@earendil-works/pi-tui", () => piTui);
mock.module("typebox", () => typebox);
mock.module("typebox/compile", () => typeboxCompile);
mock.module("typebox/value", () => typeboxValue);

describe("pi-subagents 0.53 on Pi 0.84", () => {
	let testSession: TestSession | undefined;
	let mockPi: ReturnType<typeof createMockPi> | undefined;
	let previousChildEnv: string | undefined;
	let previousFanoutChildEnv: string | undefined;
	let previousParentSessionEnv: string | undefined;
	let previousPiBinaryEnv: string | undefined;

	afterEach(() => {
		testSession?.dispose();
		testSession = undefined;
		mockPi?.uninstall();
		mockPi = undefined;
		if (previousChildEnv === undefined) delete process.env[CHILD_ENV];
		else process.env[CHILD_ENV] = previousChildEnv;
		if (previousFanoutChildEnv === undefined) delete process.env[FANOUT_CHILD_ENV];
		else process.env[FANOUT_CHILD_ENV] = previousFanoutChildEnv;
		if (previousParentSessionEnv === undefined) delete process.env[PARENT_SESSION_ENV];
		else process.env[PARENT_SESSION_ENV] = previousParentSessionEnv;
		if (previousPiBinaryEnv === undefined) delete process.env[PI_BINARY_ENV];
		else process.env[PI_BINARY_ENV] = previousPiBinaryEnv;
	});

	it("loads the managed Git fork instead of the historical checkout", () => {
		expect(PI_SUBAGENTS_ENTRY_PATH).toBe(MANAGED_GIT_ENTRY_PATH);
	});

	it("reports a Fleet logical failure as an errored Pi tool result", async () => {
		previousChildEnv = process.env[CHILD_ENV];
		previousFanoutChildEnv = process.env[FANOUT_CHILD_ENV];
		process.env[CHILD_ENV] = "1";
		process.env[FANOUT_CHILD_ENV] = "1";
		const { default: registerFanoutChildSubagentExtension } = await import(
			FANOUT_CHILD_EXTENSION_PATH,
		);

		testSession = await createTestSession({
			extensionFactories: [
				(pi) => registerFanoutChildSubagentExtension(pi),
			],
		});

		await testSession.run(
			when("Show the child fleet", [
				calls("subagent", { action: "status", view: "fleet" }),
				says("The child fleet cannot be listed without a run id."),
			]),
		);

		const [result] = testSession.events.toolResultsFor("subagent");
		expect(result?.text).toContain("Child-safe subagent fleet view is unavailable");
		expect(result?.isError).toBe(true);
	}, { timeout: 15_000 });

	it("keeps successful results successful and emits the settled lifecycle", async () => {
		previousParentSessionEnv = process.env[PARENT_SESSION_ENV];
		const { default: registerSubagentExtension } = await import(
			"pi-subagents",
		);
		let settledEvents = 0;

		testSession = await createTestSession({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						settledEvents += 1;
					});
				},
				(pi) => registerSubagentExtension(pi),
			],
		});

		await testSession.run(
			when("Show active subagents", [
				calls("subagent", { action: "status" }),
				says("There are no active subagents."),
			]),
		);

		const [result] = testSession.events.toolResultsFor("subagent");
		expect(result).toMatchObject({ isError: false });
		expect(settledEvents).toBe(1);
	}, { timeout: 15_000 });

	it("runs a foreground fanout through real Pi tool wiring", async () => {
		mockPi = createMockPi();
		mockPi.onCall({ output: "fanout-child-ok" });
		mockPi.install();
		previousPiBinaryEnv = process.env[PI_BINARY_ENV];
		process.env[PI_BINARY_ENV] = join(
			process.env.PATH?.split(delimiter)[0] ?? "",
			process.platform === "win32" ? "pi.cmd" : "pi",
		);
		const { default: registerSubagentExtension } = await import("pi-subagents");

		testSession = await createTestSession({
			extensionFactories: [(pi) => registerSubagentExtension(pi)],
		});

		await testSession.run(
			when("Run two children", [
				calls("subagent", {
					workflowScript: `return runs.all([
						{ key: "first", agent: "worker", model: "openai/gpt-4o", task: "first child" },
						{ key: "second", agent: "worker", model: "openai/gpt-4o", task: "second child" },
					]);`,
					async: false,
				}),
				says("Both children completed."),
			]),
		);

		const [result] = testSession.events.toolResultsFor("subagent");
		expect(result).toMatchObject({ isError: false });
		expect(result?.text).toContain("fanout-child-ok");
		expect(mockPi.callCount()).toBe(2);
	}, { timeout: 30_000 });

	it("runs workflowScript through real Pi tool wiring", async () => {
		mockPi = createMockPi();
		mockPi.onCall({ output: "workflow-child-ok" });
		mockPi.install();
		previousPiBinaryEnv = process.env[PI_BINARY_ENV];
		process.env[PI_BINARY_ENV] = join(
			process.env.PATH?.split(delimiter)[0] ?? "",
			process.platform === "win32" ? "pi.cmd" : "pi",
		);
		const { default: registerSubagentExtension } = await import("pi-subagents");

		testSession = await createTestSession({
			extensionFactories: [(pi) => registerSubagentExtension(pi)],
		});

		await testSession.run(
			when("Run a workflow", [
				calls("subagent", {
					workflowScript:
						'return runs.run("workflow", { agent: "worker", model: "openai/gpt-4o", task: "workflow child" });',
					async: false,
				}),
				says("The workflow completed."),
			]),
		);

		const [result] = testSession.events.toolResultsFor("subagent");
		expect(result).toMatchObject({ isError: false });
		expect(result?.text).toContain("workflow-child-ok");
		expect(mockPi.callCount()).toBe(1);
	}, { timeout: 30_000 });
});
