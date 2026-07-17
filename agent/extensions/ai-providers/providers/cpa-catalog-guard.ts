import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent';
import type { CpaCatalogResult } from './cpa-models.ts';

export type CpaCatalogGuardResult =
    | { state: 'valid'; modelId?: string; refreshed: boolean }
    | { state: 'stale'; modelId: string; refreshed: boolean }
    | { state: 'unverified'; modelId?: string; refreshed: boolean };

interface ActiveModelRef {
    provider: string;
    id: string;
}

interface RefreshInput {
    force?: boolean;
    activeModel?: ActiveModelRef;
    loadCatalog(): Promise<CpaCatalogResult>;
    registerModels(models: ProviderModelConfig[]): void;
    hasModel(provider: string, id: string): boolean;
}

interface CpaCatalogGuardOptions {
    refreshTtlMs: number;
    now?: () => number;
}

export function createCpaCatalogGuard(options: CpaCatalogGuardOptions) {
    const now = options.now ?? Date.now;
    let lastRefreshAt = Number.NEGATIVE_INFINITY;
    let lastResult: CpaCatalogGuardResult = {
        state: 'unverified',
        refreshed: false,
    };
    let inFlight: Promise<CpaCatalogGuardResult> | undefined;

    async function performRefresh(
        input: RefreshInput,
    ): Promise<CpaCatalogGuardResult> {
        const catalog = await input.loadCatalog();
        lastRefreshAt = now();

        if (catalog.source !== 'live') {
            if (
                lastResult.state !== 'unverified' &&
                lastResult.modelId === input.activeModel?.id
            ) {
                return { ...lastResult, refreshed: true };
            }
            lastResult = {
                state: 'unverified',
                modelId: input.activeModel?.id,
                refreshed: true,
            };
            return lastResult;
        }

        input.registerModels(catalog.models);

        if (
            input.activeModel?.provider === 'cpa' &&
            !input.hasModel('cpa', input.activeModel.id)
        ) {
            lastResult = {
                state: 'stale',
                modelId: input.activeModel.id,
                refreshed: true,
            };
            return lastResult;
        }

        lastResult = {
            state: 'valid',
            modelId: input.activeModel?.id,
            refreshed: true,
        };
        return lastResult;
    }

    return {
        async refresh(input: RefreshInput): Promise<CpaCatalogGuardResult> {
            if (!input.force && now() - lastRefreshAt < options.refreshTtlMs) {
                return { ...lastResult, refreshed: false };
            }

            if (inFlight) return inFlight;

            inFlight = performRefresh(input).finally(() => {
                inFlight = undefined;
            });
            return inFlight;
        },
    };
}
