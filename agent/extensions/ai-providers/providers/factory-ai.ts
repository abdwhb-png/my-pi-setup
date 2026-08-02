/**
 * Factory AI provider for Pi.
 *
 * Registers Factory AI's subscription-based models as a Pi provider via
 * @factory/droid-sdk. Authentication uses the user's Factory API key
 * with Google OAuth for cloudcode fallback, stored via Pi's OAuth infrastructure.
 *
 * Dual transport: primary WebSocket relay (wss://relay.factory.ai) with
 * HTTP+SSE fallback to cloudcode-pa.googleapis.com.
 *
 * Model discovery is live: we fetch the catalog from `session.initResult.availableModels`
 * instead of hardcoding model IDs, names, multipliers, or reasoning support.
 *
 * Lifecycle note: the Factory provider has no standalone `session_start`
 * handler. The shared models.dev integration in models-dev.ts owns startup
 * disk load, stale freshness checks, and the projection fanout; this module
 * only exposes `refreshProjection` on the returned handle.
 *
 * Factory API keys can be generated at: https://app.factory.ai/settings/api-keys
 */

import type {
    AssistantMessageEventStream,
    Context,
    Model,
    SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getModelsDevCatalog } from "../../_shared/models-dev/catalog";
import { createFactoryOAuth, getGoogleAccessToken } from "../shared/oauth.ts";
import {
    streamFactory,
    type FactoryStreamConfig,
} from "../shared/sdk-bridge.ts";
import {
    fetchFactoryModels,
    getCachedFactoryModels,
    toProviderModels,
    toResolvedFactoryModels,
    type FactoryCatalogLookup,
} from "./factory-models.ts";

// ── Constants ──

const PROVIDER_NAME = "factory-ai";
const PROVIDER_DISPLAY = "Factory AI";
const API_KEY_URL = "https://app.factory.ai/settings/api-keys";
const PROVIDER_BASE_URL = "https://api.factory.ai";
const PROVIDER_API = "openai-completions" as const;

// ── Lifecycle event context shape ──

type LifecycleCtx = Parameters<Parameters<ExtensionAPI["on"]>[1]>[1];

/**
 * Handle returned by {@link registerFactoryProvider}.
 *
 * `refreshProjection` resolves the Pi provider auth, discovers the live SDK
 * catalog only when credentials exist AND no entries are cached yet, then
 * re-registers the provider projection through `pi.registerProvider`. After a
 * models.dev catalog refresh the projection runs from the cached SDK entries
 * without a second SDK fetch.
 */
export interface FactoryProviderHandle {
    providerId: "factory-ai";
    refreshProjection(
        ctx: LifecycleCtx,
        options?: { force?: boolean },
    ): Promise<void>;
}

// ── Provider config helpers ──

function buildProviderConfig(catalog: FactoryCatalogLookup) {
    return {
        baseUrl: PROVIDER_BASE_URL,
        api: PROVIDER_API,
        models: toProviderModels(undefined, catalog),
        oauth: createFactoryOAuthConfig(catalog),
        streamSimple: streamFactorySimple,
    };
}

// ── API Key Validation ──

/**
 * Validate a Factory API key by fetching the live model catalog.
 * Returns null on success, error message on failure.
 */
async function validateFactoryApiKey(
    apiKey: string,
    _googleToken?: string,
): Promise<string | null> {
    try {
        const models = await fetchFactoryModels(apiKey);
        if (models.length === 0) {
            return "Factory returned no available models for this API key.";
        }
        return null;
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (
            msg.includes("401") ||
            msg.includes("unauthorized") ||
            msg.includes("authentication")
        ) {
            return "Invalid API key. Please check your key at " + API_KEY_URL;
        }
        if (
            msg.includes("ENOENT") ||
            msg.includes("command not found") ||
            msg.includes("droid")
        ) {
            return "Droid CLI not found. Install it first: npm install -g @factory/droid";
        }
        return `API key validation failed: ${msg}`;
    }
}

// ── OAuth Config ──

function createFactoryOAuthConfig(catalog: FactoryCatalogLookup) {
    const base = createFactoryOAuth({
        name: PROVIDER_DISPLAY,
        apiKeyUrl: API_KEY_URL,
        validateKey: validateFactoryApiKey,
    });

    return {
        ...base,
        modifyModels(models: Model<Api>[]) {
            const liveModels = getCachedFactoryModels();
            if (liveModels.length === 0) return models;
            return [
                ...models.filter((m) => m.provider !== PROVIDER_NAME),
                ...toResolvedFactoryModels(
                    PROVIDER_NAME,
                    PROVIDER_BASE_URL,
                    PROVIDER_API,
                    liveModels,
                    catalog,
                ),
            ];
        },
    };
}

// ── streamSimple Adapter ──

function streamFactorySimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
): AssistantMessageEventStream {
    const apiKey = options?.apiKey ?? "";

    // Try to extract Google access token from stored credentials
    let googleAccessToken: string | undefined;
    try {
        const rawOpts = options as Record<string, unknown> | undefined;
        const cred = rawOpts?.credentials;
        if (cred) {
            googleAccessToken = getGoogleAccessToken(
                cred as import("@earendil-works/pi-ai").OAuthCredentials,
            );
        }
    } catch {
        // credentials not in options — OK, relay-only mode
    }

    const streamConfig: FactoryStreamConfig = {
        apiKey,
        cwd: process.cwd(),
        googleAccessToken,
    };

    return streamFactory(model, context, options, streamConfig);
}

// ── Provider registration ──

/**
 * Register the Factory AI provider with Pi.
 *
 * @param pi - The Pi extension API
 * @param options - Optional overrides for testing: `catalog` injects the
 *   models.dev lookup used for enrichment (defaults to the process-wide
 *   catalog); `fetchModels` injects the SDK catalog fetcher.
 */
export function registerFactoryProvider(
    pi: ExtensionAPI,
    options?: {
        catalog?: FactoryCatalogLookup;
        fetchModels?: typeof fetchFactoryModels;
    },
): FactoryProviderHandle {
    const catalog = options?.catalog ?? getModelsDevCatalog();
    const fetchModels = options?.fetchModels ?? fetchFactoryModels;

    // Initial registration uses whatever is currently cached (possibly empty).
    // The live model list is fetched on login and on the first projection when
    // credentials exist.
    pi.registerProvider(PROVIDER_NAME, buildProviderConfig(catalog));

    const handle: FactoryProviderHandle = {
        providerId: PROVIDER_NAME,
        async refreshProjection(ctx, projectionOptions) {
            const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_NAME);
            const apiKey = auth?.auth.apiKey;
            // Normal metadata projections reuse cached availability. Explicit
            // forced projections rediscover the provider-owned live catalog.
            if (
                apiKey &&
                (projectionOptions?.force ||
                    getCachedFactoryModels().length === 0)
            ) {
                await fetchModels(apiKey, ctx.cwd);
            }
            pi.registerProvider(PROVIDER_NAME, buildProviderConfig(catalog));
        },
    };

    return handle;
}
