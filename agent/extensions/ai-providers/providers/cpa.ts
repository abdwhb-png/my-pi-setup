/**
 * CLIProxyAPI (CPA) provider for Pi.
 *
 * Registers CPA as a central model router via the ai-providers extension.
 * Models are dynamically discovered from CPA's `/v1/models` endpoint and
 * enriched with metadata via the cpa-models enrichment engine.
 *
 * Two-phase registration:
 *   1. Static fallback models registered synchronously at extension load
 *   2. Dynamic enriched models replace them on session_start
 *
 * CPA is an OpenAI-compatible proxy — the built-in `openai-completions`
 * streamSimple handles all streaming. No custom streamSimple needed.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getModelsDevCatalog } from "../../_shared/models-dev/catalog";
import { createUiColors } from "../../_shared/ui/ui-colors.ts";
import { loadAiProvidersConfig } from "../config.ts";
import { STATIC_FALLBACK_MODELS } from "../constants/cpa-static-models";
import type { CatalogDiffCounts } from "./catalog-diff.ts";
import { reportCatalogDiff } from "./catalog-diff.ts";
import { createCpaCatalogCache } from "./cpa-catalog-cache.ts";
import { createCpaCatalogGuard } from "./cpa-catalog-guard.ts";
import { buildCpaModels, enrichModel } from "./cpa-models.ts";
import type { CpaCatalogLookup, CpaModelEntry } from "./cpa-models.ts";

// ── Constants ──

const PROVIDER_NAME = "cpa";
const PROVIDER_DISPLAY = "CLIProxyAPI (local)";
const PROVIDER_BASE_URL = "http://localhost:8317/v1";
const PROVIDER_API = "openai-completions" as const;

// ── Lifecycle event context shape ──

export type LifecycleCtx = Parameters<Parameters<ExtensionAPI["on"]>[1]>[1];

/**
 * Handle returned by {@link registerCpaProvider}.
 *
 * `refreshProjection` performs the same forced catalog refresh the
 * `/cpa-refresh` command runs: reloads live models through the catalog
 * guard, re-registers the provider projection, and reports stale/unverified
 * states to the user.
 */
export interface CpaProviderHandle {
    providerId: "cpa";
    refreshProjection(
        ctx: LifecycleCtx,
        options?: { force?: boolean },
    ): Promise<void>;
    refreshStartupProjection(ctx: LifecycleCtx): Promise<void>;
}

/**
 * Plain console.warn sink used at startup. Counts are emitted as a single
 * summary line (no theme available during synchronous registration).
 */
const consoleDriftSink = (counts: CatalogDiffCounts): void => {
    console.warn(
        `[cpa] Catalog drift: ${counts.newCount} new model(s), ${counts.missingFallbackCount} missing fallback(s)`,
    );
};

/**
 * Themed runtime sink. Builds a colored TUI notification with `createUiColors`
 * lazily — colors are only resolved when drift actually flows, so callers
 * that never drift pay no theme-lookup cost and headless runs never touch
 * `ctx.ui.theme`.
 *   - new models highlighted as "primary"
 *   - missing fallbacks highlighted as "warning"
 * Falls back to {@link consoleDriftSink} when the UI is unavailable (headless).
 */
function themedDriftSink(
    ctx: LifecycleCtx,
): (counts: CatalogDiffCounts) => void {
    if (!ctx.hasUI || !ctx.ui.theme) {
        return consoleDriftSink;
    }
    return (counts) => {
        const theme = ctx.ui.theme;
        if (!theme) {
            consoleDriftSink(counts);
            return;
        }
        const colors = createUiColors(theme);
        const parts: string[] = [];
        if (counts.newCount > 0) {
            parts.push(colors.primary(`${counts.newCount} new model(s)`));
        }
        if (counts.missingFallbackCount > 0) {
            parts.push(
                colors.warning(
                    `${counts.missingFallbackCount} missing fallback(s)`,
                ),
            );
        }
        ctx.ui.notify(
            `${colors.model("[cpa]")} ${parts.join(colors.separator(" · "))}`,
            "info",
        );
    };
}

// ── Helper to resolve the API Key dynamically from .env ──

/**
 * Resolve the CLIProxyAPI key.
 * Checks process.env first, then falls back to reading the ~/.pi/agent/.env file.
 */
export function getCliproxyApiKey(): string {
    if (process.env.CLIPROXY_API_KEY) {
        return process.env.CLIPROXY_API_KEY.replace(/^["']|["']$/g, "");
    }
    const envPath = join(getAgentDir(), ".env");
    if (existsSync(envPath)) {
        try {
            const content = readFileSync(envPath, "utf-8");
            for (const line of content.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (trimmed.startsWith("CLIPROXY_API_KEY=")) {
                    const value = trimmed
                        .slice("CLIPROXY_API_KEY=".length)
                        .trim();
                    return value.replace(/^["']|["']$/g, "");
                }
            }
        } catch {
            // ignore
        }
    }
    return "";
}

// ── Provider config helpers ──

function buildProviderConfig(models: ProviderModelConfig[]) {
    return {
        name: PROVIDER_DISPLAY,
        baseUrl: PROVIDER_BASE_URL,
        api: PROVIDER_API,
        apiKey: getCliproxyApiKey(),
        models,
    };
}

function mergeStartupModels(
    cachedModels: readonly ProviderModelConfig[],
): ProviderModelConfig[] {
    const modelsById = new Map(
        STATIC_FALLBACK_MODELS.map((model) => [model.id, model]),
    );
    for (const model of cachedModels) modelsById.set(model.id, model);
    return [...modelsById.values()];
}

// ── Registration ──

/**
 * Register the CPA provider with Pi.
 *
 * @param pi - The Pi extension API
 * @param options - Optional overrides for testing (buildModels injects a mock)
 */
export function registerCpaProvider(
    pi: ExtensionAPI,
    options?: {
        buildModels?: typeof buildCpaModels;
        getCatalog?: () => CpaCatalogLookup;
        loadCachedEntries?: () => CpaModelEntry[] | undefined;
        saveCachedEntries?: (
            entries: readonly CpaModelEntry[],
        ) => Promise<void>;
        isSubagentChild?: () => boolean;
        exitProcess?: (code: number) => void;
    },
): CpaProviderHandle {
    const buildModels = options?.buildModels ?? buildCpaModels;
    const getCatalog = options?.getCatalog ?? getModelsDevCatalog;
    const catalogCache = createCpaCatalogCache({
        cachePath: join(
            getAgentDir(),
            "cache",
            "ai-providers",
            "cpa-catalog.v1.json",
        ),
        endpoint: PROVIDER_BASE_URL,
    });
    const loadCachedEntries =
        options?.loadCachedEntries ?? (() => catalogCache.load());
    const saveCachedEntries =
        options?.saveCachedEntries ?? ((entries) => catalogCache.save(entries));
    const isSubagentChild =
        options?.isSubagentChild ??
        (() => Boolean(process.env.PI_SUBAGENT_CHILD_AGENT));
    const exitProcess =
        options?.exitProcess ?? ((code: number) => process.exit(code));
    const cpaConfig = loadAiProvidersConfig().cpa;
    const catalogGuard = createCpaCatalogGuard({
        refreshTtlMs: cpaConfig?.refreshTtlMs ?? 30_000,
    });
    const silentCatalogDiff = cpaConfig?.silentCatalogDiff ?? false;
    // Tracks new live model ids already surfaced as catalog drift within this
    // provider registration lifetime. Reset on extension reload.
    const reportedCatalogDrift = new Set<string>();
    let lastNotifiedStaleModelId: string | undefined;
    let unverifiedWarningShown = false;
    // Cache raw CPA entries so projections can re-enrich against current
    // models.dev metadata without another CPA /v1/models request.
    const lastEntries: CpaModelEntry[] = [];
    let lastEnrichedModels: ProviderModelConfig[] = [];
    let hasStartupCatalog = false;

    function enrichEntries(
        entries: readonly CpaModelEntry[],
    ): ProviderModelConfig[] {
        const catalog = getCatalog();
        return entries
            .map((entry) =>
                enrichModel(entry, catalog, cpaConfig.metadataRules ?? []),
            )
            .filter((model): model is ProviderModelConfig => model !== null);
    }

    async function refreshCatalog(
        ctx: LifecycleCtx,
        force = false,
        sink: (counts: CatalogDiffCounts) => void = themedDriftSink(ctx),
    ) {
        const apiKey = getCliproxyApiKey();
        const result = await catalogGuard.refresh({
            force,
            activeModel: ctx.model
                ? { provider: ctx.model.provider, id: ctx.model.id }
                : undefined,
            loadCatalog: async () => {
                const catalog = await buildModels(PROVIDER_BASE_URL, apiKey);
                // ponytail: snapshot raw entries and enriched models for metadata-only reprojection.
                if (catalog.source === "live") {
                    // Mutate const array in-place — entries discovered from CPA.
                    lastEntries.length = 0;
                    lastEntries.push(...catalog.entries);
                    lastEnrichedModels = catalog.models;
                    try {
                        await saveCachedEntries(catalog.entries);
                    } catch {
                        console.warn(
                            "[cpa] Failed to persist the verified CPA catalog.",
                        );
                    }
                }
                return catalog;
            },
            registerModels: (models) => {
                pi.registerProvider(PROVIDER_NAME, buildProviderConfig(models));
                reportCatalogDiff(models, STATIC_FALLBACK_MODELS, {
                    silent: silentCatalogDiff,
                    reported: reportedCatalogDrift,
                    sink,
                });
            },
            hasModel: (provider, id) =>
                Boolean(ctx.modelRegistry.find(provider, id)),
        });
        return result;
    }

    function notifyStaleModelOnce(ctx: LifecycleCtx, modelId: string): void {
        if (lastNotifiedStaleModelId === modelId) return;
        lastNotifiedStaleModelId = modelId;
        const message = `Le modèle CPA actif ${modelId} n’existe plus. Utilise /model pour choisir un modèle valide.`;
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        else console.warn(`[cpa] ${message}`);
    }

    function notifyUnverifiedOnce(ctx: LifecycleCtx): void {
        if (unverifiedWarningShown) return;
        unverifiedWarningShown = true;
        const message =
            "Catalogue CPA indisponible. Le dernier état vérifié est conservé.";
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        else console.warn(`[cpa] ${message}`);
    }

    /**
     * Provider projection handle.
     *
     * When `options.force` is true or no cached models exist, performs a full
     * live discovery through CPA /v1/models (same as `/cpa-refresh`).
     * Otherwise re-registers the last known enriched models from cache — a
     * metadata-only reprojection that avoids a redundant CPA fetch when
     * only the models.dev catalog changed.
     */
    const handle: CpaProviderHandle = {
        providerId: PROVIDER_NAME,
        async refreshStartupProjection(ctx) {
            if (!hasStartupCatalog) return;
            try {
                const result = await refreshCatalog(ctx);
                if (result.state === "stale") {
                    notifyStaleModelOnce(ctx, result.modelId);
                }
            } catch {
                // Cached projection remains available until input revalidation.
            }
        },
        async refreshProjection(ctx, projectionOptions) {
            if (projectionOptions?.force || lastEnrichedModels.length === 0) {
                const result = await refreshCatalog(ctx, true);
                if (result.state === "stale") {
                    notifyStaleModelOnce(ctx, result.modelId);
                    return;
                }

                const message =
                    result.state === "valid"
                        ? "Catalogue CPA actualisé. Le modèle actif est valide."
                        : "Catalogue CPA indisponible. Le dernier état vérifié est conservé.";
                if (ctx.hasUI)
                    ctx.ui.notify(
                        message,
                        result.state === "valid" ? "info" : "warning",
                    );
                else console.warn(`[cpa] ${message}`);
                return;
            }

            // Metadata-only reprojection: re-enrich cached entries against
            // the current models.dev catalog snapshot without fetching CPA.
            // No notification — models.dev lifecycle handles its own.
            if (lastEntries.length > 0) {
                const models = enrichEntries(lastEntries);
                if (models.length > 0) {
                    pi.registerProvider(
                        PROVIDER_NAME,
                        buildProviderConfig(models),
                    );
                }
            }
        },
    };

    // Phase 1: register static fallbacks plus last verified dynamic entries.
    // Disk cache is read synchronously so Pi can resolve a CPA default before
    // session_start performs its live verification.
    let startupEntries: CpaModelEntry[] = [];
    try {
        startupEntries = loadCachedEntries() ?? [];
    } catch {
        console.warn("[cpa] Failed to load the CPA catalog cache.");
    }
    const startupModels = enrichEntries(startupEntries);
    hasStartupCatalog = startupModels.length > 0;
    lastEntries.push(...startupEntries);
    lastEnrichedModels = startupModels;
    pi.registerProvider(
        PROVIDER_NAME,
        buildProviderConfig(mergeStartupModels(startupModels)),
    );

    pi.on("model_select", async (event, ctx) => {
        if (event.model.provider !== PROVIDER_NAME) return;
        try {
            const result = await refreshCatalog(ctx, true);
            if (result.state === "stale")
                notifyStaleModelOnce(ctx, result.modelId);
            if (result.state === "valid") {
                lastNotifiedStaleModelId = undefined;
                unverifiedWarningShown = false;
            }
        } catch {
            // A failed verification must not block a newly selected model.
        }
    });

    pi.on("input", async (_event, ctx) => {
        if (ctx.model?.provider !== PROVIDER_NAME)
            return { action: "continue" };
        const result = await refreshCatalog(ctx);
        if (result.state === "unverified") {
            notifyUnverifiedOnce(ctx);
            return { action: "continue" };
        }
        if (result.state === "valid") {
            unverifiedWarningShown = false;
            return { action: "continue" };
        }

        notifyStaleModelOnce(ctx, result.modelId);
        if (!ctx.hasUI) {
            if (isSubagentChild()) {
                console.error(
                    `[cpa] Model ${result.modelId} not found; terminating subagent child so model fallback can continue.`,
                );
                exitProcess(1);
            } else {
                ctx.shutdown();
            }
        }
        return { action: "handled" };
    });

    pi.on("session_before_compact", async (_event, ctx) => {
        if (ctx.model?.provider !== PROVIDER_NAME) return undefined;
        const result = await refreshCatalog(ctx);
        if (result.state !== "stale") return undefined;

        notifyStaleModelOnce(ctx, result.modelId);
        return { cancel: true };
    });

    pi.registerCommand("cpa-refresh", {
        description: "Refresh CPA models and validate the active model",
        handler: async (_args, ctx) => {
            await handle.refreshProjection(ctx, { force: true });
        },
    });

    return handle;
}
