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
import { createUiColors } from "../../_shared/ui/ui-colors.ts";
import { loadAiProvidersConfig } from "../config.ts";
import { STATIC_FALLBACK_MODELS } from "../constants/cpa-static-models";
import type { CatalogDiffCounts } from "./catalog-diff.ts";
import { reportCatalogDiff } from "./catalog-diff.ts";
import { createCpaCatalogGuard } from "./cpa-catalog-guard.ts";
import { buildCpaModels } from "./cpa-models.ts";

// ── Constants ──

const PROVIDER_NAME = "cpa";
const PROVIDER_DISPLAY = "CLIProxyAPI (local)";
const PROVIDER_BASE_URL = "http://localhost:8317/v1";
const PROVIDER_API = "openai-completions" as const;

// ── Lifecycle event context shape ──

type LifecycleCtx = Parameters<Parameters<ExtensionAPI["on"]>[1]>[1];

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
        isSubagentChild?: () => boolean;
        exitProcess?: (code: number) => void;
    },
): void {
    const buildModels = options?.buildModels ?? buildCpaModels;
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

    async function refreshCatalog(
        ctx: LifecycleCtx,
        force = false,
        sink: (counts: CatalogDiffCounts) => void = themedDriftSink(ctx),
    ) {
        const apiKey = getCliproxyApiKey();
        return catalogGuard.refresh({
            force,
            activeModel: ctx.model
                ? { provider: ctx.model.provider, id: ctx.model.id }
                : undefined,
            loadCatalog: () => buildModels(PROVIDER_BASE_URL, apiKey),
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

    // Phase 1: Register with static fallback models immediately (synchronous)
    pi.registerProvider(
        PROVIDER_NAME,
        buildProviderConfig(STATIC_FALLBACK_MODELS),
    );

    // Phase 2: On session_start, fetch dynamic models and re-register.
    // Startup phase: drift goes to console.warn (logs, no TUI intrusion).
    pi.on("session_start", async (_event, ctx) => {
        try {
            await refreshCatalog(ctx, true, consoleDriftSink);
        } catch {
            // If dynamic fetch fails, keep static fallback models
        }
    });

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
        },
    });
}
