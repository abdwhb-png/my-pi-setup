import { afterEach, describe, expect, it } from "bun:test";
import {
	calls,
	createTestSession,
	says,
	type TestSession,
	when,
} from "@abdwhb-png/pi-test-harness";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const PARENT_SESSION_ENV = "PI_SUBAGENT_PARENT_SESSION";
const FANOUT_CHILD_EXTENSION_PATH = resolve(
	fileURLToPath(import.meta.resolve("pi-subagents")),
	"../src/extension/fanout-child.ts",
);
const PI_SUBAGENTS_ENTRY_PATH = fileURLToPath(import.meta.resolve("pi-subagents"));
const MANAGED_GIT_ENTRY_PATH = join(
	homedir(),
	".pi/agent/git/github.com/abdwhb-png/pi-subagents/index.ts",
);

describe("pi-subagents managed fork on the current Pi runtime", () => {
	let testSession: TestSession | undefined;
	let previousParentSessionEnv: string | undefined;

	afterEach(() => {
		testSession?.dispose();
		testSession = undefined;
		if (previousParentSessionEnv === undefined) delete process.env[PARENT_SESSION_ENV];
		else process.env[PARENT_SESSION_ENV] = previousParentSessionEnv;
	});

	it("loads the managed Git fork instead of the historical checkout", () => {
		expect(PI_SUBAGENTS_ENTRY_PATH).toBe(MANAGED_GIT_ENTRY_PATH);
	});

	it("reports a Fleet logical failure as an errored Pi tool result", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-fanout-"));
		const entrypoint = join(root, "fanout-child-entrypoint.ts");
		writeFileSync(
			entrypoint,
			[
				`import register from ${JSON.stringify(FANOUT_CHILD_EXTENSION_PATH)};`,
				"export default (pi) => register(pi, { fanoutChild: true, depth: 1, waitTool: { enabled: true }, fast: false });",
			].join("\n"),
		);

		try {
			testSession = await createTestSession({ extensions: [entrypoint] });

			await testSession.run(
				when("Show the child fleet", [
					calls("subagent", { action: "status", view: "fleet" }),
					says("The child fleet cannot be listed without a run id."),
				]),
			);

			const [result] = testSession.events.toolResultsFor("subagent");
			expect(result?.text).toContain("Child-safe subagent fleet view is unavailable");
			expect(result?.isError).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, { timeout: 15_000 });

	it("keeps successful results successful and emits the settled lifecycle", async () => {
		previousParentSessionEnv = process.env[PARENT_SESSION_ENV];
		let settledEvents = 0;

		testSession = await createTestSession({
			extensions: [PI_SUBAGENTS_ENTRY_PATH],
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						settledEvents += 1;
					});
				},
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

});
