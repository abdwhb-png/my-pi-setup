import { describe, expect, test } from "bun:test";
import type { AssistantMessage, TextContent, ToolCall } from "@earendil-works/pi-ai";
import {
	buildFollowUp,
	buildReplacement,
	isInteractiveTuiRuntime,
	isPrematureFinalAssistant,
} from "./guard.ts";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(content: Array<TextContent | ToolCall>): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("isPrematureFinalAssistant", () => {
	test("true for assistant text without tool calls", () => {
		const message = assistantMessage([{ type: "text", text: "Here is my final direction..." }]);
		expect(isPrematureFinalAssistant(message)).toBe(true);
	});

	test("false for assistant message containing tool calls", () => {
		const message = assistantMessage([
			{ type: "text", text: "Let me wait." },
			{ type: "toolCall", id: "t1", name: "subagent_wait", arguments: {} },
		]);
		expect(isPrematureFinalAssistant(message)).toBe(false);
	});

	test("false for empty or whitespace-only text", () => {
		const message = assistantMessage([{ type: "text", text: "   " }]);
		expect(isPrematureFinalAssistant(message)).toBe(false);
	});
});

describe("isInteractiveTuiRuntime", () => {
	test("accepts interactive UI and rejects headless or RPC modes", () => {
		expect(isInteractiveTuiRuntime(true, ["pi"])).toBe(true);
		expect(isInteractiveTuiRuntime(false, ["pi"])).toBe(false);
		expect(isInteractiveTuiRuntime(true, ["pi", "--mode", "rpc"])).toBe(false);
		expect(isInteractiveTuiRuntime(true, ["pi", "--mode=rpc"])).toBe(false);
	});
});

describe("buildReplacement", () => {
	test("keeps assistant identity and tells interactive sessions to await native wake", () => {
		const original = assistantMessage([{ type: "text", text: "premature answer" }]);
		const replaced = buildReplacement(original, ["run-a"], "interactive");
		expect(replaced.role).toBe("assistant");
		expect(replaced.stopReason).toBe("stop");
		expect(replaced.model).toBe(original.model);
		expect(replaced.content).toHaveLength(1);
		expect(replaced.content[0].type).toBe("text");
		if (replaced.content[0].type === "text") {
			expect(replaced.content[0].text).toContain("run-a");
			expect(replaced.content[0].text).toContain("Pi will wake this session");
			expect(replaced.content[0].text).not.toContain("premature answer");
		}
	});

	test("uses attention guidance whenever a run is paused", () => {
		const original = assistantMessage([{ type: "text", text: "premature answer" }]);
		const replaced = buildReplacement(original, ["run-paused"], "attention");
		expect(JSON.stringify(replaced.content)).toContain("needs attention");
		expect(JSON.stringify(replaced.content)).not.toContain("subagent_wait");
	});
});

describe("buildFollowUp", () => {
	test("distinguishes the standalone wait tool from subagent management actions", () => {
		const text = buildFollowUp(["run-a", "run-b"]);
		expect(text).toContain("run-a");
		expect(text).toContain("run-b");
		expect(text).toContain("standalone `subagent_wait` tool");
		expect(text).toContain("not `subagent({ action: \"wait\" })`");
	});
});
