/**
 * CPA (CLIProxyAPI) model enrichment engine.
 *
 * Dynamically discovers models from CPA's `/v1/models` endpoint and enriches
 * them with metadata via a 4-layer fallback chain:
 *   1. Generic defaults (128K ctx, 32K out, $0)
 *   2. Family-based defaults (detected from model ID prefix)
 *   3. Static fallback (image-capable model ids)
 *   4. models.dev catalog metadata (exact reference lookup, shared with the
 *      rest of the harness — no OpenRouter endpoint is consulted)
 *   5. Provider-specific overrides (pricing for API-key providers)
 *
 * No model is ever skipped due to unknown owned_by — new providers added
 * to CPA appear automatically with family-based defaults.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ModelsDevCatalog } from "../../_shared/models-dev/catalog";
import { getModelsDevCatalog } from "../../_shared/models-dev/catalog";
import { resolveCpaModelsDevRefs } from "../../_shared/models-dev/mapping";
import { loadAiProvidersConfig } from "../config.ts";
import { OVERRIDE_TABLES } from "../constants/cpa-overrides";
import {
    STATIC_FALLBACK_MODELS,
    NO_DEV_ROLE_COMPAT,
} from "../constants/cpa-static-models";

// ── Types ──

export interface CpaModelEntry {
    id: string;
    owned_by: string;
}

export interface CpaCatalogResult {
    models: ProviderModelConfig[];
    source: "live" | "fallback";
}

/**
 * The only catalog surface enrichment needs: exact reference lookup.
 * Injected by callers so tests stay deterministic; production defaults to
 * {@link getModelsDevCatalog}.
 */
export type CpaCatalogLookup = Pick<ModelsDevCatalog, "lookupFirst">;

// ── Static image support map (for non-OpenRouter models) ──
// These model IDs are known to support image input through CPA.
// OpenRouter models are checked dynamically via architecture.input_modalities.
export const STATIC_IMAGE_MODELS = new Set<string>([
    // Antigravity — Claude models (vision)
    "claude-sonnet-4-6",
    "claude-opus-4-6-thinking",
    // Antigravity — Gemini models (multimodal by default)
    "gemini-3.1-flash-image",
    "gemini-3.1-flash-lite",
    "gemini-3.1-pro-preview",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
    "gemini-3-flash-preview",
    // Codex — GPT models (vision)
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.5",
    // OpenCode Go — models with confirmed vision support
    "ocg/go-kimi-k2.7-code",
    "ocg/go-kimi-k2.6",
    "ocg/go-deepseek-v4-pro",
    "ocg/go-deepseek-v4-flash",
]);

// ── Step 1a: Fetch model IDs from CPA ──

export async function fetchCpaModelIds(
    baseUrl: string,
    apiKey: string,
): Promise<CpaModelEntry[]> {
    const controller = new AbortController();
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- typeAware lint resolves setTimeout as `any`; the handle is opaque and only passed back to clearTimeout.
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
        const url = `${baseUrl.replace(/\/$/, "")}/models`;
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: controller.signal,
        });

        if (!response.ok) {
            console.warn(
                `[cpa-models] CPA /v1/models returned ${response.status}`,
            );
            return [];
        }

        // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- response.json() returns any; the payload shape is validated below.
        const json = (await response.json()) as {
            data?: Array<{
                id?: string;
                created?: number;
                object?: string;
                owned_by?: string;
            }>;
        };
        if (!json.data || !Array.isArray(json.data)) {
            console.warn("[cpa-models] Unexpected /v1/models response shape");
            return [];
        }

        return json.data.map((m) => ({
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

// ── Step 1c: Family-based defaults ──

export function familyDefaults(
    modelId: string,
): Partial<
    Pick<ProviderModelConfig, "contextWindow" | "maxTokens" | "reasoning">
> {
    const id = modelId.toLowerCase();

    // Normalize ocg/go- prefixed models to their base family name
    if (id.startsWith("ocg/go-")) {
        return familyDefaults(id.slice(7));
    }

    // Claude family
    if (id.startsWith("claude-")) {
        const isThinking = id.includes("opus") || id.includes("thinking");
        return {
            contextWindow: 1_000_000,
            maxTokens: isThinking ? 128_000 : 64_000,
            reasoning: true,
        };
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
    // GPT-5.5 in Codex (subscription) is capped at 400K total (272K input + 128K output).
    // The API version supports 1M, but Codex is still limited upstream.
    // See: https://github.com/openai/codex/issues/19464
    if (id.includes("gpt-5.5")) {
        return { contextWindow: 272_000, maxTokens: 128_000, reasoning: true };
    }
    if (id.includes("gpt-5.4-mini") || id.includes("gpt-5.3-codex")) {
        return { contextWindow: 400_000, maxTokens: 128_000, reasoning: true };
    }
    // GPT-5.4 in Codex allows up to 1M context via model_context_window.
    if (id.includes("gpt-5.4")) {
        return {
            contextWindow: 1_000_000,
            maxTokens: 128_000,
            reasoning: true,
        };
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
        return {
            contextWindow: 1_000_000,
            maxTokens: 384_000,
            reasoning: true,
        };
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
        return {
            contextWindow: 1_000_000,
            maxTokens: 131_072,
            reasoning: true,
        };
    }

    // MiMo family
    if (id.startsWith("mimo-") || id.includes("/mimo-")) {
        return {
            contextWindow: 1_000_000,
            maxTokens: 128_000,
            reasoning: true,
        };
    }

    // Qwen family
    if (
        id.startsWith("qwen-") ||
        id.startsWith("qwen3") ||
        id.includes("/qwen")
    ) {
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
        return {
            contextWindow: 1_000_000,
            maxTokens: 131_072,
            reasoning: true,
        };
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
        const readable = id
            .split("-")
            .map((w) => normalizeWord(w))
            .join(" ");
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
    catalog: CpaCatalogLookup,
    overridePrefixes: Record<string, string> = loadAiProvidersConfig().cpa
        .overridePrefixes ?? { ocg: "go" },
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

    // ── Layer 3: Static fallback (image-capable model ids) ──
    let input: Array<"text" | "image"> = ["text"];
    if (STATIC_IMAGE_MODELS.has(modelId)) {
        input = ["text", "image"];
    }

    // ── Layer 4: models.dev catalog metadata (exact reference lookup) ──
    // The shared mapping resolves this entry to ordered exact refs (provider
    // scope first, base scope for Antigravity aliases); the first match wins.
    // Fields are applied one-by-one with `!== undefined` so an explicit zero
    // (a real free-tier price) is honored while absent fields keep the
    // generic/family/static fallback values.
    const refs = resolveCpaModelsDevRefs(modelId, ownedBy);
    const match = refs.length > 0 ? catalog.lookupFirst(refs) : undefined;
    if (match) {
        const m = match.model;
        if (m.contextWindow !== undefined) contextWindow = m.contextWindow;
        if (m.maxTokens !== undefined) maxTokens = m.maxTokens;
        if (m.reasoning !== undefined) reasoning = m.reasoning;
        if (m.cost) {
            if (m.cost.input !== undefined) cost.input = m.cost.input;
            if (m.cost.output !== undefined) cost.output = m.cost.output;
            if (m.cost.cacheRead !== undefined)
                cost.cacheRead = m.cost.cacheRead;
            if (m.cost.cacheWrite !== undefined)
                cost.cacheWrite = m.cost.cacheWrite;
        }
        // Pi input always contains text; add image only for the exact
        // normalized "image" modality from the catalog record.
        if (m.inputModalities?.includes("image")) {
            input = ["text", "image"];
        }
    }

    // ── Layer 5: Prefix-driven alias overrides ──
    // Config-gated: `overridePrefixes` maps a model-id prefix to an
    // OVERRIDE_TABLES key (default { ocg: "go" }). Dispatches on the
    // model-id prefix instead of the provider display name, so adding or
    // renaming a provider in cliproxy needs no code change here — only a
    // config entry pointing at the right table. Overrides apply last and win
    // over conflicting catalog values; missing override fields preserve the
    // catalog/fallback values.
    const slashIdx = modelId.indexOf("/");
    const prefix = slashIdx > 0 ? modelId.slice(0, slashIdx) : null;
    const tableName = prefix ? overridePrefixes[prefix] : undefined;
    const aliasKey = tableName ? modelId.slice(slashIdx + 1) : null;
    const override =
        tableName && aliasKey
            ? OVERRIDE_TABLES[tableName]?.[aliasKey]
            : undefined;

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
        input,
        contextWindow,
        maxTokens,
        cost,
        compat: NO_DEV_ROLE_COMPAT,
    };
}

// ── Step 1e: Build provider config ──

export interface BuildCpaModelsOptions {
    /**
     * Catalog used for enrichment. Defaults to the process-wide
     * {@link getModelsDevCatalog} — lookupFirst is snapshot-only, so the
     * default catalog never triggers a network request from this function.
     */
    catalog?: CpaCatalogLookup;
}

export async function buildCpaModels(
    baseUrl: string,
    apiKey: string,
    options?: BuildCpaModelsOptions,
): Promise<CpaCatalogResult> {
    // 1. Fetch CPA model IDs (the only external request this function makes)
    const entries = await fetchCpaModelIds(baseUrl, apiKey);

    // 2. If CPA down, return static fallback
    if (entries.length === 0) {
        return { models: STATIC_FALLBACK_MODELS, source: "fallback" };
    }

    // 3. Enrich each entry against the shared catalog (in-memory lookup)
    const catalog = options?.catalog ?? getModelsDevCatalog();
    const models: ProviderModelConfig[] = [];
    for (const entry of entries) {
        const model = enrichModel(entry, catalog);
        if (model) models.push(model);
    }

    // 4. If all enrichment failed, return static fallback
    if (models.length === 0) {
        return { models: STATIC_FALLBACK_MODELS, source: "fallback" };
    }

    return { models, source: "live" };
}
