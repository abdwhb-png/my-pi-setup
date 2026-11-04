import type { CpaCatalogFailure, CpaCatalogResult } from './cpa-models.ts';

export type CpaCatalogGuardResult = {
    catalog: CpaCatalogResult;
    refreshed: boolean;
} & (
    | { state: 'valid'; modelId?: string }
    | { state: 'stale'; modelId: string }
    | {
          state: 'unverified';
          modelId?: string;
          failure: CpaCatalogFailure;
      }
);

interface ActiveModelRef {
    provider: string;
    id: string;
}

interface RefreshInput {
    force?: boolean;
    activeModel?: ActiveModelRef;
    loadCatalog(): Promise<CpaCatalogResult>;
}

interface CpaCatalogGuardOptions {
    refreshTtlMs: number;
    now?: () => number;
}

export function createCpaCatalogGuard(options: CpaCatalogGuardOptions) {
    const now = options.now ?? Date.now;
    let lastRefreshAt = Number.NEGATIVE_INFINITY;
    let lastCatalog: CpaCatalogResult | undefined;
    let inFlight: Promise<CpaCatalogResult> | undefined;

    async function performRefresh(
        input: RefreshInput,
    ): Promise<CpaCatalogResult> {
        const catalog = await input.loadCatalog();
        lastCatalog = catalog;
        lastRefreshAt = now();
        return catalog;
    }

    return {
        async refresh(input: RefreshInput): Promise<CpaCatalogGuardResult> {
            let refreshed = false;
            let catalog = lastCatalog;
            if (
                !catalog ||
                input.force ||
                now() - lastRefreshAt >= options.refreshTtlMs
            ) {
                inFlight ??= performRefresh(input).finally(() => {
                    inFlight = undefined;
                });
                catalog = await inFlight;
                refreshed = true;
            }
            if (catalog.source === 'unavailable')
                return {
                    state: 'unverified',
                    catalog,
                    modelId: input.activeModel?.id,
                    refreshed,
                    failure: catalog.failure,
                };
            if (
                input.activeModel?.provider === 'cpa' &&
                !catalog.models.some(
                    (model) => model.id === input.activeModel?.id,
                )
            )
                return {
                    state: 'stale',
                    catalog,
                    modelId: input.activeModel.id,
                    refreshed,
                };
            return {
                state: 'valid',
                catalog,
                modelId: input.activeModel?.id,
                refreshed,
            };
        },
    };
}
