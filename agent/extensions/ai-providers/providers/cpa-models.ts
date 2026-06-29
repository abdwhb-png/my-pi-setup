/**
 * CPA (CLIProxyAPI) model enrichment engine.
 *
 * Dynamically discovers models from CPA's `/v1/models` endpoint and enriches
 * them with metadata via a 4-layer fallback chain:
 *   1. Generic defaults (128K ctx, 32K out, $0)
 *   2. Family-based defaults (detected from model ID prefix)
 *   3. OpenRouter API metadata (public /v1/models endpoint)
 *   4. Provider-specific overrides (pricing for API-key providers)
 *
 * No model is ever skipped due to unknown owned_by — new providers added
 * to CPA appear automatically with family-based defaults.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// ── Types ──

export interface CpaModelEntry {
	id: string;
	owned_by: string;
}

interface OpenRouterModel {
	id: string;
	name: string;
	context_length: number;
	pricing: { prompt: string; completion: string };
	top_provider: { max_completion_tokens: number | null };
	supported_parameters?: string[];
}

// ── Module-level cache ──

let orMetadataCache: Map<string, OpenRouterModel> | null = null;

/** Reset the OpenRouter metadata cache (for testing). */
export function resetOrMetadataCache(): void {
	orMetadataCache = null;
}

/** Shared compat constant — avoids repeating the cast across ~30 model entries. */
const NO_DEV_ROLE_COMPAT = { supportsDeveloperRole: false } as ProviderModelConfig["compat"];

// ── Helper: parse per-million cost strings from OpenRouter ──

function parseOrCost(s: string): number {
	const n = parseFloat(s);
	if (isNaN(n) || n < 0) return 0;
	// OpenRouter pricing is per-token in the string; convert to per-million
	// Example: "0.0000001" → 0.1 (per million tokens)
	// But the API returns strings like "1e-7" — parseFloat handles this
	// The value is per-token, so multiply by 1e6
	return n * 1_000_000;
}

// ── Helper: strip ocg/ prefix to get alias ──

function ocgAlias(modelId: string): string {
	return modelId.startsWith("ocg/") ? modelId.slice(4) : modelId;
}

// ── Step 1a: Fetch model IDs from CPA ──

export async function fetchCpaModelIds(
	baseUrl: string,
	apiKey: string,
): Promise<CpaModelEntry[]> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 3000);

	try {
		const url = `${baseUrl.replace(/\/$/, "")}/models`;
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: controller.signal,
		});

		if (!response.ok) {
			console.warn(`[cpa-models] CPA /v1/models returned ${response.status}`);
			return [];
		}

		const json = await response.json();
		const data = json.data as Array<{ id: string; created?: number; object?: string; owned_by?: string }> | undefined;
		if (!data || !Array.isArray(data)) {
			console.warn("[cpa-models] Unexpected /v1/models response shape");
			return [];
		}

		return data.map((m) => ({
			id: String(m.id ?? ""),
			owned_by: String(m.owned_by ?? "unknown"),
		}));
	} catch (err) {
		if (err instanceof DOMException && err.name === "AbortError") {
			console.warn("[cpa-models] CPA /v1/models fetch timed out");
		} else {
			console.warn("[cpa-models] CPA /v1/models fetch failed:", err);
		}
		return [];
	} finally {
		clearTimeout(timeout);
	}
}

// ── Step 1b: Fetch OpenRouter metadata ──

export async function fetchOpenRouterMetadata(): Promise<Map<string, OpenRouterModel>> {
	if (orMetadataCache) return orMetadataCache;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000);

	try {
		const response = await fetch("https://openrouter.ai/api/v1/models", {
			signal: controller.signal,
		});

		if (!response.ok) {
			console.warn(`[cpa-models] OpenRouter /v1/models returned ${response.status}`);
			return new Map();
		}

		const json = await response.json();
		const data = json.data as Array<{
			id: string;
			name: string;
			context_length: number;
			pricing: { prompt: string; completion: string };
			top_provider: { max_completion_tokens: number | null };
			supported_parameters?: string[];
		}> | undefined;

		if (!data || !Array.isArray(data)) {
			console.warn("[cpa-models] Unexpected OpenRouter /v1/models response shape");
			return new Map();
		}

		const map = new Map<string, OpenRouterModel>();
		for (const m of data) {
			if (m.id) {
				map.set(String(m.id), {
					id: String(m.id),
					name: String(m.name ?? ""),
					context_length: m.context_length ?? 0,
					pricing: {
						prompt: String(m.pricing?.prompt ?? "0"),
						completion: String(m.pricing?.completion ?? "0"),
					},
					top_provider: {
						max_completion_tokens: m.top_provider?.max_completion_tokens ?? null,
					},
					supported_parameters: m.supported_parameters ?? [],
				});
			}
		}

		orMetadataCache = map;
		return map;
	} catch (err) {
		if (err instanceof DOMException && err.name === "AbortError") {
			console.warn("[cpa-models] OpenRouter /v1/models fetch timed out");
		} else {
			console.warn("[cpa-models] OpenRouter /v1/models fetch failed:", err);
		}
		return new Map();
	} finally {
		clearTimeout(timeout);
	}
}

// ── Step 1c: Family-based defaults ──

export function familyDefaults(
	modelId: string,
): Partial<Pick<ProviderModelConfig, "contextWindow" | "maxTokens" | "reasoning">> {
	const id = modelId.toLowerCase();

	// Claude family
	if (id.startsWith("claude-")) {
		const isThinking = id.includes("opus") || id.includes("thinking");
		return { contextWindow: 1_000_000, maxTokens: isThinking ? 128_000 : 64_000, reasoning: true };
	}

	// Gemini family
	if (id.startsWith("gemini-")) {
		const isSmall = id.includes("flash-lite") || id.includes("extra-low");
		const isImage = id.includes("flash-image");
		return {
			contextWindow: id.includes("3.5-flash") ? 1_000_000 : 1_048_576,
			maxTokens: isSmall ? 32_768 : 65_536,
			reasoning: !isImage,
		};
	}

	// GPT family (order matters: check more specific first)
	if (id.includes("gpt-5.5")) {
		return { contextWindow: 1_050_000, maxTokens: 128_000, reasoning: true };
	}
	if (id.includes("gpt-5.4-mini") || id.includes("gpt-5.3-codex")) {
		return { contextWindow: 400_000, maxTokens: 128_000, reasoning: true };
	}
	if (id.includes("gpt-5.4")) {
		return { contextWindow: 1_050_000, maxTokens: 128_000, reasoning: true };
	}
	if (id.startsWith("gpt-oss")) {
		return { contextWindow: 128_000, maxTokens: 32_768, reasoning: true };
	}

	// Grok family
	if (id.startsWith("grok-")) {
		return { contextWindow: 256_000, maxTokens: 32_768, reasoning: true };
	}

	// DeepSeek family
	if (id.startsWith("deepseek-") || id.startsWith("deepseek/")) {
		return { contextWindow: 1_000_000, maxTokens: 384_000, reasoning: true };
	}

	// Moonshot family (check BEFORE generic Kimi — more specific)
	if (id.startsWith("moonshotai/")) {
		return { contextWindow: 262_144, maxTokens: 262_144, reasoning: true };
	}

	// Kimi family
	if (id.startsWith("kimi-") || id.includes("/kimi-")) {
		return { contextWindow: 262_144, maxTokens: 32_768, reasoning: true };
	}

	// GLM family
	if (id.startsWith("glm-") || id.includes("/glm-")) {
		return { contextWindow: 1_000_000, maxTokens: 131_072, reasoning: true };
	}

	// MiMo family
	if (id.startsWith("mimo-") || id.includes("/mimo-")) {
		return { contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true };
	}

	// Qwen family
	if (id.startsWith("qwen-") || id.startsWith("qwen3") || id.includes("/qwen")) {
		return { contextWindow: 1_000_000, maxTokens: 64_000, reasoning: true };
	}

	// Gemma family
	if (id.startsWith("gemma-") || id.includes("/gemma-")) {
		return { contextWindow: 262_144, maxTokens: 32_768, reasoning: true };
	}

	// Nemotron family
	if (id.startsWith("nemotron-") || id.includes("/nemotron-")) {
		return { contextWindow: 1_000_000, maxTokens: 65_536, reasoning: true };
	}

	// MiniMax family
	if (id.startsWith("minimax-") || id.includes("/minimax-")) {
		return { contextWindow: 1_000_000, maxTokens: 131_072, reasoning: true };
	}

	// Laguna family
	if (id.startsWith("laguna-") || id.includes("/laguna")) {
		return { contextWindow: 262_144, maxTokens: 32_768, reasoning: true };
	}

	// Google models via OpenRouter
	if (id.startsWith("google/")) {
		return { contextWindow: 262_144, maxTokens: 32_768, reasoning: true };
	}

	// Nvidia models via OpenRouter
	if (id.startsWith("nvidia/")) {
		return { contextWindow: 1_000_000, maxTokens: 65_536, reasoning: true };
	}

	// Poolside models
	if (id.startsWith("poolside/")) {
		return { contextWindow: 262_144, maxTokens: 32_768, reasoning: true };
	}

	// No match — rely on generic defaults
	return {};
}

// ── Step 1d: Provider-specific overrides ──

type ProviderOverride = Partial<
	Pick<ProviderModelConfig, "contextWindow" | "maxTokens" | "reasoning" | "cost">
>;

export const PROVIDER_OVERRIDES: Record<string, Record<string, ProviderOverride>> = {
	"ocode-go (main)": {
		"go-glm-5.2": {
			contextWindow: 1_000_000,
			maxTokens: 131_072,
			reasoning: true,
			cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		},
		"go-glm-5.1": {
			contextWindow: 200_000,
			maxTokens: 128_000,
			reasoning: true,
			cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		},
		"go-kimi-k2.7-code": {
			contextWindow: 262_144,
			maxTokens: 33_000,
			reasoning: true,
			cost: { input: 0.95, output: 4.0, cacheRead: 0.19, cacheWrite: 0 },
		},
		"go-kimi-k2.6": {
			contextWindow: 262_144,
			maxTokens: 16_384,
			reasoning: true,
			cost: { input: 0.95, output: 4.0, cacheRead: 0.16, cacheWrite: 0 },
		},
		"go-deepseek-v4-pro": {
			contextWindow: 1_000_000,
			maxTokens: 384_000,
			reasoning: true,
			cost: { input: 1.74, output: 3.48, cacheRead: 0.0145, cacheWrite: 0 },
		},
		"go-deepseek-v4-flash": {
			contextWindow: 1_000_000,
			maxTokens: 384_000,
			reasoning: true,
			cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
		},
		"go-mimo-v2.5": {
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			reasoning: true,
			cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
		},
		"go-mimo-v2.5-pro": {
			contextWindow: 1_000_000,
			maxTokens: 1_000_000,
			reasoning: true,
			cost: { input: 1.74, output: 3.48, cacheRead: 0.0145, cacheWrite: 0 },
		},
	},
};

// ── Helper: format model name for display ──

function formatModelName(id: string, ownedBy: string): string {
	// Normalize a name part: uppercase first letter and fix known acronyms
	const normalizeWord = (w: string): string => {
		const upper = w.charAt(0).toUpperCase() + w.slice(1);
		// Known multi-letter acronyms that should stay uppercase
		const acronyms: Record<string, string> = {
			Glm: "GLM",
			Mimo: "MiMo",
			Gpt: "GPT",
			Oss: "OSS",
			Kimi: "Kimi",
			Qwen: "Qwen",
			Gemma: "Gemma",
			Grok: "Grok",
			Nemotron: "Nemotron",
			Deepseek: "DeepSeek",
			Moonshotai: "MoonshotAI",
			Laguna: "Laguna",
		};
		return acronyms[upper] ?? upper;
	};

	if (id.startsWith("ocg/go-")) {
		const base = id.slice(7); // remove "ocg/go-"
		const readable = base
			.split("-")
			.map((w) => normalizeWord(w))
			.join(" ")
			.replace(/V(\d+)/gi, "V$1");
		return `${readable} (Go)`;
	}

	if (ownedBy === "antigravity") {
		const readable = id
			.split("-")
			.map((w) => normalizeWord(w))
			.join(" ")
			.replace(/V(\d+)/gi, "V$1");
		return `${readable} (Antigravity)`;
	}

	if (ownedBy === "openai") {
		const readable = id.split("-").map((w) => normalizeWord(w)).join(" ");
		return `${readable} (Codex)`;
	}

	// Pool / OpenRouter models: use slashes as separators, add "(Pool)"
	const readable = id
		.replace(/\//g, " ")
		.split(/[-\s]/)
		.map((w) => normalizeWord(w))
		.join(" ")
		.replace(/:free/gi, " Free")
		.replace(/V(\d+)/gi, "V$1");
	return `${readable} (Pool)`;
}

// ── Step 1c: Enrichment pipeline ──

export function enrichModel(
	entry: CpaModelEntry,
	orMetadata: Map<string, OpenRouterModel>,
): ProviderModelConfig | null {
	const modelId = entry.id;
	const ownedBy = entry.owned_by;

	// ── Filtering: skip duplicate prefixed variants ──
	// Skip or/ prefix — redundant with unprefixed OpenRouter variant
	if (modelId.startsWith("or/")) return null;
	// Skip bare go- prefix without ocg/ — redundant with ocg/go- variant
	if (modelId.startsWith("go-") && !modelId.startsWith("ocg/")) return null;

	// ── Layer 1: Generic fallback ──
	const genericCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let contextWindow = 128_000;
	let maxTokens = 32_768;
	let reasoning = true;
	let cost = { ...genericCost };

	// ── Layer 2: Family-based defaults ──
	const family = familyDefaults(modelId);
	if (family.contextWindow) contextWindow = family.contextWindow;
	if (family.maxTokens) maxTokens = family.maxTokens;
	if (family.reasoning !== undefined) reasoning = family.reasoning;

	// ── Layer 3: OpenRouter API metadata ──
	// Try matching the model ID directly, and also try without the ocg/ prefix
	const orForOcg = modelId.startsWith("ocg/") ? ocgAlias(modelId) : null;
	const orMatch = orMetadata.get(modelId) ?? (orForOcg ? orMetadata.get(orForOcg) : undefined);

	if (orMatch) {
		if (orMatch.context_length > 0) contextWindow = orMatch.context_length;
		if (orMatch.top_provider?.max_completion_tokens) {
			maxTokens = orMatch.top_provider.max_completion_tokens;
		} else if (orMatch.context_length > 0) {
			// Fallback: if no explicit max tokens, use a fraction of context
			maxTokens = Math.min(orMatch.context_length, maxTokens);
		}
		const promptCost = parseOrCost(orMatch.pricing?.prompt ?? "0");
		const completionCost = parseOrCost(orMatch.pricing?.completion ?? "0");
		if (promptCost > 0 || completionCost > 0) {
			cost = { ...genericCost, input: promptCost, output: completionCost };
		}
		if (orMatch.supported_parameters) {
			reasoning = orMatch.supported_parameters.includes("reasoning");
		}
	}

	// ── Layer 4: Provider-specific overrides ──
	const providerOverrides = PROVIDER_OVERRIDES[ownedBy];
	// For Go models, look up by alias (without ocg/ prefix)
	const overrideKey = modelId.startsWith("ocg/") ? ocgAlias(modelId) : modelId;
	const override = providerOverrides?.[overrideKey];

	if (override?.contextWindow) contextWindow = override.contextWindow;
	if (override?.maxTokens) maxTokens = override.maxTokens;
	if (override?.reasoning !== undefined) reasoning = override.reasoning;
	if (override?.cost) {
		cost = {
			...genericCost,
			input: override.cost.input ?? cost.input,
			output: override.cost.output ?? cost.output,
			cacheRead: override.cost.cacheRead ?? cost.cacheRead,
			cacheWrite: override.cost.cacheWrite ?? cost.cacheWrite,
		};
	}

	return {
		id: modelId,
		name: formatModelName(modelId, ownedBy),
		reasoning,
		input: ["text"],
		contextWindow,
		maxTokens,
		cost,
		compat: NO_DEV_ROLE_COMPAT,
	};
}

// ── Static fallback models (CPA down) ──

export const STATIC_FALLBACK_MODELS: ProviderModelConfig[] = [
	// OpenCode Go (8)
	{
		id: "ocg/go-glm-5.2",
		name: "GLM 5.2 (Go)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "ocg/go-glm-5.1",
		name: "GLM 5.1 (Go)",
		reasoning: true,
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 128_000,
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "ocg/go-kimi-k2.7-code",
		name: "Kimi K2.7 Code (Go)",
		reasoning: true,
		input: ["text"],
		contextWindow: 262_144,
		maxTokens: 33_000,
		cost: { input: 0.95, output: 4.0, cacheRead: 0.19, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "ocg/go-kimi-k2.6",
		name: "Kimi K2.6 (Go)",
		reasoning: true,
		input: ["text"],
		contextWindow: 262_144,
		maxTokens: 16_384,
		cost: { input: 0.95, output: 4.0, cacheRead: 0.16, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "ocg/go-deepseek-v4-pro",
		name: "DeepSeek V4 Pro (Go)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		cost: { input: 1.74, output: 3.48, cacheRead: 0.0145, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "ocg/go-deepseek-v4-flash",
		name: "DeepSeek V4 Flash (Go)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "ocg/go-mimo-v2.5",
		name: "MiMo V2.5 (Go)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "ocg/go-mimo-v2.5-pro",
		name: "MiMo V2.5 Pro (Go)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 1_000_000,
		cost: { input: 1.74, output: 3.48, cacheRead: 0.0145, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	// OpenRouter pool (11)
	{
		id: "deepseek/deepseek-v4-flash",
		name: "DeepSeek V4 Flash (Pool)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		cost: { input: 0.1, output: 0.2, cacheRead: 0.02, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "deepseek/deepseek-v4-pro",
		name: "DeepSeek V4 Pro (Pool)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		cost: { input: 0.44, output: 0.87, cacheRead: 0.004, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "google/gemma-4-26b-a4b-it",
		name: "Gemma 4 26B (Pool)",
		reasoning: true,
		input: ["text"],
		contextWindow: 262_144,
		maxTokens: 32_768,
		cost: { input: 0.06, output: 0.33, cacheRead: 0, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "google/gemma-4-31b-it",
		name: "Gemma 4 31B (Pool)",
		reasoning: true,
		input: ["text"],
		contextWindow: 262_144,
		maxTokens: 8_192,
		cost: { input: 0.12, output: 0.36, cacheRead: 0.09, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "moonshotai/kimi-k2.6:free",
		name: "Kimi K2.6 Free (Pool)",
		reasoning: true,
		input: ["text"],
		contextWindow: 262_144,
		maxTokens: 262_144,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "poolside/laguna-m.1:free",
		name: "Laguna M.1 Free (Pool)",
		reasoning: true,
		input: ["text"],
		contextWindow: 262_144,
		maxTokens: 32_768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "google/gemma-4-26b-a4b-it:free",
		name: "Gemma 4 26B Free (Pool)",
		reasoning: true,
		input: ["text"],
		contextWindow: 262_144,
		maxTokens: 32_768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "google/gemma-4-31b-it:free",
		name: "Gemma 4 31B Free (Pool)",
		reasoning: true,
		input: ["text"],
		contextWindow: 262_144,
		maxTokens: 32_768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "nvidia/nemotron-3-super-120b-a12b:free",
		name: "Nemotron 3 Super Free (Pool)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 262_144,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "nvidia/nemotron-3-ultra-550b-a55b:free",
		name: "Nemotron 3 Ultra Free (Pool)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "qwen/qwen3.6-plus-preview:free",
		name: "Qwen 3.6 Plus Preview Free (Pool)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	// Antigravity (11)
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6 (Antigravity)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "claude-opus-4-6-thinking",
		name: "Claude Opus 4.6 Thinking (Antigravity)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "gemini-3.1-pro-low",
		name: "Gemini 3.1 Pro Low (Antigravity)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "gemini-3-flash",
		name: "Gemini 3 Flash (Antigravity)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "gemini-3-flash-agent",
		name: "Gemini 3 Flash Agent (Antigravity)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "gemini-3.1-flash-lite",
		name: "Gemini 3.1 Flash Lite (Antigravity)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "gemini-3.1-flash-image",
		name: "Gemini 3.1 Flash Image (Antigravity)",
		reasoning: false,
		input: ["text"],
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "gemini-3.5-flash-low",
		name: "Gemini 3.5 Flash Low (Antigravity)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "gemini-3.5-flash-extra-low",
		name: "Gemini 3.5 Flash Extra Low (Antigravity)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 32_768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "gemini-pro-agent",
		name: "Gemini Pro Agent (Antigravity)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
	{
		id: "gpt-oss-120b-medium",
		name: "GPT-OSS 120B Medium (Antigravity)",
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 32_768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: NO_DEV_ROLE_COMPAT,
	},
];

// ── Step 1e: Build provider config ──

export async function buildCpaModels(
	baseUrl: string,
	apiKey: string,
): Promise<ProviderModelConfig[]> {
	// 1. Fetch CPA model IDs
	const entries = await fetchCpaModelIds(baseUrl, apiKey);

	// 2. If CPA down, return static fallback
	if (entries.length === 0) {
		return STATIC_FALLBACK_MODELS;
	}

	// 3. Fetch OpenRouter metadata
	const orMetadata = await fetchOpenRouterMetadata();

	// 4. Enrich each entry
	const models: ProviderModelConfig[] = [];
	for (const entry of entries) {
		const model = enrichModel(entry, orMetadata);
		if (model) models.push(model);
	}

	// 5. If all enrichment failed, return static fallback
	if (models.length === 0) {
		return STATIC_FALLBACK_MODELS;
	}

	return models;
}
