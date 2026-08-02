import type { ModelsDevRef } from "./catalog";

/**
 * Exact model-reference adapters.
 *
 * These functions translate harness-visible model identities — CPA catalog
 * entries, @factory/droid-sdk entries, and persisted session provider/model
 * keys — into exact models.dev references (see {@link ModelsDevRef}) that
 * {@link ModelsDevCatalog.lookupFirst} can resolve. Every table is immutable
 * and intentional: no fuzzy matching, only anchored `startsWith`/`endsWith`
 * prefix handling and exact lookups. An empty result means "unmapped".
 */

function providerRef(providerId: string, modelId: string): ModelsDevRef {
    return { scope: "provider", providerId, modelId };
}

function baseRef(modelId: string): ModelsDevRef {
    return { scope: "model", modelId };
}

/** Antigravity aliases exposed by the CPA catalog, mapped to exact base ids. */
const ANTIGRAVITY_ALIASES: Readonly<Record<string, string>> = {
    "claude-opus-4-6-thinking": "anthropic/claude-opus-4-6",
    "claude-sonnet-4-6": "anthropic/claude-sonnet-4-6",
    "gemini-3.1-flash-image": "google/gemini-3.1-flash-image",
    "gemini-3.1-flash-lite": "google/gemini-3.1-flash-lite",
    "gemini-3.1-pro-preview": "google/gemini-3.1-pro-preview",
    "gemini-3.5-flash": "google/gemini-3.5-flash",
    "gemini-3.6-flash": "google/gemini-3.6-flash",
    "gemini-3-flash-preview": "google/gemini-3-flash-preview",
    "gpt-oss-120b-medium": "openai/gpt-oss-120b",
};

/** Bare CPA ids retained for historical usage records that lack `owned_by`. */
const CPA_OPENAI_MODEL_IDS: ReadonlySet<string> = new Set([
    "gpt-5.3-codex-spark",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.5",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-image-1.5",
    "gpt-image-2",
]);

const CPA_ZAI_MODEL_IDS: ReadonlySet<string> = new Set([
    "glm-4.7",
    "glm-5-turbo",
    "glm-5.2",
]);

/** Factory-owned model ids that map onto exact models.dev base records. */
const FACTORY_OWNED_BASES: Readonly<Record<string, string>> = {
    "glm-5.2": "zhipuai/glm-5.2",
    "glm-5.1": "zhipuai/glm-5.1",
    "kimi-k2.7-code": "moonshotai/kimi-k2.7-code",
    "kimi-k2.6": "moonshotai/kimi-k2.6",
    "kimi-k2.5": "moonshotai/kimi-k2.5",
    "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
};

/**
 * SDK model-provider strings verified against @factory/droid-sdk's
 * `ModelProvider` enum. `_shared` stays independent from the SDK itself;
 * these literals are the only coupling.
 */
const EXACT_FACTORY_PROVIDERS: ReadonlySet<string> = new Set([
    "anthropic",
    "openai",
    "google",
]);
const FACTORY_SDK_PROVIDER = "factory";

function isEmptyId(id: string): boolean {
    return id.trim().length === 0;
}

/**
 * Slice `prefix` off `id` only when a non-empty suffix remains; otherwise
 * return undefined so callers can treat the input as unmapped. Prevents
 * malformed ids like `ocg/go-` from yielding refs with empty model ids.
 */
function slicePrefix(id: string, prefix: string): string | undefined {
    if (!id.startsWith(prefix)) return undefined;
    const rest = id.slice(prefix.length);
    return isEmptyId(rest) ? undefined : rest;
}

/** Exact OpenRouter ref; free routes never inherit paid-route metadata. */
function openRouterRefs(modelId: string): ModelsDevRef[] {
    return [providerRef("openrouter", modelId)];
}

/** Keep the first occurrence of identical refs while preserving order. */
function dedupeRefs(refs: readonly ModelsDevRef[]): ModelsDevRef[] {
    const seen = new Set<string>();
    const deduped: ModelsDevRef[] = [];
    for (const ref of refs) {
        const key =
            ref.scope === "provider"
                ? `p:${ref.providerId}/${ref.modelId}`
                : `m:${ref.modelId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(ref);
    }
    return deduped;
}

/**
 * CPA prefix/alias rules without `owned_by` information. Shared between the
 * CPA adapter and the persisted-usage adapter so the two cannot drift.
 */
function resolveCpaLikeRefs(modelId: string): ModelsDevRef[] {
    if (isEmptyId(modelId)) return [];

    // `or/` pool aliases and bare `go-` duplicates of `ocg/go-` ids never map.
    if (modelId.startsWith("or/")) return [];
    if (modelId.startsWith("go-")) return [];

    const ocgRest = slicePrefix(modelId, "ocg/go-");
    if (ocgRest !== undefined) {
        return [providerRef("opencode-go", ocgRest)];
    }
    // A recognized CPA prefix with an empty suffix is malformed: it must not
    // fall through to the OpenRouter slash path below.
    if (modelId.startsWith("ocg/")) return [];

    const antigravityBase = ANTIGRAVITY_ALIASES[modelId];
    if (antigravityBase) return [baseRef(antigravityBase)];

    const zaiRest = slicePrefix(modelId, "zai-coding/");
    if (zaiRest !== undefined) {
        return [providerRef("zai-coding-plan", zaiRest)];
    }
    if (modelId.startsWith("zai-coding/")) return [];

    if (CPA_ZAI_MODEL_IDS.has(modelId)) {
        return [providerRef("zai-coding-plan", modelId)];
    }

    const oczRest = slicePrefix(modelId, "ocz/");
    if (oczRest !== undefined) {
        return [providerRef("opencode", oczRest)];
    }
    if (modelId.startsWith("ocz/")) return [];

    if (modelId.includes("/")) return openRouterRefs(modelId);

    return CPA_OPENAI_MODEL_IDS.has(modelId)
        ? [providerRef("openai", modelId)]
        : [];
}

/**
 * Resolve a CPA catalog model entry to ordered exact references, most
 * specific first. An empty result means the entry is unmapped.
 */
export function resolveCpaModelsDevRefs(
    modelId: string,
    ownedBy?: string,
): ModelsDevRef[] {
    // OpenCode Go entries are owned by `ocode-go`; only `ocg/go-` ids map,
    // bare `go-` duplicates stay unmapped. Malformed `ocg/go-` ids with an
    // empty suffix also stay unmapped.
    if (ownedBy?.startsWith("ocode-go")) {
        const ocgRest = slicePrefix(modelId, "ocg/go-");
        if (ocgRest !== undefined) {
            return [providerRef("opencode-go", ocgRest)];
        }
        return [];
    }
    if (ownedBy?.startsWith("ocode-zen")) {
        const model = slicePrefix(modelId, "ocz/");
        return model === undefined ? [] : [providerRef("opencode", model)];
    }
    if (ownedBy === "openrouter") {
        return modelId.includes("/")
            ? [providerRef("openrouter", modelId)]
            : [];
    }
    if (ownedBy === "openai") {
        return modelId === "codex-auto-review" || isEmptyId(modelId)
            ? []
            : [providerRef("openai", modelId)];
    }
    if (ownedBy === "z.ai (coding)") {
        const model = slicePrefix(modelId, "zai-coding/") ?? modelId;
        return isEmptyId(model) ? [] : [providerRef("zai-coding-plan", model)];
    }
    if (ownedBy === "antigravity") {
        const base = ANTIGRAVITY_ALIASES[modelId];
        return base ? [baseRef(base)] : [];
    }
    if (ownedBy !== undefined) return [];
    return dedupeRefs(resolveCpaLikeRefs(modelId));
}

/**
 * Resolve a @factory/droid-sdk model entry to ordered exact references.
 * `anthropic`, `openai`, and `google` pass through exactly; the factory's own
 * models map through {@link FACTORY_OWNED_BASES}; everything else is unmapped.
 */
export function resolveFactoryModelsDevRefs(
    modelProvider: string,
    modelId: string,
): ModelsDevRef[] {
    if (isEmptyId(modelId)) return [];

    if (EXACT_FACTORY_PROVIDERS.has(modelProvider)) {
        return [providerRef(modelProvider, modelId)];
    }

    if (modelProvider === FACTORY_SDK_PROVIDER) {
        return resolveFactoryOwnedBases(modelId);
    }

    return [];
}

/** Factory-owned base lookup, shared with the persisted-usage adapter. */
function resolveFactoryOwnedBases(modelId: string): ModelsDevRef[] {
    const base = FACTORY_OWNED_BASES[modelId];
    return base ? [baseRef(base)] : [];
}

/**
 * Resolve a persisted session provider/model key to ordered exact
 * references. Ordinary providers pass through; `cpa` and `factory-ai`
 * delegate to the shared prefix/alias and factory-owned tables because stored
 * sessions lack `owned_by`/SDK provider information.
 */
export function resolveUsageModelsDevRefs(
    providerId: string,
    modelId: string,
): ModelsDevRef[] {
    if (isEmptyId(providerId) || isEmptyId(modelId)) return [];

    switch (providerId) {
        case "openrouter":
        case "openai":
        case "anthropic":
        case "google":
            return [providerRef(providerId, modelId)];
        case "cpa":
            return dedupeRefs(resolveCpaLikeRefs(modelId));
        case "factory-ai":
            return resolveFactoryOwnedBases(modelId);
        default:
            return [];
    }
}
