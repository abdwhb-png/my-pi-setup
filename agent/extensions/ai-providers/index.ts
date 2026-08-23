/**
 * ai-providers — General-purpose Pi extension for subscription-based model providers.
 *
 * Currently supports:
 * - CLIProxyAPI (cpa) — local proxy with dynamic model discovery
 *
 * Future providers can be added under providers/ without restructuring.
 *
 * Composition rules:
 * - index.ts stays composition-only: lifecycle lives in models-dev.ts,
 *   transformations live in the provider model files.
 * - The shared models.dev integration is registered before the providers, but
 *   receives a closure that reads the completed refresher list (every enabled
 *   provider handle is pushed into `refreshers` after registration).
 *
 * Provider availability can be controlled via settings:
 * - ~/.pi/agent/settings.json under key "aiProviders"
 * - <cwd>/.pi/settings.json under key "aiProviders"
 * - legacy fallback: ~/.pi/agent/ai-providers.json and <cwd>/.pi/ai-providers.json
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getModelsDevCatalog } from "../_shared/models-dev/catalog";
import { registerProvidersCommand } from "./commands/providers.ts";
import { isProviderEnabled, isWidgetEnabled } from "./config.ts";
import {
    registerModelsDevIntegration,
    type ProviderProjectionHandle,
} from "./models-dev.ts";
import { registerCpaProvider } from "./providers/cpa.ts";

const CPA_PROVIDER = "cpa";

export default function aiProvidersExtension(pi: ExtensionAPI): void {
    const cwd = process.cwd();

    // Shared models.dev lifecycle: owns disk load, stale checks, warning
    // dedup, /models-dev-refresh, and the projection fanout. Registered first,
    // but the closure reads the refresher list after providers fill it.
    const refreshers: ProviderProjectionHandle[] = [];
    registerModelsDevIntegration(pi, getModelsDevCatalog(), () => refreshers);

    // ── CLIProxyAPI (CPA) ──
    if (isProviderEnabled(CPA_PROVIDER, cwd)) {
        refreshers.push(registerCpaProvider(pi));
    }

    // ── Future providers go here ──
    // Example:
    // if (isProviderEnabled("openrouter", cwd)) registerOpenRouterProvider(pi);
    // if (isProviderEnabled("groq", cwd)) registerGroqProvider(pi);

    // ── Global Commands ──
    registerProvidersCommand(pi);
}
