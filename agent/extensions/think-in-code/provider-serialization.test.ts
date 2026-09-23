import { expect, test } from "bun:test";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import type { Context, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import { createThinkExecuteContent } from "./public-contract.ts";

const model: Model<"openai-completions"> = {
    id: "serialization-test",
    name: "Serialization test",
    api: "openai-completions",
    provider: "test",
    baseUrl: "http://127.0.0.1:1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 1024,
};

const compat: Parameters<typeof convertMessages>[2] = {
    supportsStore: true,
    supportsDeveloperRole: true,
    supportsReasoningEffort: true,
    supportsUsageInStreaming: true,
    supportsFinishReason: true,
    maxTokensField: "max_completion_tokens",
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    requiresReasoningContentOnAssistantMessages: false,
    thinkingFormat: "openai",
    openRouterRouting: {},
    vercelGatewayRouting: {},
    chatTemplateKwargs: {},
    chatTemplateArgs: {},
    zaiToolStream: false,
    supportsThinkingTokenBudget: false,
    supportsStrictMode: true,
    supportsOpenAIGrammarTools: false,
    cacheControlFormat: undefined,
    sendSessionAffinityHeaders: false,
    sessionAffinityFormat: "openai",
    supportsLongCacheRetention: true,
};

test("OpenAI completions sends the Think public content without details", () => {
    const content = createThinkExecuteContent(
        {
            status: "partial",
            action: "command",
            sourceStatus: "failed",
            sourceBytes: 14,
            resultBytes: 2,
            truncated: false,
            archiveIds: ["raw-archive", "derived-archive"],
            indexStatus: "indexed",
        },
        "14",
    );
    const context: Context = {
        messages: [
            {
                role: "toolResult",
                toolCallId: "call-1",
                toolName: "think_execute",
                content,
                details: { secretOnlyInDetails: "must-not-reach-provider" },
                isError: false,
                timestamp: 1,
            },
        ],
    };

    const messages = convertMessages(model, normalizeContext(context), compat);

    expect(messages).toEqual([
        {
            role: "tool",
            content: `${JSON.stringify({
                status: "partial",
                action: "command",
                sourceStatus: "failed",
                sourceBytes: 14,
                resultBytes: 2,
                truncated: false,
                archiveIds: ["raw-archive", "derived-archive"],
                indexStatus: "indexed",
            })}\n14`,
            tool_call_id: "call-1",
        },
    ]);
    expect(JSON.stringify(messages)).not.toContain("must-not-reach-provider");
});
