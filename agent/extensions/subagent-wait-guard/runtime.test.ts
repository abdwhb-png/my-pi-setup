import { afterEach, describe, expect, test } from "bun:test";
import {
	calls,
	createTestSession,
	says,
	type TestSession,
	when,
} from "@abdwhb-png/pi-test-harness";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFollowUp, SUBAGENT_PROGRESS_MARKER } from "./guard.ts";

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

	test("headless runtime replaces the real message, waits once, and allows the settled answer", async () => {
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

	test("real subagent status result authorizes one marked progress update", async () => {
		const runId = "runtime-progress-run";
		session = await createTestSession({
			extensions: [PI_SUBAGENTS_SOURCE_PATH, GUARD_EXTENSION_PATH],
			extensionFactories: [
				(pi: ExtensionAPI) => {
					let started = false;
					pi.on("before_agent_start", (_event, ctx) => {
						if (started) return;
						started = true;
						const sessionId =
							ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
						pi.events.emit("subagent:async-started", {
							id: runId,
							pid: 1,
							sessionId,
							mode: "single",
							agent: "worker",
							asyncDir: "/tmp/runtime-progress-run",
						});
					});
				},
			],
		});

		await session.run(
			when("Report active child progress", [
				calls("subagent", { action: "status" }),
				says(`${SUBAGENT_PROGRESS_MARKER} Child still running.`),
			]),
		);

		const assistantText = session.events.messages
			.filter((message) => message.role === "assistant")
			.flatMap((message) => message.content)
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		expect(session.events.toolResultsFor("subagent")[0]?.isError).toBe(false);
		expect(assistantText).toContain("Child still running.");
		expect(assistantText).not.toContain(SUBAGENT_PROGRESS_MARKER);
		expect(assistantText).not.toContain("[subagent-wait-guard] Answer deferred");
	});

	test("headless runtime does not create another follow-up for the same active snapshot", async () => {
		const runId = "runtime-stuck-run";
		let started = false;
		session = await createTestSession({
			extensions: [PI_SUBAGENTS_SOURCE_PATH, GUARD_EXTENSION_PATH],
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("before_agent_start", (_event, ctx) => {
						if (started) return;
						started = true;
						const sessionId =
							ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
						pi.events.emit("subagent:async-started", {
							id: runId,
							pid: 1,
							sessionId,
							mode: "single",
							agent: "worker",
							asyncDir: "/tmp/runtime-stuck-run",
						});
					});
				},
			],
		});

		const forcedFollowUp = buildFollowUp([runId]);
		await session.run(
			when("Run the stuck guard probe", [says("first premature runtime answer")]),
			when(forcedFollowUp, [says("second premature runtime answer")]),
		);

		const guardMessages = session.events.messages
			.filter((message) => message.role === "assistant")
			.flatMap((message) => message.content)
			.filter(
				(part) =>
					part.type === "text" && part.text.includes("[subagent-wait-guard]"),
			);
		const forcedFollowUps = session.events.messages.filter(
			(message) =>
				message.role === "user" &&
				JSON.stringify(message.content).includes("standalone `subagent_wait` tool"),
		);
		expect(guardMessages).toHaveLength(2);
		expect(forcedFollowUps).toHaveLength(1);
		expect(JSON.stringify(session.events.messages)).not.toContain(
			"second premature runtime answer",
		);
	});
});
