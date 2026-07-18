/**
 * Catalog drift reporting for the CPA provider.
 *
 * Compares the live catalog (dynamic models from CPA's /v1/models) against the
 * static fallback list and emits a single summary warning when new or missing
 * models are detected. Each new model id is reported at most once per provider
 * registration lifetime (tracked via the shared `reported` Set).
 */

import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent';

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
     * Sink for the summary line. The caller picks the channel depending on
     * lifecycle phase: `console.warn` at session startup, `ctx.ui.notify`
     * (with a console fallback when headless) during runtime hooks. Defaults
     * to `console.warn`.
     */
    sink?: (message: string) => void;
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
    const sink = options.sink ?? console.warn;

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

    sink(
        `[cpa] Catalog drift: ${newCount} new model(s), ${missingFallbackCount} missing fallback(s)`,
    );
}
