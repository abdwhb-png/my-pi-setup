/**
 * Gemini ↔ Pi format translator for the Factory AI cloudcode fallback.
 *
 * Converts Pi's internal message format to Gemini's generateContent request
 * shape, and parses SSE stream chunks back into Pi's AssistantMessageEvent
 * stream events.
 *
 * Request format (Gemini generateContent):
 *   { model, request: { messages: [{ role, parts: [{ text }] }], generationConfig: {...}, tools?: [...] } }
 *
 * Response format (SSE, alt=sse):
 *   data: {"candidates":[{"content":{"role":"model","parts":[{"text":"..."}]}}],...}\n\n
 */

import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
} from "@earendil-works/pi-ai";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

// ── Request building ──

interface GeminiPart {
	text?: string;
	inlineData?: { mimeType: string; data: string };
	functionCall?: { name: string; args: Record<string, unknown> };
	functionResponse?: { name: string; response: { name: string; content: string } };
}

interface GeminiContent {
	role: "user" | "model" | "tool";
	parts: GeminiPart[];
}

interface GeminiRequest {
	model: string;
	request: {
		messages: GeminiContent[];
		generationConfig: {
			temperature?: number;
			maxOutputTokens?: number;
			topP?: number;
			thinkingConfig?: { thinkingBudget?: number };
		};
		tools?: Array<{
			functionDeclarations: Array<{
				name: string;
				description: string;
				parameters: Record<string, unknown>;
			}>;
		}>;
		systemInstruction?: { parts: { text: string }[] };
	};
}

function buildGeminiRequest(
	modelId: string,
	context: Context,
	options?: SimpleStreamOptions,
): GeminiRequest {
	const contents: GeminiContent[] = [];

	// System prompt as systemInstruction
	const request: GeminiRequest["request"] = {
		messages: contents,
		generationConfig: {},
	};

	if (context.systemPrompt) {
		request.systemInstruction = {
			parts: [{ text: context.systemPrompt }],
		};
	}

	// Map Pi messages to Gemini contents
	for (const msg of context.messages) {
		if (msg.role === "user") {
			const parts: GeminiPart[] = [];
			if (typeof msg.content === "string") {
				if (msg.content.trim()) {
					parts.push({ text: msg.content });
				}
			} else {
				for (const block of msg.content) {
					if (block.type === "text" && block.text.trim()) {
						parts.push({ text: block.text });
					} else if (block.type === "image") {
						parts.push({
							inlineData: { mimeType: block.mimeType, data: block.data },
						});
					}
				}
			}
			if (parts.length > 0) {
				contents.push({ role: "user", parts });
			}
		} else if (msg.role === "assistant") {
			const parts: GeminiPart[] = [];
			for (const block of msg.content) {
				if (block.type === "text" && block.text.trim()) {
					parts.push({ text: block.text });
				} else if (block.type === "toolCall") {
					parts.push({
						functionCall: {
							name: block.name,
							args: block.arguments as Record<string, unknown>,
						},
					});
				}
			}
			if (parts.length > 0) {
				contents.push({ role: "model", parts });
			}
		} else if (msg.role === "toolResult") {
			contents.push({
				role: "tool",
				parts: [
					{
						functionResponse: {
							name: msg.toolCallId,
							response: {
								name: msg.toolCallId,
								content:
									typeof msg.content === "string"
										? msg.content
										: msg.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"),
							},
						},
					},
				],
			});
		}
	}

	// Generation config
	if (options?.maxTokens) {
		request.generationConfig.maxOutputTokens = options.maxTokens;
	} else {
		request.generationConfig.maxOutputTokens = 65536;
	}

	if (options?.reasoning) {
		const budgets: Record<string, number> = {
			minimal: 1024,
			low: 4096,
			medium: 10240,
			high: 20480,
			xhigh: 32768,
		};
		const budget = budgets[options.reasoning.toLowerCase()] ?? 10240;
		request.generationConfig.thinkingConfig = { thinkingBudget: budget };
	}

	// Tools
	if (context.tools && context.tools.length > 0) {
		request.tools = [
			{
				functionDeclarations: context.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: (tool.parameters as Record<string, unknown>) || {},
				})),
			},
		];
	}

	return { model: modelId, request };
}

// ── SSE parsing ──

/**
 * Parse a single SSE `data:` line into Pi stream events.
 * Pushes text_delta, text_start, text_end, thinking_delta, etc. events
 * into the provided stream.
 */
function parseGeminiSseLine(
	line: string,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	model: Model<Api>,
): void {
	// SSE format: "data: <json>"
	const dataMatch = line.match(/^data:\s*(.*)/);
	if (!dataMatch) return;

	const jsonStr = dataMatch[1].trim();
	if (!jsonStr || jsonStr === "[DONE]") return;

	let chunk: Record<string, unknown>;
	try {
		chunk = JSON.parse(jsonStr);
	} catch {
		return; // skip malformed JSON
	}

	const candidates = chunk.candidates as Array<Record<string, unknown>> | undefined;
	if (!candidates || candidates.length === 0) return;

	const candidate = candidates[0];
	const content = candidate.content as Record<string, unknown> | undefined;
	if (!content) return;

	const parts = content.parts as Array<Record<string, unknown>> | undefined;
	if (!parts) return;

	for (const part of parts) {
		if (part.text !== undefined) {
			const text = String(part.text);
			// Find or create text block
			let idx = output.content.findIndex((c) => c.type === "text");
			if (idx === -1) {
				idx = output.content.length;
				output.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: idx, partial: output });
			}
			const block = output.content[idx];
			if (block.type === "text") {
				block.text += text;
				stream.push({
					type: "text_delta",
					contentIndex: idx,
					delta: text,
					partial: output,
				});
			}
		}

		if (part.thought !== undefined) {
			const thought = String(part.thought);
			let idx = output.content.findIndex((c) => c.type === "thinking");
			if (idx === -1) {
				idx = output.content.length;
				output.content.push({ type: "thinking", thinking: "" });
				stream.push({ type: "thinking_start", contentIndex: idx, partial: output });
			}
			const block = output.content[idx];
			if (block.type === "thinking") {
				block.thinking += thought;
				stream.push({
					type: "thinking_delta",
					contentIndex: idx,
					delta: thought,
					partial: output,
				});
			}
		}

		if (part.functionCall) {
			const fc = part.functionCall as Record<string, unknown>;
			output.content.push({
				type: "toolCall",
				id: crypto.randomUUID(),
				name: String(fc.name),
				arguments: (fc.args as Record<string, unknown>) || {},
			});
		}
	}

	// Usage info
	if (chunk.usageMetadata) {
		const um = chunk.usageMetadata as Record<string, unknown>;
		output.usage.input = Number(um.promptTokenCount) || 0;
		output.usage.output = Number(um.candidatesTokenCount) || 0;
		output.usage.cacheRead = Number(um.cachedContentTokenCount) || 0;
		output.usage.totalTokens =
			(Number(um.totalTokenCount) || 0) ||
			output.usage.input + output.usage.output + output.usage.cacheRead;
		calculateCost(model, output.usage);
	}

	// Finish reason
	if (candidate.finishReason) {
		const reason = String(candidate.finishReason);
		if (reason === "STOP") output.stopReason = "stop";
		else if (reason === "MAX_TOKENS") output.stopReason = "length";
		else if (reason === "TOOL_CALLS") output.stopReason = "toolUse";
	}
}

export { buildGeminiRequest, parseGeminiSseLine };
