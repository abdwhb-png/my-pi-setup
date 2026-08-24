import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";

type Handler = (event: any, ctx: any) => any;
interface ActiveSubagentRun {
	id: string;
	sessionId: string;
}

const ACTIVE_SUBAGENT_RUNS_REGISTRY_KEY = "pi-subagents.active-runs.v1";
const handlers = new Map<string, Handler>();
const sentUserMessages: Array<{ content: string; options?: unknown }> = [];
let activeRuns: ActiveSubagentRun[] = [];

afterEach(() => {
	handlers.get("session_shutdown")?.({}, makeCtx("cleanup"));
	handlers.clear();
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

function makeCtx(sessionId: string, sessionFile?: string) {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFile,
		},
	};
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

describe("subagent-wait-guard entry", () => {
	test("registers Pi handlers without lifecycle event subscriptions", () => {
		const runtime = makePi();
		registerRuntime(runtime);

		expect([...handlers.keys()].sort()).toEqual(["message_end", "session_shutdown", "turn_end"]);
		expect(runtime.subscribers("subagent:async-started")).toBe(0);
		expect(runtime.subscribers("subagent:async-complete")).toBe(0);
	});

	test("replaces premature answer from the process-global active-runs snapshot", () => {
		const runtime = makePi();
		registerRuntime(runtime);
		activeRuns = [{ id: "run-1", sessionId: "sess-1" }];
		const ctx = makeCtx("sess-1");

		const result = handlers.get("message_end")!({ message: structuredClone(assistantText) }, ctx);
		expect(result?.message?.role).toBe("assistant");
		expect(JSON.stringify(result?.message?.content)).toContain("run-1");
		expect(JSON.stringify(result?.message?.content)).not.toContain("premature final direction");

		handlers.get("turn_end")!({ turnIndex: 0, message: {}, toolResults: [] }, ctx);
		expect(sentUserMessages).toHaveLength(1);
		expect(sentUserMessages[0].content).toContain("run-1");
		expect(sentUserMessages[0].options).toEqual({ deliverAs: "followUp" });
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

	test("ignores non-final messages while a run is active", () => {
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
	});

	test("backs off at the cap, then an empty snapshot resets the session", () => {
		const runtime = makePi();
		registerRuntime(runtime);
		activeRuns = [{ id: "run-stuck", sessionId: "sess-cap" }];
		const ctx = makeCtx("sess-cap");
		const messageEnd = handlers.get("message_end")!;
		const turnEnd = handlers.get("turn_end")!;

		for (let i = 0; i < 5; i++) {
			messageEnd({ message: structuredClone(assistantText) }, ctx);
			turnEnd({ turnIndex: i, message: {}, toolResults: [] }, ctx);
		}
		expect(sentUserMessages).toHaveLength(5);
		expect(messageEnd({ message: structuredClone(assistantText) }, ctx)).toBeUndefined();

		activeRuns = [];
		messageEnd({ message: structuredClone(assistantText) }, ctx);
		activeRuns = [{ id: "run-new", sessionId: "sess-cap" }];
		const revived = messageEnd({ message: structuredClone(assistantText) }, ctx);
		expect(JSON.stringify(revived?.message?.content)).toContain("run-new");
	});
});
