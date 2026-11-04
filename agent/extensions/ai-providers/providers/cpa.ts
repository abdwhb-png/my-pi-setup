import { extensionPath } from '../../_shared/extension-paths.ts';
/**
 * CLIProxyAPI (CPA) provider for Pi.
 *
 * Registers CPA as a central model router via the ai-providers extension.
 * Models are dynamically discovered from CPA's `/v1/models` endpoint and
 * enriched with metadata via the cpa-models enrichment engine.
 *
 * Models become available only after live catalog verification. Cached and
 * static metadata enrich verified entries without granting availability.
 *
 * CPA is an OpenAI-compatible proxy — the built-in `openai-completions`
 * streamSimple handles all streaming. No custom streamSimple needed.
 */

import { randomUUID } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { RefreshModelsContext } from '@earendil-works/pi-ai';
import type {
    ExtensionAPI,
    ProviderConfig,
} from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { getModelsDevCatalog } from '../../_shared/models-dev/catalog';
import { createUiColors } from '../../_shared/ui/ui-colors.ts';
import { loadAiProvidersConfig } from '../config.ts';
import { STATIC_FALLBACK_MODELS } from '../constants/cpa-static-models';
import type { ChatModelConfig } from '../rules/model-rules.ts';
import type { CatalogDiffCounts } from './catalog-diff.ts';
import { reportCatalogDiff } from './catalog-diff.ts';
import { createCpaCatalogCache } from './cpa-catalog-cache.ts';
import { createCpaCatalogGuard } from './cpa-catalog-guard.ts';
import { buildCpaModels, enrichModel } from './cpa-models.ts';
import type {
    CpaCatalogFailure,
    CpaCatalogLookup,
    CpaCatalogResult,
    CpaModelEntry,
} from './cpa-models.ts';

// ── Constants ──

const PROVIDER_NAME = 'cpa';
const PROVIDER_DISPLAY = 'CLIProxyAPI';
const DEFAULT_BASE_URL = 'http://localhost:8317/v1';
const PROVIDER_API = 'openai-completions' as const;

// ── Lifecycle event context shape ──

export type LifecycleCtx = Parameters<Parameters<ExtensionAPI['on']>[1]>[1];

/**
 * Handle returned by {@link registerCpaProvider}.
 *
 * Forced projections and `/cpa-refresh` verify the live catalog. Ordinary
 * projections may re-enrich entries only while the current catalog is verified.
 */
export interface CpaProviderHandle {
    providerId: 'cpa';
    refreshProjection(
        ctx: LifecycleCtx,
        options?: { force?: boolean },
    ): Promise<void>;
    refreshStartupProjection(ctx: LifecycleCtx): Promise<void>;
    getAvailability(): Readonly<CpaProviderAvailability>;
}

export interface CpaProviderAvailability {
    state: 'checking' | 'available' | 'empty' | 'unavailable';
    diagnostic: string;
}

function catalogFailureMessage(failure: CpaCatalogFailure): string {
    const reason =
        failure.kind === 'http'
            ? `catalog request ${[401, 403].includes(failure.status) ? 'authentication refused' : 'failed'} (HTTP ${failure.status})`
            : {
                  'missing-credentials': 'credentials are missing',
                  timeout: 'catalog request timed out',
                  network: 'catalog endpoint could not be reached',
                  'invalid-response': 'catalog response is invalid',
              }[failure.kind];
    const action =
        failure.kind === 'missing-credentials' ||
        (failure.kind === 'http' && [401, 403].includes(failure.status))
            ? 'Verify CLIPROXY_API_KEY through your secure configuration channel'
            : 'Check the configured CPA endpoint and tunnel';
    return `CPA is unavailable: ${reason}. ${action}, then run /cpa-refresh or choose another provider with /model.`;
}

/** Persists informational drift from non-interactive CPA invocations. */
const HEADLESS_DRIFT_DIAGNOSTIC_PATH = extensionPath(
    { scope: 'global' },
    'artifacts',
    'cache',
    'ai-providers',
    'cpa-catalog-drift.v1.json',
);

type HeadlessCatalogDrift = CatalogDiffCounts & { recordedAt: number };

function formatCatalogDrift(counts: CatalogDiffCounts): string {
    return `[cpa] Catalog drift: ${counts.newCount} new model(s), ${counts.missingFallbackCount} missing fallback(s)`;
}

function persistHeadlessCatalogDrift(counts: CatalogDiffCounts): void {
    const directory = dirname(HEADLESS_DRIFT_DIAGNOSTIC_PATH);
    const temporaryPath = join(
        directory,
        `.${basename(HEADLESS_DRIFT_DIAGNOSTIC_PATH)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
        mkdirSync(directory, { recursive: true });
        writeFileSync(
            temporaryPath,
            `${JSON.stringify({ ...counts, recordedAt: Date.now() })}\n`,
            'utf8',
        );
        renameSync(temporaryPath, HEADLESS_DRIFT_DIAGNOSTIC_PATH);
    } catch (error) {
        process.stderr.write(
            `[cpa] Failed to persist headless catalog drift: ${error instanceof Error ? error.message : String(error)}\n`,
        );
    }
}

function loadHeadlessCatalogDrift(): HeadlessCatalogDrift | undefined {
    try {
        const value: unknown = JSON.parse(
            readFileSync(HEADLESS_DRIFT_DIAGNOSTIC_PATH, 'utf8'),
        );
        if (
            !value ||
            typeof value !== 'object' ||
            !Number.isFinite((value as HeadlessCatalogDrift).recordedAt) ||
            !Number.isInteger((value as HeadlessCatalogDrift).newCount) ||
            !Number.isInteger(
                (value as HeadlessCatalogDrift).missingFallbackCount,
            )
        ) {
            return undefined;
        }
        return value as HeadlessCatalogDrift;
    } catch {
        return undefined;
    }
}

/**
 * Routes interactive drift to TUI. Headless children persist the diagnostic
 * out-of-band so an informational catalog difference never contaminates the
 * child stderr Hermes uses for real execution failures.
 */
function themedDriftSink(
    ctx: LifecycleCtx,
    saveHeadlessCatalogDrift: (counts: CatalogDiffCounts) => void,
): (counts: CatalogDiffCounts) => void {
    if (!ctx.hasUI) return saveHeadlessCatalogDrift;
    return (counts) => {
        const theme = ctx.ui.theme;
        if (!theme) {
            ctx.ui.notify(formatCatalogDrift(counts), 'info');
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
            `${colors.model('[cpa]')} ${parts.join(colors.separator(' · '))}`,
            'info',
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
        return process.env.CLIPROXY_API_KEY.replace(/^["']|["']$/g, '');
    }
    const envPath = join(getAgentDir(), '.env');
    if (existsSync(envPath)) {
        try {
            const content = readFileSync(envPath, 'utf-8');
            for (const line of content.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (trimmed.startsWith('CLIPROXY_API_KEY=')) {
                    const value = trimmed
                        .slice('CLIPROXY_API_KEY='.length)
                        .trim();
                    return value.replace(/^["']|["']$/g, '');
                }
            }
        } catch {
            // ignore
        }
    }
    return '';
}

// ── Provider config helpers ──

function buildProviderConfig(
    models: ChatModelConfig[],
    baseUrl: string,
    refreshModels: NonNullable<ProviderConfig['refreshModels']>,
): ProviderConfig {
    return {
        name: PROVIDER_DISPLAY,
        baseUrl,
        api: PROVIDER_API,
        apiKey: getCliproxyApiKey(),
        models,
        refreshModels,
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
        getCatalog?: () => CpaCatalogLookup;
        loadCachedEntries?: () => CpaModelEntry[] | undefined;
        saveCachedEntries?: (
            entries: readonly CpaModelEntry[],
        ) => Promise<void>;
        isSubagentChild?: () => boolean;
        exitProcess?: (code: number) => void;
        saveHeadlessCatalogDrift?: (counts: CatalogDiffCounts) => void;
    },
): CpaProviderHandle {
    const buildModels = options?.buildModels ?? buildCpaModels;
    const getCatalog = options?.getCatalog ?? getModelsDevCatalog;
    const cpaConfig = loadAiProvidersConfig().cpa;
    const baseUrl = (
        process.env.CLIPROXY_BASE_URL?.trim() ||
        cpaConfig.baseUrl ||
        DEFAULT_BASE_URL
    ).replace(/\/+$/, '');
    const endpoint = URL.canParse(baseUrl) ? new URL(baseUrl) : undefined;
    if (
        !endpoint ||
        !['http:', 'https:'].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        baseUrl.includes('?') ||
        baseUrl.includes('#')
    ) {
        throw new Error(
            'Invalid CPA base URL. Set CLIPROXY_BASE_URL or cpa.baseUrl to an absolute HTTP(S) URL without credentials, query parameters or a fragment.',
        );
    }
    const catalogCache = createCpaCatalogCache({
        cachePath: extensionPath(
            { scope: 'global' },
            'artifacts',
            'cache',
            'ai-providers',
            'cpa-catalog.v1.json',
        ),
        endpoint: baseUrl,
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
    const saveHeadlessCatalogDrift =
        options?.saveHeadlessCatalogDrift ?? persistHeadlessCatalogDrift;
    const catalogGuard = createCpaCatalogGuard({
        refreshTtlMs: cpaConfig?.refreshTtlMs ?? 30_000,
    });
    const silentCatalogDiff = cpaConfig?.silentCatalogDiff ?? false;
    // Tracks new live model ids already surfaced as catalog drift within this
    // provider registration lifetime. Reset on extension reload.
    const reportedCatalogDrift = new Set<string>();
    let lastNotifiedStaleModelId: string | undefined;
    let lastUnavailableMessage: string | undefined;
    // Cache raw CPA entries so projections can re-enrich against current
    // models.dev metadata without another CPA /v1/models request.
    const lastEntries: CpaModelEntry[] = [];
    let lastEnrichedModels: ChatModelConfig[] = [];
    let acceptedCatalog: CpaCatalogResult | undefined;
    let lastSavedCatalog: CpaCatalogResult | undefined;
    let availability: CpaProviderAvailability = {
        state: 'checking',
        diagnostic: 'CPA catalog has not been verified.',
    };

    function enrichEntries(
        entries: readonly CpaModelEntry[],
    ): ChatModelConfig[] {
        const catalog = getCatalog();
        const config = loadAiProvidersConfig();
        const rules = config.modelRules ?? [];
        return entries
            .map((entry) => enrichModel(entry, catalog, rules))
            .filter((model): model is ChatModelConfig => model !== null);
    }

    function acceptCatalog(catalog: CpaCatalogResult): void {
        if (acceptedCatalog === catalog) return;
        acceptedCatalog = catalog;
        if (catalog.source === 'live') {
            lastEntries.length = 0;
            lastEntries.push(...catalog.entries);
            lastEnrichedModels = catalog.models;
        }
        availability =
            catalog.source === 'unavailable'
                ? {
                      state: 'unavailable',
                      diagnostic: catalogFailureMessage(catalog.failure),
                  }
                : {
                      state: catalog.models.length ? 'available' : 'empty',
                      diagnostic: catalog.models.length
                          ? 'CPA catalog verified.'
                          : 'CPA catalog verified; no supported models are available.',
                  };
        if (catalog.source === 'live') lastUnavailableMessage = undefined;
        if (
            catalog.source === 'unavailable' ||
            catalog.models.some(
                (model) => model.id === lastNotifiedStaleModelId,
            )
        )
            lastNotifiedStaleModelId = undefined;
    }

    async function persistCatalog(catalog: CpaCatalogResult): Promise<void> {
        if (catalog.source !== 'live' || lastSavedCatalog === catalog) return;
        lastSavedCatalog = catalog;
        try {
            await saveCachedEntries(catalog.entries);
        } catch {
            console.warn('[cpa] Failed to persist the verified CPA catalog.');
        }
    }

    function availableModels(): ChatModelConfig[] {
        return availability.state === 'available' ? lastEnrichedModels : [];
    }

    function loadCatalog(): Promise<CpaCatalogResult> {
        return buildModels(baseUrl, getCliproxyApiKey());
    }

    async function refreshNativeCatalog(
        context: RefreshModelsContext,
    ): Promise<ChatModelConfig[]> {
        if (!context.allowNetwork || context.signal.aborted)
            return availableModels();
        const result = await catalogGuard.refresh({
            force: context.force,
            loadCatalog,
        });
        // Pi owns publication into its registry. Re-registering here would
        // replace the provider and invalidate the refresh's publication token.
        if (
            await context.publish({
                update: () => acceptCatalog(result.catalog),
            })
        )
            await persistCatalog(result.catalog);
        return availableModels();
    }

    async function refreshCatalog(
        ctx: LifecycleCtx,
        force = false,
        sink: (counts: CatalogDiffCounts) => void = themedDriftSink(
            ctx,
            saveHeadlessCatalogDrift,
        ),
    ) {
        let result = await catalogGuard.refresh({
            force,
            activeModel: ctx.model
                ? { provider: ctx.model.provider, id: ctx.model.id }
                : undefined,
            loadCatalog,
        });
        const needsPublication =
            result.refreshed || acceptedCatalog !== result.catalog;
        acceptCatalog(result.catalog);
        if (needsPublication) {
            const models = availableModels();
            pi.registerProvider(
                PROVIDER_NAME,
                buildProviderConfig(models, baseUrl, refreshNativeCatalog),
            );
            if (models.length > 0)
                reportCatalogDiff(models, STATIC_FALLBACK_MODELS, {
                    silent: silentCatalogDiff,
                    reported: reportedCatalogDrift,
                    sink,
                });
        }
        await persistCatalog(result.catalog);
        const activeModel = ctx.model;
        if (
            result.state === 'valid' &&
            activeModel?.provider === PROVIDER_NAME &&
            !ctx.modelRegistry.find(PROVIDER_NAME, activeModel.id)
        )
            result = { ...result, state: 'stale', modelId: activeModel.id };
        if (result.state !== 'stale') lastNotifiedStaleModelId = undefined;
        if (ctx.hasUI)
            ctx.ui.setStatus?.(
                'cpa',
                availability.state === 'available'
                    ? undefined
                    : availability.diagnostic,
            );
        return result;
    }

    function notifyStaleModelOnce(ctx: LifecycleCtx, modelId: string): void {
        if (lastNotifiedStaleModelId === modelId) return;
        lastNotifiedStaleModelId = modelId;
        const message = `The active CPA model ${modelId} no longer exists. Use /model to choose a valid model.`;
        if (ctx.hasUI) ctx.ui.notify(message, 'warning');
        else console.warn(`[cpa] ${message}`);
    }

    function notifyUnverifiedOnce(ctx: LifecycleCtx): void {
        // A child using another provider must not report this as an execution failure.
        if (
            !ctx.hasUI &&
            isSubagentChild() &&
            ctx.model?.provider !== PROVIDER_NAME
        )
            return;
        const message = availability.diagnostic;
        if (lastUnavailableMessage === message) return;
        lastUnavailableMessage = message;
        if (ctx.hasUI) ctx.ui.notify(message, 'warning');
        else console.warn(`[cpa] ${message}`);
    }

    /**
     * Provider projection handle.
     *
     * Forced refreshes verify CPA; metadata-only reprojection never restores
     * an unavailable provider from the retained disk or in-memory cache.
     */
    const handle: CpaProviderHandle = {
        providerId: PROVIDER_NAME,
        getAvailability: () => availability,
        async refreshStartupProjection(ctx) {
            const result = await refreshCatalog(ctx);
            if (result.state === 'stale')
                notifyStaleModelOnce(ctx, result.modelId);
            else if (result.state === 'unverified') notifyUnverifiedOnce(ctx);
        },
        async refreshProjection(ctx, projectionOptions) {
            if (projectionOptions?.force || availability.state === 'checking') {
                const result = await refreshCatalog(
                    ctx,
                    projectionOptions?.force ?? false,
                );
                if (result.state === 'stale') {
                    notifyStaleModelOnce(ctx, result.modelId);
                    return;
                }

                if (result.state === 'unverified') {
                    notifyUnverifiedOnce(ctx);
                    return;
                }
                const message = availability.diagnostic;
                if (ctx.hasUI)
                    ctx.ui.notify(
                        message,
                        result.state === 'valid' ? 'info' : 'warning',
                    );
                else console.warn(`[cpa] ${message}`);
                return;
            }

            // Metadata-only reprojection: re-enrich cached entries against
            // the current models.dev catalog snapshot without fetching CPA.
            // No notification — models.dev lifecycle handles its own.
            if (availability.state === 'available' && lastEntries.length > 0) {
                const models = enrichEntries(lastEntries);
                if (models.length > 0) {
                    lastEnrichedModels = models;
                    pi.registerProvider(
                        PROVIDER_NAME,
                        buildProviderConfig(
                            models,
                            baseUrl,
                            refreshNativeCatalog,
                        ),
                    );
                }
            }
        },
    };

    // The disk cache is metadata, not evidence that this endpoint is available.
    let startupEntries: CpaModelEntry[] = [];
    try {
        startupEntries = loadCachedEntries() ?? [];
    } catch {
        console.warn('[cpa] Failed to load the CPA catalog cache.');
    }
    lastEntries.push(...startupEntries);
    pi.registerProvider(
        PROVIDER_NAME,
        buildProviderConfig([], baseUrl, refreshNativeCatalog),
    );

    pi.on('model_select', async (event, ctx) => {
        if (event.model.provider !== PROVIDER_NAME) return;
        const result = await refreshCatalog(ctx, true);
        if (result.state === 'stale') notifyStaleModelOnce(ctx, result.modelId);
        if (result.state === 'unverified') notifyUnverifiedOnce(ctx);
    });

    pi.on('input', async (_event, ctx) => {
        if (ctx.model?.provider !== PROVIDER_NAME)
            return { action: 'continue' };
        const result = await refreshCatalog(ctx);
        if (result.state === 'unverified') {
            notifyUnverifiedOnce(ctx);
            if (!ctx.hasUI) {
                if (isSubagentChild()) exitProcess(1);
                else ctx.shutdown();
            }
            return { action: 'handled' };
        }
        if (result.state === 'valid') {
            return { action: 'continue' };
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
        return { action: 'handled' };
    });

    pi.on('session_before_compact', async (_event, ctx) => {
        if (ctx.model?.provider !== PROVIDER_NAME) return undefined;
        const result = await refreshCatalog(ctx);
        if (result.state === 'valid') return undefined;
        if (result.state === 'stale') notifyStaleModelOnce(ctx, result.modelId);
        else notifyUnverifiedOnce(ctx);
        return { cancel: true };
    });

    pi.registerCommand('cpa-refresh', {
        description: 'Refresh CPA models and validate the active model',
        handler: async (_args, ctx) => {
            await handle.refreshProjection(ctx, { force: true });
        },
    });

    pi.registerCommand('cpa-drift', {
        description: 'Show latest headless CPA catalog drift diagnostic',
        handler: (_args, ctx) => {
            const drift = loadHeadlessCatalogDrift();
            const message = drift
                ? `${formatCatalogDrift(drift)}. Recorded ${new Date(drift.recordedAt).toISOString()}.`
                : '[cpa] No headless catalog drift diagnostic recorded.';
            if (ctx.hasUI) {
                ctx.ui.notify(message, 'info');
            } else {
                process.stdout.write(`${message}\n`);
            }
            return Promise.resolve();
        },
    });

    return handle;
}
