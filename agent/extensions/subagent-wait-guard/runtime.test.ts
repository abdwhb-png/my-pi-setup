import { afterEach, describe, expect, test } from "bun:test";
import {
	createTestSession,
	says,
	type TestSession,
	when,
} from "@abdwhb-png/pi-test-harness";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFollowUp } from "./guard.ts";

const ACTIVE_SUBAGENT_RUNS_REGISTRY_KEY = "pi-subagents.active-runs.v1";
const GUARD_EXTENSION_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));
const PI_SUBAGENTS_SOURCE_PATH = resolve(
	homedir(),
	"projects/pi-integrations/pi-subagents/src/extension/index.ts",
);

describe("subagent-wait-guard real Pi runtime", () => {
	let session: TestSession | undefined;

	afterEach(async () => {
		if (session) {
			await session.session.extensionRunner.emit({
				type: "session_shutdown",
				reason: "quit",
			});
			session.dispose();
		}
		session = undefined;
		delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(ACTIVE_SUBAGENT_RUNS_REGISTRY_KEY)];
	});

	test("loads by path, replaces the real message, and injects the forced follow-up", async () => {
		const runId = "runtime-probe-run";
		let agentStarts = 0;
		session = await createTestSession({
			extensions: [PI_SUBAGENTS_SOURCE_PATH, GUARD_EXTENSION_PATH],
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("before_agent_start", (_event, ctx) => {
						agentStarts += 1;
						const sessionId =
							ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
						if (agentStarts > 1) {
							pi.events.emit("subagent:async-complete", {
								id: runId,
								runId,
								sessionId,
								agent: "worker",
								success: true,
								summary: "done",
							});
							return;
						}
						pi.events.emit("subagent:async-started", {
							id: runId,
							pid: 1,
							sessionId,
							mode: "single",
							agent: "worker",
							asyncDir: "/tmp/runtime-probe-run",
						});
					});
				},
			],
		});

		await session.run(
			when("Run the guard probe", [says("premature runtime answer")]),
			when(buildFollowUp([runId]), [says("final report incorporated")]),
		);

		const assistantText = session.events.messages
			.filter((message) => message.role === "assistant")
			.flatMap((message) => message.content)
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		expect(assistantText).toContain("[subagent-wait-guard]");
		expect(assistantText).toContain(runId);
		expect(assistantText).not.toContain("premature runtime answer");
		expect(assistantText).toContain("final report incorporated");
	});
});
