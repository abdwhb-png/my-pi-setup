/**
 * Factory AI live model discovery.
 *
 * Uses @factory/droid-sdk's `session.initResult.availableModels` as the source
 * of truth for the model catalog. This avoids hardcoding model IDs, display names,
 * multipliers, or reasoning support.
 *
 * The SDK does not expose context window / max output tokens, so those are
 * approximated by provider-family defaults.
 */

import { createSession, ModelProvider, ReasoningEffort } from "@factory/droid-sdk";
import type { AvailableModelConfig } from "@factory/droid-sdk";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export interface FactoryModelEntry {
	id: string;
	name: string;
	shortName: string;
	provider: string;
	multiplier: number;
	reasoning: boolean;
	supportedReasoningEfforts: string[];
	input: Array<"text" | "image">;
	contextWindow: number;
	maxTokens: number;
	costInput: number;
	costOutput: number;
}

let factoryModelsCache: FactoryModelEntry[] = [];

export function getCachedFactoryModels(): FactoryModelEntry[] {
	return factoryModelsCache;
}

export function setCachedFactoryModels(models: FactoryModelEntry[]): void {
	factoryModelsCache = models;
}

export function clearCachedFactoryModels(): void {
	factoryModelsCache = [];
}

function providerDefaults(
	provider: string,
	modelId: string,
): Pick<FactoryModelEntry, "contextWindow" | "maxTokens" | "costInput" | "costOutput"> {
	// Anthropic family — sourced from official Claude model overview / context docs
	if (provider === ModelProvider.ANTHROPIC) {
		if (modelId.includes("fable-5")) {
			return { contextWindow: 1_000_000, maxTokens: 128_000, costInput: 10, costOutput: 50 };
		}
		if (
			modelId.includes("opus-4-8") ||
			modelId.includes("opus-4-7") ||
			modelId.includes("opus-4-6") ||
			modelId.includes("sonnet-4-6")
		) {
			return {
				contextWindow: 1_000_000,
				maxTokens: 128_000,
				costInput: modelId.includes("sonnet") ? 3 : 5,
				costOutput: modelId.includes("sonnet") ? 15 : 25,
			};
		}
		if (modelId.includes("haiku-4-5")) {
			return { contextWindow: 200_000, maxTokens: 64_000, costInput: 1, costOutput: 5 };
		}
		if (modelId.includes("sonnet-4-5")) {
			return { contextWindow: 200_000, maxTokens: 64_000, costInput: 3, costOutput: 15 };
		}
		if (modelId.includes("opus-4-5")) {
			return { contextWindow: 200_000, maxTokens: 64_000, costInput: 5, costOutput: 25 };
		}
		return { contextWindow: 200_000, maxTokens: 64_000, costInput: 3, costOutput: 15 };
	}

	// OpenAI family — sourced from official OpenAI model pages
	if (provider === ModelProvider.OPENAI) {
		if (
			modelId.includes("gpt-5.5") ||
			modelId.includes("gpt-5.4") && !modelId.includes("mini")
		) {
			return {
				contextWindow: 1_050_000,
				maxTokens: 128_000,
				costInput: modelId.includes("pro") ? 30 : modelId.includes("5.5") ? 5 : 1.25,
				costOutput: modelId.includes("pro") ? 180 : modelId.includes("5.5") ? 30 : 7.5,
			};
		}
		if (
			modelId.includes("gpt-5.4-mini") ||
			modelId.includes("gpt-5.3-codex") ||
			modelId.includes("gpt-5.2")
		) {
			return {
				contextWindow: 400_000,
				maxTokens: 128_000,
				costInput: modelId.includes("mini") ? 0.75 : modelId.includes("5.2") ? 1.25 : 0.7,
				costOutput: modelId.includes("mini") ? 4.5 : modelId.includes("5.2") ? 10 : 10,
			};
		}
		return { contextWindow: 400_000, maxTokens: 128_000, costInput: 1.25, costOutput: 10 };
	}

	// Google Gemini family — sourced from official Gemini model pages
	if (provider === ModelProvider.GOOGLE) {
		const isFlash = modelId.includes("flash");
		return {
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			costInput: isFlash ? 0.15 : 2,
			costOutput: isFlash ? 0.6 : 12,
		};
	}

	// Factory / Droid Core open models — sourced from official provider docs where available
	if (provider === ModelProvider.FACTORY) {
		if (modelId === "glm-5.2") {
			return { contextWindow: 1_000_000, maxTokens: 163_840, costInput: 0.5, costOutput: 2 };
		}
		if (modelId === "glm-5.1") {
			return { contextWindow: 200_000, maxTokens: 64_000, costInput: 0.5, costOutput: 2 };
		}
		if (modelId === "nemotron-3-ultra") {
			return { contextWindow: 1_000_000, maxTokens: 128_000, costInput: 0.5, costOutput: 2 };
		}
		if (modelId === "kimi-k2.7-code" || modelId === "kimi-k2.6" || modelId === "kimi-k2.5") {
			return { contextWindow: 262_144, maxTokens: 64_000, costInput: 0.95, costOutput: 4 };
		}
		if (modelId === "deepseek-v4-pro") {
			return { contextWindow: 1_000_000, maxTokens: 128_000, costInput: 0.5, costOutput: 2 };
		}
		if (modelId === "minimax-m3") {
			return { contextWindow: 1_000_000, maxTokens: 131_072, costInput: 0.5, costOutput: 2 };
		}
		if (modelId === "minimax-m2.7" || modelId === "minimax-m2.5") {
			return { contextWindow: 204_800, maxTokens: 65_536, costInput: 0.5, costOutput: 2 };
		}
		return { contextWindow: 128_000, maxTokens: 32_000, costInput: 0.5, costOutput: 2 };
	}

	// Fallback for future providers
	return { contextWindow: 128_000, maxTokens: 32_000, costInput: 0, costOutput: 0 };
}

function hasReasoning(efforts: string[]): boolean {
	return efforts.some(
		(effort) => effort !== ReasoningEffort.None && effort !== ReasoningEffort.Off,
	);
}

function toFactoryModelEntry(model: AvailableModelConfig): FactoryModelEntry {
	const provider = model.modelProvider;
	const modelId = model.id;
	const displayName = model.displayName;
	const multiplier = model.tokenMultiplier ?? 1;
	const supportedReasoningEfforts = model.supportedReasoningEfforts.map(String);
	const defaults = providerDefaults(provider, modelId);

	return {
		id: modelId,
		name: displayName,
		shortName: model.shortDisplayName,
		provider,
		multiplier,
		reasoning: hasReasoning(supportedReasoningEfforts),
		supportedReasoningEfforts,
		input: model.noImageSupport ? ["text"] : ["text", "image"],
		contextWindow: defaults.contextWindow,
		maxTokens: defaults.maxTokens,
		costInput: defaults.costInput,
		costOutput: defaults.costOutput,
	};
}

/**
 * Fetch the live Factory AI model catalog using the user's API key.
 *
 * This creates a short-lived SDK session without specifying a modelId,
 * reads `initResult.availableModels`, then closes the session immediately.
 */
export async function fetchFactoryModels(
	apiKey: string,
	cwd = process.cwd(),
): Promise<FactoryModelEntry[]> {
	const session = await createSession({ apiKey, cwd });
	try {
		const available = session.initResult.availableModels ?? [];
		const models = available
			.filter((model) => !model.isCustom)
			.map(toFactoryModelEntry);
		if (models.length === 0) {
			throw new Error("Factory returned no available models");
		}
		setCachedFactoryModels(models);
		return models;
	} finally {
		await session.close().catch(() => {});
	}
}

/**
 * Convert cached or provided live-discovered models to Pi's ProviderModelConfig.
 */
export function toProviderModels(models = factoryModelsCache): ProviderModelConfig[] {
	return models.map((m) => ({
		id: m.id,
		name: `${m.name} [${m.multiplier}×]`,
		reasoning: m.reasoning,
		input: m.input,
		cost: {
			input: m.costInput,
			output: m.costOutput,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
	}));
}

/**
 * Convert cached or provided models to fully resolved Pi Model objects, for
 * OAuth `modifyModels` hooks that need to swap the model list in-place.
 */
export function toResolvedFactoryModels<TApi extends Api>(
	providerName: string,
	baseUrl: string,
	api: TApi,
	models = factoryModelsCache,
): Array<Model<TApi>> {
	return models.map((m) => ({
		id: m.id,
		name: `${m.name} [${m.multiplier}×]`,
		api,
		provider: providerName,
		baseUrl,
		reasoning: m.reasoning,
		input: m.input,
		cost: {
			input: m.costInput,
			output: m.costOutput,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
	}));
}

export function findFactoryModel(id: string): FactoryModelEntry | undefined {
	return factoryModelsCache.find((m) => m.id === id);
}

export function getFactoryModelMultiplier(id: string): number | undefined {
	return findFactoryModel(id)?.multiplier;
}
