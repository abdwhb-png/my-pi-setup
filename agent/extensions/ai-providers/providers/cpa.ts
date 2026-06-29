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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
	buildCpaModels,
	STATIC_FALLBACK_MODELS,
} from "./cpa-models.ts";

// ── Constants ──

const PROVIDER_NAME = "cpa";
const PROVIDER_DISPLAY = "CLIProxyAPI (local)";
const PROVIDER_BASE_URL = "http://localhost:8317/v1";
const PROVIDER_API = "openai-completions" as const;
const CPA_API_KEY_ENV = "${CLIPROXY_API_KEY}";

// ── Provider config helpers ──

function buildProviderConfig(models: ProviderModelConfig[]) {
	return {
		name: PROVIDER_DISPLAY,
		baseUrl: PROVIDER_BASE_URL,
		api: PROVIDER_API,
		apiKey: CPA_API_KEY_ENV,
		models,
	};
}

// ── Registration ──

export function registerCpaProvider(pi: ExtensionAPI): void {
	// Phase 1: Register with static fallback models immediately (synchronous)
	pi.registerProvider(PROVIDER_NAME, buildProviderConfig(STATIC_FALLBACK_MODELS));

	// Phase 2: On session_start, fetch dynamic models and re-register
	pi.on("session_start", async (_event, ctx) => {
		try {
			const apiKey = process.env.CLIPROXY_API_KEY ?? "";
			const dynamicModels = await buildCpaModels(PROVIDER_BASE_URL, apiKey);
			if (dynamicModels.length > 0) {
				ctx.modelRegistry.registerProvider(PROVIDER_NAME, buildProviderConfig(dynamicModels));

				// Completeness check (console.warn only — never blocks startup)
				const staticIds = new Set(STATIC_FALLBACK_MODELS.map((m) => m.id));
				const dynamicIds = new Set(dynamicModels.map((m) => m.id));
				for (const id of dynamicIds) {
					if (!staticIds.has(id)) {
						console.warn(`[cpa] New model from CPA not in static fallback: ${id}`);
					}
				}
				for (const id of staticIds) {
					if (!dynamicIds.has(id)) {
						console.warn(`[cpa] Static fallback model not found in CPA: ${id}`);
					}
				}
			}
		} catch {
			// If dynamic fetch fails, keep static fallback models
		}
	});
}
