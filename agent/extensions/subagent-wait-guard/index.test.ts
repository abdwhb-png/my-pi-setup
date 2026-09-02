import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_PROGRESS_MARKER } from "./guard.ts";
import register from "./index.ts";

type Handler = (event: any, ctx: any) => any;
interface ActiveSubagentRun {
	id: string;
	sessionId: string;
	status?: "queued" | "running" | "paused";
}

const ACTIVE_SUBAGENT_RUNS_REGISTRY_KEY = "pi-subagents.active-runs.v1";
const handlers = new Map<string, Handler>();
const sentCustomMessages: Array<{
	message: { customType: string; content: string; display: boolean };
	options?: unknown;
}> = [];
const sentUserMessages: Array<{ content: string; options?: unknown }> = [];
const sessionContexts = new Map<string, ReturnType<typeof makeCtx>>();
let activeRuns: ActiveSubagentRun[] = [];

afterEach(() => {
	for (const ctx of sessionContexts.values()) {
		handlers.get("session_shutdown")?.({}, ctx);
	}
	sessionContexts.clear();
	handlers.clear();
	sentCustomMessages.length = 0;
	sentUserMessages.length = 0;
	activeRuns = [];
	delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(ACTIVE_SUBAGENT_RUNS_REGISTRY_KEY)];
});

function makePi() {
	const eventSubscribers = new Map<string, number>();
	return {
		pi: {
			on(event: string, handler: Handler) {
				handlers.set(event, handler);
			},
			sendMessage: (
				message: { customType: string; content: string; display: boolean },
				options?: unknown,
			) => {
				sentCustomMessages.push({ message, options });
			},
			sendUserMessage: (content: string, options?: unknown) => {
				sentUserMessages.push({ content, options });
			},
			events: {
				on(channel: string) {
					eventSubscribers.set(channel, (eventSubscribers.get(channel) ?? 0) + 1);
					return () => eventSubscribers.set(channel, (eventSubscribers.get(channel) ?? 1) - 1);
				},
			},
		},
		subscribers(channel: string) {
			return eventSubscribers.get(channel) ?? 0;
		},
	};
}

function registerRuntime(runtime: ReturnType<typeof makePi>): void {
	(globalThis as Record<PropertyKey, unknown>)[Symbol.for(ACTIVE_SUBAGENT_RUNS_REGISTRY_KEY)] = {
		version: 1,
		sources: new Map([
			[
				"guard-test",
				{
					name: "guard-test",
					listActiveRuns: () => activeRuns,
				},
			],
		]),
	};
	// Partial ExtensionAPI test double: only the guard's runtime boundary is needed.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	register(runtime.pi as unknown as ExtensionAPI);
}

function makeCtx(sessionId: string, sessionFile?: string, hasUI = false) {
	const ctx = {
		hasUI,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFile,
		},
	};
	sessionContexts.set(sessionFile ?? sessionId, ctx);
	return ctx;
}

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistantText = {
	role: "assistant",
	content: [{ type: "text", text: "premature final direction" }],
	api: "openai-completions",
	provider: "openai",
	model: "test-model",
	usage,
	stopReason: "stop",
	timestamp: Date.now(),
} as const;

function assistantMessage(text: string) {
	return {
		...structuredClone(assistantText),
		content: [{ type: "text", text }],
	};
}

function toolResult(toolName: string, isError = false) {
	return {
		type: "tool_result",
		toolCallId: "tool-call-1",
		toolName,
		input: {},
		content: [{ type: "text", text: isError ? "failed" : "ok" }],
		isError,
	};
}

describe("subagent-wait-guard entry", () => {
	test("registers Pi handlers without lifecycle event subscriptions", () => {
		const runtime = makePi();
		registerRuntime(runtime);

		expect([...handlers.keys()].sort()).toEqual([
			"before_agent_start",
			"message_end",
			"session_shutdown",
			"tool_result",
			"turn_end",
		]);
		expect(runtime.subscribers("subagent:async-started")).toBe(0);
		expect(runtime.subscribers("subagent:async-complete")).toBe(0);
	});

	test("injects the explicit progress protocol and current run identities before each agent run", () => {
		const runtime = makePi();
		registerRuntime(runtime);
		activeRuns = [{ id: "run-prompt", sessionId: "sess-prompt", status: "running" }];

		const result = handlers.get("before_agent_start")!(
			{ prompt: "continue", systemPrompt: "Base prompt." },
			makeCtx("sess-prompt"),
		);

		expect(result.systemPrompt).toContain("Base prompt.");
		expect(result.systemPrompt).toContain(SUBAGENT_PROGRESS_MARKER);
		expect(result.systemPrompt).toContain("never use it for a final answer");
		expect(result.systemPrompt).toContain("run-prompt");
		expect(result.systemPrompt).toContain("Return only progress while these runs remain active");
	});

	test("headless mode replaces premature prose and sends its wait reminder through a hidden custom message", () => {
		const runtime = makePi();
		registerRuntime(runtime);
		activeRuns = [{ id: "run-1", sessionId: "sess-1" }];
		const ctx = makeCtx("sess-1");

		const result = handlers.get("message_end")!({ message: structuredClone(assistantText) }, ctx);
		expect(result?.message?.role).toBe("assistant");
		expect(JSON.stringify(result?.message?.content)).toContain("run-1");
		expect(JSON.stringify(result?.message?.content)).not.toContain("premature final direction");

		handlers.get("turn_end")!({ turnIndex: 0, message: {}, toolResults: [] }, ctx);
		expect(sentCustomMessages).toEqual([
			{
				message: {
					customType: "subagent-wait-guard-reminder",
					content: expect.stringContaining("run-1"),
					display: false,
				},
				options: { deliverAs: "followUp" },
			},
		]);
		expect(sentUserMessages).toHaveLength(0);
	});

	test("preserves every marked interactive progress update after stripping its marker", () => {
		const runtime = makePi();
		registerRuntime(runtime);
		activeRuns = [{ id: "run-progress", sessionId: "sess-progress", status: "running" }];
		const ctx = makeCtx("sess-progress", undefined, true);
		const messageEnd = handlers.get("message_end")!;

		handlers.get("tool_result")!(toolResult("subagent"), ctx);
		const progress = messageEnd(
			{ message: assistantMessage(`${SUBAGENT_PROGRESS_MARKER} Child still reviewing.`) },
			ctx,
		);

		expect(progress?.message?.content).toEqual([{ type: "text", text: "Child still reviewing." }]);
		expect(JSON.stringify(progress?.message?.content)).not.toContain(SUBAGENT_PROGRESS_MARKER);

		const repeated = messageEnd(
			{ message: assistantMessage(`${SUBAGENT_PROGRESS_MARKER} Repeated progress.`) },
			ctx,
		);
		expect(repeated?.message?.content).toEqual([{ type: "text", text: "Repeated progress." }]);
		expect(JSON.stringify(repeated?.message?.content)).not.toContain(SUBAGENT_PROGRESS_MARKER);
	});

	test("preserves marked interactive updates after failed or unrelated tool results", () => {
		const runtime = makePi();
		registerRuntime(runtime);
		activeRuns = [{ id: "run-progress", sessionId: "sess-progress", status: "running" }];
		const ctx = makeCtx("sess-progress", undefined, true);
		const messageEnd = handlers.get("message_end")!;

		handlers.get("tool_result")!(toolResult("subagent", true), ctx);
		const failed = messageEnd(
			{ message: assistantMessage(`${SUBAGENT_PROGRESS_MARKER} Failed result.`) },
			ctx,
		);
		expect(failed?.message?.content).toEqual([{ type: "text", text: "Failed result." }]);

		handlers.get("tool_result")!(toolResult("safe_bash"), ctx);
		const unrelated = messageEnd(
			{ message: assistantMessage(`${SUBAGENT_PROGRESS_MARKER} Unrelated result.`) },
			ctx,
		);
		expect(unrelated?.message?.content).toEqual([{ type: "text", text: "Unrelated result." }]);
	});

	test("preserves unmarked interactive prose and strips a later marked update", () => {
		const runtime = makePi();
		registerRuntime(runtime);
		activeRuns = [{ id: "run-progress", sessionId: "sess-progress", status: "running" }];
		const ctx = makeCtx("sess-progress", undefined, true);
		const messageEnd = handlers.get("message_end")!;

		handlers.get("tool_result")!(toolResult("subagent_wait"), ctx);
		const unmarked = messageEnd({ message: assistantMessage("Unmarked final answer.") }, ctx);
		expect(unmarked).toBeUndefined();

		const marked = messageEnd(
			{ message: assistantMessage(`${SUBAGENT_PROGRESS_MARKER} Later update.`) },
			ctx,
		);
		expect(marked?.message?.content).toEqual([{ type: "text", text: "Later update." }]);
	});

	test("preserves a marked interactive update when the active snapshot changes", () => {
		const runtime = makePi();
		registerRuntime(runtime);
		activeRuns = [{ id: "run-a", sessionId: "sess-change", status: "running" }];
		const ctx = makeCtx("sess-change", undefined, true);

		handlers.get("tool_result")!(toolResult("subagent"), ctx);
		activeRuns = [
			{ id: "run-a", sessionId: "sess-change", status: "running" },
			{ id: "run-b", sessionId: "sess-change", status: "queued" },
		];
		const result = handlers.get("message_end")!(
			{ message: assistantMessage(`${SUBAGENT_PROGRESS_MARKER} Stale snapshot.`) },
			ctx,
		);

		expect(result?.message?.content).toEqual([{ type: "text", text: "Stale snapshot." }]);
		expect(JSON.stringify(result?.message?.content)).not.toContain(SUBAGENT_PROGRESS_MARKER);
	});

	test("permits one explicit attention update when a run becomes paused", () => {
		const runtime = makePi();
		registerRuntime(runtime);
		activeRuns = [{ id: "run-paused", sessionId: "sess-attention", status: "running" }];
		const ctx = makeCtx("sess-attention", undefined, true);
		const messageEnd = handlers.get("message_end")!;
		messageEnd({ message: assistantMessage("Still running.") }, ctx);
		activeRuns = [{ id: "run-paused", sessionId: "sess-attention", status: "paused" }];

		const attention = messageEnd(
			{ message: assistantMessage(`${SUBAGENT_PROGRESS_MARKER} Child needs clarification.`) },
			ctx,
		);
		expect(attention?.message?.content).toEqual([
			{ type: "text", text: "Child needs clarification." },
		]);

		const repeated = messageEnd(
			{ message: assistantMessage(`${SUBAGENT_PROGRESS_MARKER} Repeated attention.`) },
			ctx,
		);
		expect(repeated?.message?.content).toEqual([
			{ type: "text", text: "Repeated attention." },
		]);
	});

	test("becomes inert and resets enforcement when the source has no active runs", () => {
		const runtime = makePi();
		registerRuntime(runtime);
		const ctx = makeCtx("sess-1");
		activeRuns = [{ id: "run-1", sessionId: "sess-1" }];
		handlers.get("message_end")!({ message: structuredClone(assistantText) }, ctx);
		activeRuns = [];

		expect(handlers.get("message_end")!({ message: structuredClone(assistantText) }, ctx)).toBeUndefined();
		handlers.get("turn_end")!({ turnIndex: 0, message: {}, toolResults: [] }, ctx);
		expect(sentUserMessages).toHaveLength(0);
	});

	test("scopes snapshots to the exact current session", () => {
		const runtime = makePi();
		registerRuntime(runtime);
		activeRuns = [{ id: "run-other", sessionId: "other-session" }];
		const ctx = makeCtx("sess-1");

		expect(handlers.get("message_end")!({ message: structuredClone(assistantText) }, ctx)).toBeUndefined();
		expect(sentUserMessages).toHaveLength(0);
	});

	test("matches pi-subagents identity through the session file", () => {
		const runtime = makePi();
		registerRuntime(runtime);
		const sessionFile = "/sessions/2026-08-24_uuid.jsonl";
		activeRuns = [{ id: "run-file", sessionId: sessionFile }];

		const result = handlers.get("message_end")!(
			{ message: structuredClone(assistantText) },
			makeCtx("uuid", sessionFile),
		);
		expect(JSON.stringify(result?.message?.content)).toContain("run-file");
	});

	test("ignores non-final messages without queueing a follow-up", () => {
		const runtime = makePi();
		registerRuntime(runtime);
		activeRuns = [{ id: "run-1", sessionId: "sess-1" }];
		const ctx = makeCtx("sess-1");
		const toolCallMessage = {
			...structuredClone(assistantText),
			content: [
				{ type: "text", text: "waiting" },
				{ type: "toolCall", id: "t", name: "subagent_wait", arguments: {} },
			],
			stopReason: "toolUse",
		};

		expect(handlers.get("message_end")!({ message: toolCallMessage }, ctx)).toBeUndefined();
		expect(
			handlers.get("message_end")!({ message: { role: "user", content: [{ type: "text", text: "hi" }] } }, ctx),
		).toBeUndefined();
		handlers.get("turn_end")!({ turnIndex: 0, message: {}, toolResults: [] }, ctx);
		expect(sentUserMessages).toHaveLength(0);
	});

	test("queues one follow-up after withholding a final answer", () => {
		const runtime = makePi();
		registerRuntime(runtime);
		activeRuns = [{ id: "run-1", sessionId: "sess-1" }];
		const ctx = makeCtx("sess-1");

		handlers.get("message_end")!({ message: structuredClone(assistantText) }, ctx);
		handlers.get("turn_end")!({ turnIndex: 0, message: {}, toolResults: [] }, ctx);
		handlers.get("turn_end")!({ turnIndex: 1, message: {}, toolResults: [] }, ctx);

		expect(sentCustomMessages).toHaveLength(1);
		expect(sentUserMessages).toHaveLength(0);
	});

	test("interactive TUI preserves parent text and thinking, then records one hidden reminder", () => {
		const runtime = makePi();
		registerRuntime(runtime);
		activeRuns = [{ id: "run-ui", sessionId: "sess-ui", status: "running" }];
		const ctx = makeCtx("sess-ui", undefined, true);
		const original = {
			...structuredClone(assistantText),
			content: [
				{ type: "thinking", thinking: "Visible planning notes", thinkingSignature: "signature" },
				{ type: "text", text: "Parent progress remains visible." },
			],
		};

		const result = handlers.get("message_end")!({ message: original }, ctx);
		expect(result).toBeUndefined();
		expect(original.content).toEqual([
			{ type: "thinking", thinking: "Visible planning notes", thinkingSignature: "signature" },
			{ type: "text", text: "Parent progress remains visible." },
		]);

		handlers.get("turn_end")!({ turnIndex: 0, message: original, toolResults: [] }, ctx);
		expect(sentCustomMessages).toEqual([
			{
				message: {
					customType: "subagent-wait-guard-reminder",
					content: expect.stringContaining("run-ui"),
					display: false,
				},
				options: { triggerTurn: false },
			},
		]);
		expect(sentCustomMessages[0]?.message.content).toContain("Pi will wake this session");
		expect(sentCustomMessages[0]?.message.content).not.toContain("subagent_wait");
		expect(sentUserMessages).toHaveLength(0);
	});

	test("interactive paused run preserves parent output and records one hidden attention reminder", () => {
		const runtime = makePi();
		registerRuntime(runtime);
		activeRuns = [{ id: "run-paused-ui", sessionId: "sess-paused-ui", status: "paused" }];
		const ctx = makeCtx("sess-paused-ui", undefined, true);

		const result = handlers.get("message_end")!(
			{ message: assistantMessage("Parent asks for clarification.") },
			ctx,
		);
		expect(result).toBeUndefined();
		handlers.get("turn_end")!({ turnIndex: 0, message: {}, toolResults: [] }, ctx);

		expect(sentCustomMessages).toHaveLength(1);
		expect(sentCustomMessages[0]?.message).toEqual({
			customType: "subagent-wait-guard-reminder",
			content: expect.stringContaining("needs attention"),
			display: false,
		});
		expect(sentCustomMessages[0]?.message.content).not.toContain("subagent_wait");
		expect(sentCustomMessages[0]?.options).toEqual({ triggerTurn: false });
		expect(sentUserMessages).toHaveLength(0);
	});

	test("headless mode forces at most one wait turn for an unchanged run snapshot", () => {
		const runtime = makePi();
		registerRuntime(runtime);
		activeRuns = [{ id: "run-headless", sessionId: "sess-headless", status: "running" }];
		const ctx = makeCtx("sess-headless");
		const messageEnd = handlers.get("message_end")!;
		const turnEnd = handlers.get("turn_end")!;

		messageEnd({ message: structuredClone(assistantText) }, ctx);
		turnEnd({ turnIndex: 0, message: {}, toolResults: [] }, ctx);
		messageEnd({ message: structuredClone(assistantText) }, ctx);
		turnEnd({ turnIndex: 1, message: {}, toolResults: [] }, ctx);

		expect(sentCustomMessages).toHaveLength(1);
		expect(sentCustomMessages[0]?.message.content).toContain("standalone `subagent_wait` tool");
		expect(sentCustomMessages[0]?.message.content).toContain(
			"not `subagent({ action: \"wait\" })`",
		);
		expect(sentCustomMessages[0]?.options).toEqual({ deliverAs: "followUp" });
		expect(sentUserMessages).toHaveLength(0);
	});

	test("headless follow-up reconciles a run snapshot changed before turn end", () => {
		const runtime = makePi();
		registerRuntime(runtime);
		activeRuns = [{ id: "run-before", sessionId: "sess-race", status: "running" }];
		const ctx = makeCtx("sess-race");

		handlers.get("message_end")!({ message: structuredClone(assistantText) }, ctx);
		activeRuns = [{ id: "run-after", sessionId: "sess-race", status: "queued" }];
		handlers.get("turn_end")!({ turnIndex: 0, message: {}, toolResults: [] }, ctx);

		expect(sentCustomMessages).toHaveLength(1);
		expect(sentCustomMessages[0]?.message.content).toContain("run-after");
		expect(sentCustomMessages[0]?.message.content).not.toContain("run-before");
		expect(sentUserMessages).toHaveLength(0);
	});

	test("changed run membership permits one new headless intervention", () => {
		const runtime = makePi();
		registerRuntime(runtime);
		activeRuns = [{ id: "run-a", sessionId: "sess-change", status: "running" }];
		const ctx = makeCtx("sess-change");
		const messageEnd = handlers.get("message_end")!;
		const turnEnd = handlers.get("turn_end")!;

		messageEnd({ message: structuredClone(assistantText) }, ctx);
		turnEnd({ turnIndex: 0, message: {}, toolResults: [] }, ctx);
		activeRuns = [
			{ id: "run-a", sessionId: "sess-change", status: "running" },
			{ id: "run-b", sessionId: "sess-change", status: "queued" },
		];
		messageEnd({ message: structuredClone(assistantText) }, ctx);
		turnEnd({ turnIndex: 1, message: {}, toolResults: [] }, ctx);

		expect(sentCustomMessages).toHaveLength(2);
		expect(sentCustomMessages[1]?.message.content).toContain("run-b");
		expect(sentUserMessages).toHaveLength(0);
	});

	test("paused or mixed snapshots report attention without forcing a wait loop", () => {
		const runtime = makePi();
		registerRuntime(runtime);
		activeRuns = [
			{ id: "run-live", sessionId: "sess-attention", status: "running" },
			{ id: "run-paused", sessionId: "sess-attention", status: "paused" },
		];
		const ctx = makeCtx("sess-attention");

		const result = handlers.get("message_end")!({ message: structuredClone(assistantText) }, ctx);
		expect(JSON.stringify(result?.message?.content)).toContain("attention");
		handlers.get("turn_end")!({ turnIndex: 0, message: {}, toolResults: [] }, ctx);

		expect(sentUserMessages).toHaveLength(0);
	});

	test("one session shutdown preserves another session's pending intervention", () => {
		const runtime = makePi();
		registerRuntime(runtime);
		const sessionOne = makeCtx("sess-one");
		const sessionTwo = makeCtx("sess-two");

		activeRuns = [{ id: "run-one", sessionId: "sess-one", status: "running" }];
		handlers.get("message_end")!({ message: structuredClone(assistantText) }, sessionOne);
		activeRuns = [{ id: "run-two", sessionId: "sess-two", status: "running" }];
		handlers.get("message_end")!({ message: structuredClone(assistantText) }, sessionTwo);
		handlers.get("session_shutdown")!({}, sessionOne);
		handlers.get("turn_end")!({ turnIndex: 0, message: {}, toolResults: [] }, sessionTwo);

		expect(sentCustomMessages).toHaveLength(1);
		expect(sentCustomMessages[0]?.message.content).toContain("run-two");
		expect(sentUserMessages).toHaveLength(0);
	});

	test("withholds a final answer for a paused run without queueing a wait", () => {
		const runtime = makePi();
		registerRuntime(runtime);
		activeRuns = [{ id: "paused-run", sessionId: "sess-1", status: "paused" }];
		const ctx = makeCtx("sess-1");

		const result = handlers.get("message_end")!({ message: structuredClone(assistantText) }, ctx);
		expect(JSON.stringify(result?.message?.content)).toContain("paused-run");
		handlers.get("turn_end")!({ turnIndex: 0, message: {}, toolResults: [] }, ctx);
		expect(sentCustomMessages).toHaveLength(1);
		expect(sentCustomMessages[0]?.message.content).toContain("needs attention");
		expect(sentCustomMessages[0]?.options).toEqual({ triggerTurn: false });
		expect(sentUserMessages).toHaveLength(0);
	});

	test("stays fail-closed without repeating follow-ups, then resets after settlement", () => {
		const runtime = makePi();
		registerRuntime(runtime);
		activeRuns = [{ id: "run-stuck", sessionId: "sess-reset" }];
		const ctx = makeCtx("sess-reset");
		const messageEnd = handlers.get("message_end")!;
		const turnEnd = handlers.get("turn_end")!;

		for (let i = 0; i < 10; i++) {
			const result = messageEnd({ message: structuredClone(assistantText) }, ctx);
			expect(result?.message).toBeDefined();
			turnEnd({ turnIndex: i, message: {}, toolResults: [] }, ctx);
		}
		expect(sentCustomMessages).toHaveLength(1);
		expect(sentUserMessages).toHaveLength(0);

		activeRuns = [];
		messageEnd({ message: structuredClone(assistantText) }, ctx);
		activeRuns = [{ id: "run-new", sessionId: "sess-reset" }];
		const revived = messageEnd({ message: structuredClone(assistantText) }, ctx);
		turnEnd({ turnIndex: 11, message: {}, toolResults: [] }, ctx);
		expect(JSON.stringify(revived?.message?.content)).toContain("run-new");
		expect(sentCustomMessages).toHaveLength(2);
		expect(sentUserMessages).toHaveLength(0);
	});
});
