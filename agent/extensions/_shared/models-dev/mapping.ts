import type { ModelsDevRef } from "./catalog";

/**
 * Exact model-reference adapters.
 *
 * These functions translate harness-visible model identities — CPA catalog
 * entries, @factory/droid-sdk entries, and persisted session provider/model
 * keys — into exact models.dev references (see {@link ModelsDevRef}) that
 * {@link ModelsDevCatalog.lookupFirst} can resolve.
 *
 * CPA client ids are *derived*, never tabulated. A CPA client id is a vendor
 * model id wrapped in route markers that CPA's own configuration adds (group
 * prefixes such as `ocg/`, alias markers such as `go-`/`zcoding-`/`-agy`,
 * and reasoning-budget suffixes). Those markers are stripped deterministically
 * and the remaining family prefix selects the vendor, so a newly exposed model
 * is enriched without editing this module. Explicit per-model overrides belong
 * in `agent/config/ai-providers.json`, not here.
 *
 * Derivation never weakens matching: every emitted reference is still exact,
 * so a wrongly derived id simply fails to resolve instead of borrowing another
 * model's metadata. Matching stays anchored `startsWith`/`endsWith` plus exact
 * lookups — no fuzzy matching. An empty result means "unmapped".
 */

function providerRef(providerId: string, modelId: string): ModelsDevRef {
    return { scope: "provider", providerId, modelId };
}

function baseRef(modelId: string): ModelsDevRef {
    return { scope: "model", modelId };
}

/**
 * Family prefix to models.dev vendor. A CPA client id always carries its
 * vendor in the family prefix, so the vendor is derived rather than listed
 * per model. Ordered longest-first so `gpt-oss-` wins over `gpt-`.
 */
const VENDOR_FAMILIES: ReadonlyArray<readonly [string, string]> = [
    ["gemini-", "google"],
    ["gemma-", "google"],
    ["claude-", "anthropic"],
    ["gpt-oss-", "openai"],
    ["gpt-", "openai"],
];

/**
 * models.dev separates version components per vendor: anthropic ids are
 * dash-separated (`claude-opus-4-6`) while google and openai keep dots
 * (`gemini-3.8-flash`). CPA aliases use dots throughout.
 */
const DASH_VERSION_VENDORS: ReadonlySet<string> = new Set(["anthropic"]);

/**
 * Reasoning-budget segments CPA appends to a route id. models.dev records the
 * base route, so a budget-suffixed id is retried without its suffix. Kept
 * deliberately narrow: `-lite`, `-pro`, `-flash` and `-preview` are real
 * model names, not budgets.
 */
const BUDGET_SUFFIXES: readonly string[] = [
    "-thinking",
    "-extra-low",
    "-minimal",
    "-xhigh",
    "-medium",
    "-high",
    "-low",
];

/** CPA-local vendor marker with no models.dev counterpart. */
const CPA_VENDOR_MARKER_SUFFIX = "-agy";

/** Alias markers CPA prepends to a route id inside a provider group. */
const CPA_ALIAS_MARKER_PREFIXES: readonly string[] = ["go-", "zcoding-"];

/** Factory-owned model ids that map onto exact models.dev base records. */
const FACTORY_OWNED_BASES: Readonly<Record<string, string>> = {
    "glm-5.2": "zhipuai/glm-5.2",
    "glm-5.1": "zhipuai/glm-5.1",
    "kimi-k2.7-code": "moonshotai/kimi-k2.7-code",
    "kimi-k2.6": "moonshotai/kimi-k2.6",
    "kimi-k2.5": "moonshotai/kimi-k2.5",
    "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
};

/** Exact route identities observed in persisted historical Factory usage. */
const FACTORY_HISTORICAL_REFS: Readonly<
    Record<string, readonly ModelsDevRef[]>
> = {
    "deepseek/deepseek-v4-pro": [baseRef("deepseek/deepseek-v4-pro")],
    "deepseek/deepseek-v4-flash": [baseRef("deepseek/deepseek-v4-flash")],
    "gpt-5.5": [providerRef("openai", "gpt-5.5")],
    "gemini-3-flash-preview": [providerRef("google", "gemini-3-flash-preview")],
    "google/gemma-4-31b-it:free": [
        providerRef("openrouter", "google/gemma-4-31b-it:free"),
    ],
    "qwen/qwen3.6-plus-preview:free": [
        providerRef("openrouter", "qwen/qwen3.6-plus-preview:free"),
    ],
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

/** Exact OpenRouter ref; always includes a base fallback for field-by-field merge. */
function openRouterRefs(modelId: string): ModelsDevRef[] {
    return [providerRef("openrouter", modelId), baseRef(modelId)];
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
 * Strip the alias marker CPA prepends to a route id inside a provider group
 * (`go-deepseek-v4-flash`, `zcoding-glm-4.7`). Returns the id unchanged when
 * it carries no marker, and undefined when stripping would empty it.
 */
function stripAliasMarker(modelId: string): string | undefined {
    for (const marker of CPA_ALIAS_MARKER_PREFIXES) {
        if (!modelId.startsWith(marker)) continue;
        const rest = modelId.slice(marker.length);
        return isEmptyId(rest) ? undefined : rest;
    }
    return modelId;
}

/** Provider-scoped refs for a CPA group whose ids are plain route ids. */
function groupRefs(
    providerId: string,
    modelId: string | undefined,
): ModelsDevRef[] {
    if (modelId === undefined) return [];
    const route = stripAliasMarker(modelId);
    return route === undefined ? [] : [providerRef(providerId, route)];
}

/** Vendor+base refs, the shape every vendor-scoped branch of this module emits. */
function vendorRefs(vendorId: string, modelId: string): ModelsDevRef[] {
    return [providerRef(vendorId, modelId), baseRef(`${vendorId}/${modelId}`)];
}

/**
 * Normalize version separators to the convention the vendor uses on
 * models.dev. Only the separators between digits are touched, so a family
 * name such as `flash-lite` is never altered.
 */
function normalizeVendorVersion(vendorId: string, modelId: string): string {
    return DASH_VERSION_VENDORS.has(vendorId)
        ? modelId.replace(/(\d)\.(\d)/g, "$1-$2")
        : modelId;
}

/** Drop one trailing reasoning-budget segment, if the id carries one. */
function stripBudgetSuffix(modelId: string): string | undefined {
    for (const suffix of BUDGET_SUFFIXES) {
        if (!modelId.endsWith(suffix)) continue;
        const rest = modelId.slice(0, -suffix.length);
        return isEmptyId(rest) ? undefined : rest;
    }
    return undefined;
}

/**
 * Derive vendor-scoped references from a CPA client id by stripping the route
 * markers CPA adds and reading the vendor from the family prefix.
 *
 * The exact id is always tried before the budget-stripped one, so a vendor
 * that does publish a per-budget record still wins. An id outside every known
 * family yields no references.
 */
function deriveVendorRefs(modelId: string): ModelsDevRef[] {
    const withoutMarker = modelId.endsWith(CPA_VENDOR_MARKER_SUFFIX)
        ? modelId.slice(0, -CPA_VENDOR_MARKER_SUFFIX.length)
        : modelId;
    if (isEmptyId(withoutMarker)) return [];

    const family = VENDOR_FAMILIES.find(([prefix]) =>
        withoutMarker.startsWith(prefix),
    );
    if (!family) return [];
    const vendorId = family[1];

    const exact = normalizeVendorVersion(vendorId, withoutMarker);
    const refs = vendorRefs(vendorId, exact);

    const withoutBudget = stripBudgetSuffix(exact);
    if (withoutBudget !== undefined) {
        refs.push(...vendorRefs(vendorId, withoutBudget));
    }
    return refs;
}

/**
 * CPA prefix/alias rules without `owned_by` information. Shared between the
 * CPA adapter and the persisted-usage adapter so the two cannot drift.
 */
function resolveCpaLikeRefs(modelId: string): ModelsDevRef[] {
    if (isEmptyId(modelId)) return [];

    // A bare `go-` id is the unprefixed alias of the same route in two
    // different groups, so without `owned_by` the group behind it is
    // unknowable and it stays unmapped here; the live adapter resolves it
    // from the owner instead. `or/`, by contrast, belongs to exactly one
    // group, so it strips like every other group prefix.
    if (modelId.startsWith("or/")) {
        const rest = slicePrefix(modelId, "or/");
        if (rest === undefined || !rest.includes("/")) return [];
        return [providerRef("openrouter", rest), baseRef(rest)];
    }
    if (modelId.startsWith("go-")) return [];

    const ocgRest = slicePrefix(modelId, "ocg/");
    if (ocgRest !== undefined) return groupRefs("opencode-go", ocgRest);
    // A recognized CPA prefix with an empty suffix is malformed: it must not
    // fall through to the OpenRouter slash path below.
    if (modelId.startsWith("ocg/")) return [];

    const zaiRest = slicePrefix(modelId, "zai-coding/");
    if (zaiRest !== undefined) return groupRefs("zai-coding-plan", zaiRest);
    if (modelId.startsWith("zai-coding/")) return [];

    const oczRest = slicePrefix(modelId, "ocz/");
    if (oczRest !== undefined) return groupRefs("opencode", oczRest);
    if (modelId.startsWith("ocz/")) return [];

    // A `zcoding-` id outside its group prefix is still a Z.ai coding route.
    if (modelId.startsWith("zcoding-")) {
        return groupRefs("zai-coding-plan", modelId);
    }

    if (modelId.includes("/")) return openRouterRefs(modelId);

    return deriveVendorRefs(modelId);
}

/**
 * Resolve a CPA catalog model entry to ordered exact references, most
 * specific first. An empty result means the entry is unmapped.
 */
export function resolveCpaModelsDevRefs(
    modelId: string,
    ownedBy?: string,
): ModelsDevRef[] {
    if (isEmptyId(modelId)) return [];

    // Group-scoped owners: the id is a route id behind an optional group
    // prefix and an optional alias marker. A bare id (no group prefix) is
    // still that group's route, because the owner identifies the group.
    if (ownedBy?.startsWith("ocode-go")) {
        const rest = modelId.startsWith("ocg/")
            ? slicePrefix(modelId, "ocg/")
            : modelId;
        return dedupeRefs(groupRefs("opencode-go", rest));
    }
    if (ownedBy?.startsWith("ocode-zen")) {
        const rest = modelId.startsWith("ocz/")
            ? slicePrefix(modelId, "ocz/")
            : modelId;
        return dedupeRefs(groupRefs("opencode", rest));
    }
    if (ownedBy === "z.ai (coding)") {
        const rest = modelId.startsWith("zai-coding/")
            ? slicePrefix(modelId, "zai-coding/")
            : modelId;
        return dedupeRefs(groupRefs("zai-coding-plan", rest));
    }
    if (ownedBy === "openrouter") {
        // `or/` is this group's own prefix, so it strips to the pool id.
        const rest = modelId.startsWith("or/")
            ? slicePrefix(modelId, "or/")
            : modelId;
        return rest !== undefined && rest.includes("/")
            ? [providerRef("openrouter", rest), baseRef(rest)]
            : [];
    }
    if (ownedBy === "openai") {
        // CPA reports this owner for its Codex routes, including ids that are
        // not OpenAI models at all, so the derived refs stay exact and simply
        // fail to resolve for those.
        return modelId === "codex-auto-review"
            ? []
            : dedupeRefs([
                  providerRef("openai", modelId),
                  baseRef(`openai/${modelId}`),
                  ...deriveVendorRefs(modelId),
              ]);
    }

    // Antigravity, an owner this adapter does not know about, and a missing
    // owner all fall through to the shared prefix/alias rules, which end in
    // vendor derivation. A new CPA client group is therefore enriched without
    // editing this module.
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
        return [
            providerRef(modelProvider, modelId),
            baseRef(`${modelProvider}/${modelId}`),
        ];
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
            return [
                providerRef(providerId, modelId),
                baseRef(modelId), // modelId already IS the base ref (e.g. "deepseek/deepseek-v4-flash")
            ];
        case "openai":
        case "anthropic":
        case "google":
            return [
                providerRef(providerId, modelId),
                baseRef(`${providerId}/${modelId}`),
            ];
        case "cpa":
            return dedupeRefs(resolveCpaLikeRefs(modelId));
        case "factory-ai": {
            const historicalRefs = FACTORY_HISTORICAL_REFS[modelId];
            return historicalRefs
                ? [...historicalRefs]
                : resolveFactoryOwnedBases(modelId);
        }
        case "openai-codex":
            return [providerRef("openai", modelId)];
        case "opencode-go":
            return [providerRef("opencode-go", modelId)];
        case "zai":
            return [providerRef("zai", modelId)];
        case "or":
            return [providerRef("openrouter", modelId)];
        default:
            return [];
    }
}
