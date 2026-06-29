/**
 * SDK Bridge — adapts @factory/droid-sdk output to Pi's stream format.
 *
 * Primary: relay.factory.ai via connectDaemon (no local binary).
 * Fallback: cloudcode-pa.googleapis.com via HTTP+SSE (Gemini format).
 * Maps DroidStreamEvent → AssistantMessageEvent for Pi's streamSimple.
 */

import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { Api, Model, SimpleStreamOptions, Context } from "@earendil-works/pi-ai";
import { DroidMessageType } from "@factory/droid-sdk";
import type {
	AssistantTextDelta,
	AssistantTextComplete,
	ThinkingTextDelta,
	ThinkingTextComplete,
	TokenUsageUpdate,
	DroidResultMessage,
	DroidStreamEvent,
	ErrorEvent as DroidErrorEvent,
} from "@factory/droid-sdk";
import { buildGeminiRequest, parseGeminiSseLine } from "./gemini-translator.ts";
import { CLOUDCODE_BASE_URL, CLOUDCODE_STREAM_PATH } from "./google-oauth.ts";

export interface FactoryStreamConfig {
	apiKey: string;
	/** Google OAuth access token for cloudcode-pa fallback */
	googleAccessToken?: string;
	cwd?: string;
}

/**
 * Build message content from Pi's message context into a single prompt string
 * suitable for the droid exec query interface.
 */
function buildPrompt(context: Context): string {
	const parts: string[] = [];

	if (context.systemPrompt) {
		parts.push(`System: ${context.systemPrompt}`);
	}

	for (const msg of context.messages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c) => c.type === "text")
							.map((c) => c.text)
							.join("\n");
			if (content.trim()) {
				parts.push(`User: ${content}`);
			}
		} else if (msg.role === "assistant") {
			const text = msg.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");
			if (text.trim()) {
				parts.push(`Assistant: ${text}`);
			}
		}
	}

	return parts.join("\n\n") || "Hello";
}

/**
 * Map a DroidStreamEvent to Pi AssistantMessageEvent stream pushes.
 *
 * Returns true if the stream consumer should continue, false if done.
 */
export function handleStreamEvent(
	event: DroidStreamEvent,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	model: Model<Api>,
): boolean {
	switch (event.type) {
		case DroidMessageType.AssistantTextDelta: {
			const delta = event as AssistantTextDelta;
			// Find or create a text content block
			let contentIndex = output.content.findIndex(
				(c) => c.type === "text",
			);
			if (contentIndex === -1) {
				contentIndex = output.content.length;
				output.content.push({ type: "text", text: "" });
				stream.push({
					type: "text_start",
					contentIndex,
					partial: output,
				});
			}
			const block = output.content[contentIndex];
			if (block.type === "text") {
				block.text += delta.text;
				stream.push({
					type: "text_delta",
					contentIndex,
					delta: delta.text,
					partial: output,
				});
			}
			return true;
		}

		case DroidMessageType.AssistantTextComplete: {
			const idx = output.content.findIndex((c) => c.type === "text");
			if (idx !== -1) {
				stream.push({
					type: "text_end",
					contentIndex: idx,
					content: (output.content[idx] as any).text,
					partial: output,
				});
			}
			return true;
		}

		case DroidMessageType.ThinkingTextDelta: {
			const delta = event as ThinkingTextDelta;
			let contentIndex = output.content.findIndex(
				(c) => c.type === "thinking",
			);
			if (contentIndex === -1) {
				contentIndex = output.content.length;
				output.content.push({
					type: "thinking",
					thinking: "",
				});
				stream.push({
					type: "thinking_start",
					contentIndex,
					partial: output,
				});
			}
			const block = output.content[contentIndex];
			if (block.type === "thinking") {
				block.thinking += delta.text;
				stream.push({
					type: "thinking_delta",
					contentIndex,
					delta: delta.text,
					partial: output,
				});
			}
			return true;
		}

		case DroidMessageType.ThinkingTextComplete: {
			const idx = output.content.findIndex(
				(c) => c.type === "thinking",
			);
			if (idx !== -1) {
				stream.push({
					type: "thinking_end",
					contentIndex: idx,
					content: (output.content[idx] as any).thinking,
					partial: output,
				});
			}
			return true;
		}

		case DroidMessageType.TokenUsageUpdate: {
			const usage = event as TokenUsageUpdate;
			output.usage.input = usage.inputTokens || 0;
			output.usage.output = usage.outputTokens || 0;
			output.usage.cacheRead = usage.cacheReadTokens || 0;
			output.usage.cacheWrite = usage.cacheCreationTokens || 0;
			output.usage.totalTokens =
				output.usage.input +
				output.usage.output +
				output.usage.cacheRead +
				output.usage.cacheWrite;
			calculateCost(model, output.usage);
			return true;
		}

		case DroidMessageType.Result: {
			const result = event as DroidResultMessage;
			// If no text content was streamed, extract from result
			const hasText = output.content.some((c) => c.type === "text");
			if (!hasText && result.text) {
				output.content.push({ type: "text", text: result.text });
			}

			if (result.tokenUsage) {
				output.usage.input = result.tokenUsage.inputTokens || 0;
				output.usage.output = result.tokenUsage.outputTokens || 0;
				output.usage.cacheRead =
					result.tokenUsage.cacheReadTokens || 0;
				output.usage.cacheWrite =
					result.tokenUsage.cacheCreationTokens || 0;
				output.usage.totalTokens =
					output.usage.input +
					output.usage.output +
					output.usage.cacheRead +
					output.usage.cacheWrite;
				calculateCost(model, output.usage);
			}

			output.stopReason = result.isError ? "error" : "stop";
			if (result.isError && "errors" in result && result.errors.length > 0) {
				output.errorMessage = result.errors[0];
			}

			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
				message: output,
			});
			stream.end();
			return false;
		}

		case DroidMessageType.Error: {
			const err = event as DroidErrorEvent;
			output.stopReason = "error";
			output.errorMessage = err.message;
			stream.push({
				type: "error",
				reason: "error",
				error: output,
			});
			stream.end();
			return false;
		}

		// These event types are irrelevant for simple chat completion
		case DroidMessageType.WorkingStateChanged:
		case DroidMessageType.PermissionResolved:
		case DroidMessageType.SettingsUpdated:
		case DroidMessageType.SessionTitleUpdated:
		case DroidMessageType.McpStatusChanged:
		case DroidMessageType.MissionStateChanged:
		case DroidMessageType.MissionFeaturesChanged:
		case DroidMessageType.MissionProgressEntry:
		case DroidMessageType.MissionHeartbeat:
		case DroidMessageType.MissionWorkerStarted:
		case DroidMessageType.MissionWorkerCompleted:
		case DroidMessageType.McpAuthRequired:
		case DroidMessageType.McpAuthCompleted:
		case DroidMessageType.Hook:
		case DroidMessageType.Assistant:
		case DroidMessageType.User:
		case DroidMessageType.ToolCall:
		case DroidMessageType.ToolCallDelta:
		case DroidMessageType.ToolResult:
		case DroidMessageType.ToolProgress:
			return true;
	}

	return true;
}

/**
 * Fallback: stream via direct HTTP POST to cloudcode-pa.googleapis.com.
 *
 * Uses Gemini-shaped request bodies and parses SSE responses.
 * No droid binary or WebSocket needed — just fetch() + SSE parsing.
 */
async function streamViaCloudCode(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	googleAccessToken: string,
): Promise<void> {
	const url = `${CLOUDCODE_BASE_URL}${CLOUDCODE_STREAM_PATH}?alt=sse`;
	const request = buildGeminiRequest(model.id, context, options);

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${googleAccessToken}`,
			"User-Agent": "pi-factory-ai/1.0",
		},
		body: JSON.stringify(request),
		signal: options?.signal,
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`Cloudcode stream request failed: ${response.status} ${body.slice(0, 200)}`,
		);
	}

	if (!response.body) {
		throw new Error("Cloudcode stream response has no body");
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });

			// Parse complete SSE events (delimited by \n\n)
			const lines = buffer.split("\n");
			// Keep the last partial line in the buffer
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				parseGeminiSseLine(line, stream, output, model);
			}
		}

		// Process any remaining data
		if (buffer.trim()) {
			parseGeminiSseLine(buffer, stream, output, model);
		}

		// Finalize text/thinking blocks
		for (let i = 0; i < output.content.length; i++) {
			const block = output.content[i];
			if (block.type === "text") {
				stream.push({
					type: "text_end",
					contentIndex: i,
					content: block.text,
					partial: output,
				});
			} else if (block.type === "thinking") {
				stream.push({
					type: "thinking_end",
					contentIndex: i,
					content: block.thinking,
					partial: output,
				});
			}
		}

		calculateCost(model, output.usage);
		stream.push({
			type: "done",
			reason: output.stopReason as "stop" | "length" | "toolUse",
			message: output,
		});
		stream.end();
	} catch (error) {
		reader.cancel().catch(() => {});
		throw error;
	}
}

/**
 * Adapts @factory/droid-sdk's streaming session into Pi's
 * AssistantMessageEventStream format.
 *
 * Primary: relay.factory.ai via connectDaemon (no local binary).
 * Fallback: cloudcode-pa.googleapis.com via HTTP+SSE.
 *
 * This is the bridge called from streamSimple.
 */
export function streamFactory(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	config: FactoryStreamConfig,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: "factory-ai",
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	(async () => {
		// ── Primary: relay.factory.ai via SDK remote connection ──
		try {
			const { connectDaemon } = await import("@factory/droid-sdk");

			const daemon = await connectDaemon({
				apiKey: config.apiKey,
				// Use remote relay — no local binary
				url: "wss://relay.factory.ai",
			});

			const session = await daemon.createSession({
				modelId: model.id,
				cwd: config.cwd ?? process.cwd(),
			});

			stream.push({ type: "start", partial: output });

			try {
				const prompt = buildPrompt(context);
				for await (const event of session.stream(prompt, {
					includePartialMessages: true,
				})) {
					if (options?.signal?.aborted) {
						throw new Error("Request was aborted");
					}
					const shouldContinue = handleStreamEvent(
						event,
						stream,
						output,
						model,
					);
					if (!shouldContinue) return;
				}

				// Stream ended normally without result event
				if (output.stopReason === "stop" && output.errorMessage === undefined) {
					calculateCost(model, output.usage);
					stream.push({
						type: "done",
						reason: "stop",
						message: output,
					});
					stream.end();
				}
			} finally {
				await session.close().catch(() => {});
				await daemon.close().catch(() => {});
			}
			return;
		} catch (relayError) {
			// ── Fallback: cloudcode-pa.googleapis.com via HTTP+SSE ──
			const googleToken = config.googleAccessToken;
			if (!googleToken) {
				throw relayError; // No fallback available
			}

			console.warn(
				`Factory relay unreachable, falling back to cloudcode SSE: ${
					relayError instanceof Error ? relayError.message : String(relayError)
				}`,
			);

			try {
				stream.push({ type: "start", partial: output });
				await streamViaCloudCode(
					model,
					context,
					options,
					stream,
					output,
					googleToken,
				);
			} catch (cloudcodeError) {
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage =
					cloudcodeError instanceof Error
						? cloudcodeError.message
						: String(cloudcodeError);
				stream.push({
					type: "error",
					reason: output.stopReason,
					error: output,
				});
				stream.end();
			}
		}
	})();

	return stream;
}