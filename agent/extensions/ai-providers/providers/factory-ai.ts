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
import {
	fetchFactoryModels,
	getCachedFactoryModels,
	toProviderModels,
	toResolvedFactoryModels,
} from "./factory-models.ts";
import {
	createFactoryOAuth,
	getGoogleAccessToken,
} from "../shared/oauth.ts";
import {
	streamFactory,
	type FactoryStreamConfig,
} from "../shared/sdk-bridge.ts";

// ── Constants ──

const PROVIDER_NAME = "factory-ai";
const PROVIDER_DISPLAY = "Factory AI";
const API_KEY_URL = "https://app.factory.ai/settings/api-keys";
const PROVIDER_BASE_URL = "https://api.factory.ai";
const PROVIDER_API = "openai-completions" as const;

// ── Provider config helpers ──

function buildProviderConfig() {
	return {
		baseUrl: PROVIDER_BASE_URL,
		api: PROVIDER_API,
		models: toProviderModels(),
		oauth: createFactoryOAuthConfig(),
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
		if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("authentication")) {
			return "Invalid API key. Please check your key at " + API_KEY_URL;
		}
		if (msg.includes("ENOENT") || msg.includes("command not found") || msg.includes("droid")) {
			return "Droid CLI not found. Install it first: npm install -g @factory/droid";
		}
		return `API key validation failed: ${msg}`;
	}
}

// ── OAuth Config ──

function createFactoryOAuthConfig() {
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
				...toResolvedFactoryModels(PROVIDER_NAME, PROVIDER_BASE_URL, PROVIDER_API, liveModels),
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

export function registerFactoryProvider(pi: ExtensionAPI): void {
	// Initial registration uses whatever is currently cached (possibly empty).
	// The live model list is fetched on login and on session_start when creds exist.
	pi.registerProvider(PROVIDER_NAME, buildProviderConfig());

	// Re-register on session start if user is already logged in
	pi.on("session_start", async (_event, ctx) => {
		try {
			const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_NAME);
			const apiKey = auth?.auth.apiKey;
			if (!apiKey) return;

			await fetchFactoryModels(apiKey, ctx.cwd);
			ctx.modelRegistry.registerProvider(PROVIDER_NAME, buildProviderConfig());
		} catch {
			// If model refresh fails, keep whatever model list we already have cached.
		}
	});
}
