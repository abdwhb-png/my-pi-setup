/**
 * Shared models.dev lifecycle for ai-providers.
 *
 * Owns everything that touches the models.dev catalog across providers:
 *   - disk load at session start
 *   - stale checks gating background freshness
 *   - automatic warning deduplication for failed freshness checks
 *   - the `/models-dev-refresh` command (forced, awaited, sanitized)
 *   - the `Promise.allSettled` projection fanout over provider handles
 *
 * Provider modules stay projection-only: they expose a
 * {@link ProviderProjectionHandle} and never register their own
 * `session_start` lifecycle. The integration is registered before the
 * providers but receives a closure that reads the completed refresher list.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
    ModelsDevCatalog,
    ModelsDevRefreshResult,
} from "../_shared/models-dev/catalog";

// ── Types ──

export type LifecycleCtx = Parameters<Parameters<ExtensionAPI["on"]>[1]>[1];

/** Projection surface every ai-provider handle implements. */
export interface ProviderProjectionOptions {
    force?: boolean;
}

export interface ProviderProjectionHandle {
    providerId: string;
    refreshProjection(
        ctx: LifecycleCtx,
        options?: ProviderProjectionOptions,
    ): Promise<void>;
}

export interface ProjectionSummary {
    succeeded: string[];
    failedProviders: string[];
}

/** Closure reading the completed refresher list (filled after registration). */
export type GetProviderRefreshers = () => readonly ProviderProjectionHandle[];

// ── Status vocabulary ──

/**
 * Sanitized status message: only the result status is reflected, never raw
 * error strings, so provider or network details never leak into the TUI.
 */
function refreshStatusMessage(result: ModelsDevRefreshResult): {
    message: string;
    level: "info" | "warning";
} {
    if (result.status === "failed") {
        return {
            message: UNAVAILABLE_MESSAGE,
            level: "warning",
        };
    }
    const message =
        result.status === "updated"
            ? "Catalogue models.dev actualisé."
            : result.status === "fresh"
              ? "Catalogue models.dev déjà à jour."
              : "Catalogue models.dev inchangé.";
    return { message, level: "info" };
}

const UNAVAILABLE_MESSAGE =
    "Catalogue models.dev indisponible. Le dernier état est conservé.";

function notify(
    ctx: LifecycleCtx,
    message: string,
    level: "info" | "warning",
): void {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else console.warn(`[models-dev] ${message}`);
}

function partialProjectionMessage(failedProviders: readonly string[]): string {
    return `Projection models.dev partielle : échec pour ${failedProviders.join(", ")}.`;
}

// ── Integration ──

/**
 * Register the shared models.dev lifecycle on the Pi extension API.
 *
 * @param pi - The Pi extension API
 * @param catalog - The models.dev catalog (injectable for tests)
 * @param getRefreshers - Closure reading the completed provider refresher
 *   list; registered first, read after providers have been collected.
 */
export function registerModelsDevIntegration(
    pi: ExtensionAPI,
    catalog: ModelsDevCatalog,
    getRefreshers: GetProviderRefreshers,
): void {
    // Per-registration state: independent across reloads and tests.
    let backgroundRefresh: Promise<void> | null = null;
    let warningKey: string | null = null;

    /** Fan out to every provider projection; failures never throw. */
    async function projectAll(
        ctx: LifecycleCtx,
        options?: ProviderProjectionOptions,
    ): Promise<ProjectionSummary> {
        const refreshers = getRefreshers();
        const settled = await Promise.allSettled(
            refreshers.map((refresher) =>
                refresher.refreshProjection(ctx, options),
            ),
        );
        const summary: ProjectionSummary = {
            succeeded: [],
            failedProviders: [],
        };
        for (const [index, result] of settled.entries()) {
            const providerId = refreshers[index]?.providerId;
            if (!providerId) continue;
            if (result.status === "fulfilled")
                summary.succeeded.push(providerId);
            else summary.failedProviders.push(providerId);
        }
        return summary;
    }

    /** Warn once per failure episode; reset on a complete successful outcome. */
    function warnOnce(ctx: LifecycleCtx, message = UNAVAILABLE_MESSAGE): void {
        if (warningKey === message) return;
        warningKey = message;
        notify(ctx, message, "warning");
    }

    /**
     * Coalesced background freshness check. Concurrent callers share the same
     * in-flight refresh; only an `updated` result reprojects the providers.
     */
    function startBackgroundFreshness(ctx: LifecycleCtx): Promise<void> {
        if (backgroundRefresh) return backgroundRefresh;
        backgroundRefresh = catalog
            .refresh()
            .then(async (result) => {
                if (result.status === "updated") {
                    const summary = await projectAll(ctx);
                    if (summary.failedProviders.length > 0) {
                        warnOnce(
                            ctx,
                            partialProjectionMessage(summary.failedProviders),
                        );
                    } else {
                        warningKey = null;
                    }
                    return;
                }
                if (result.status === "failed") {
                    warnOnce(ctx);
                } else if (warningKey === UNAVAILABLE_MESSAGE) {
                    // fresh / not-modified only resolves catalog availability;
                    // a partial projection warning clears after all providers succeed.
                    warningKey = null;
                }
            })
            .catch(() => {
                warnOnce(ctx);
            })
            .finally(() => {
                backgroundRefresh = null;
            });
        return backgroundRefresh;
    }

    // Session start: await disk load plus all cached provider projections,
    // then start (without awaiting) the stale network freshness check.
    pi.on("session_start", async (_event, ctx) => {
        await catalog.load();
        const summary = await projectAll(ctx);
        if (summary.failedProviders.length > 0) {
            warnOnce(ctx, partialProjectionMessage(summary.failedProviders));
        } else {
            warningKey = null;
        }
        void startBackgroundFreshness(ctx).catch(() => {});
    });

    // Input: kick the same background freshness path when the snapshot is
    // stale and return continue synchronously — never block on the network.
    pi.on("input", (_event, ctx) => {
        if (catalog.getStatus().stale) {
            void startBackgroundFreshness(ctx).catch(() => {});
        }
        return { action: "continue" };
    });

    pi.registerCommand("models-dev-refresh", {
        description:
            "Force refresh models.dev metadata and reproject all providers",
        handler: async (_args, ctx) => {
            const result = await catalog.refresh({ force: true });
            // Manual refresh always reprojects: the forced refresh either
            // updated the snapshot or preserved the last known good one.
            const summary = await projectAll(ctx, { force: true });
            if (
                result.status !== "failed" &&
                summary.failedProviders.length > 0
            ) {
                const message = partialProjectionMessage(
                    summary.failedProviders,
                );
                warningKey = message;
                notify(ctx, message, "warning");
                return;
            }
            warningKey =
                result.status === "failed" ? UNAVAILABLE_MESSAGE : null;
            const status = refreshStatusMessage(result);
            notify(ctx, status.message, status.level);
        },
    });
}
