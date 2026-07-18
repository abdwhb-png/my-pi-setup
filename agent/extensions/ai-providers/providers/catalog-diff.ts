/**
 * Catalog drift reporting for the CPA provider.
 *
 * Compares the live catalog (dynamic models from CPA's /v1/models) against the
 * static fallback list and emits a single summary warning when new or missing
 * models are detected. Each new model id is reported at most once per provider
 * registration lifetime (tracked via the shared `reported` Set).
 */

import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent';

/**
 * Drift signal emitted by {@link reportCatalogDiff}. The caller decides how
 * to format it (plain console, themed `ui.notify`, JSON, etc.) — the
 * structured counts keep the rendering decision in the TUI layer.
 */
export interface CatalogDiffCounts {
    /** Number of newly seen live model ids absent from the static list. */
    newCount: number;
    /** Number of static fallback ids missing from the live catalog. */
    missingFallbackCount: number;
}

export interface CatalogDiffOptions {
    /**
     * When true, suppresses all drift output. Backed by the
     * `aiProviders.cpa.silentCatalogDiff` config flag.
     */
    silent?: boolean;
    /**
     * Set of new-model ids that have already surfaced in a prior call within
     * the same provider registration. Mutated in place by this function.
     * Lives in the registerCpaProvider closure so it resets on extension
     * reload.
     */
    reported: Set<string>;
    /**
     * Consumer for the drift counts. The caller picks the channel and the
     * formatting: `console.warn` (startup logs), `ctx.ui.notify` with theme
     * colors (runtime), or any custom rendering. Defaults to a plain
     * `[cpa] Catalog drift: ...` `console.warn` to keep backwards
     * compatibility with headless startup.
     */
    sink?: (counts: CatalogDiffCounts) => void;
}

/**
 * Reports catalog drift between the live catalog and the static fallback list.
 *
 * Emits at most one summary line per call, and only when there is something
 * new to surface:
 *   - newly seen live models absent from the static list
 *   - static fallback models no longer present in the live catalog
 *
 * Disclosure of each new model id happens exactly once across the lifetime of
 * the `reported` Set (one id → one increment of the count, never re-logged).
 */
export function reportCatalogDiff(
    dynamicModels: ProviderModelConfig[],
    staticModels: ProviderModelConfig[],
    options: CatalogDiffOptions,
): void {
    if (options.silent) return;
    const sink: (counts: CatalogDiffCounts) => void =
        options.sink ??
        ((counts) =>
            console.warn(
                `[cpa] Catalog drift: ${counts.newCount} new model(s), ${counts.missingFallbackCount} missing fallback(s)`,
            ));

    const staticIds = new Set(staticModels.map((model) => model.id));
    const dynamicIds = new Set(dynamicModels.map((model) => model.id));

    let newCount = 0;
    for (const id of dynamicIds) {
        if (!staticIds.has(id) && !options.reported.has(id)) {
            options.reported.add(id);
            newCount++;
        }
    }

    let missingFallbackCount = 0;
    for (const id of staticIds) {
        if (!dynamicIds.has(id)) {
            missingFallbackCount++;
        }
    }

    if (newCount === 0 && missingFallbackCount === 0) return;

    sink({ newCount, missingFallbackCount });
}
