/**
 * ai-providers — General-purpose Pi extension for subscription-based model providers.
 *
 * Currently supports:
 * - CLIProxyAPI (cpa) — configurable proxy with dynamic model discovery
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
 * Provider configuration: ~/.pi/agent/config/ai-providers.json and trusted <cwd>/.pi/config/ai-providers.json
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getModelsDevCatalog } from '../_shared/models-dev/catalog';
import { registerProvidersCommand } from './commands/providers.ts';
import { isProviderEnabled } from './config.ts';
import {
    registerModelsDevIntegration,
    type ProviderProjectionHandle,
} from './models-dev.ts';
import {
    registerCpaProvider,
    type CpaProviderHandle,
} from './providers/cpa.ts';

const CPA_PROVIDER = 'cpa';

export default async function aiProvidersExtension(
    pi: ExtensionAPI,
): Promise<void> {
    const cwd = process.cwd();

    // Shared models.dev lifecycle: owns disk load, stale checks, warning
    // dedup, /models-dev-refresh, and the projection fanout. Registered first,
    // but the closure reads the refresher list after providers fill it.
    const refreshers: ProviderProjectionHandle[] = [];
    let cpa: CpaProviderHandle | undefined;
    const catalog = getModelsDevCatalog();
    registerModelsDevIntegration(pi, catalog, () => refreshers);

    // ── CLIProxyAPI (CPA) ──
    if (isProviderEnabled(CPA_PROVIDER, cwd)) {
        cpa = registerCpaProvider(pi);
        refreshers.push(cpa);
        // Pi awaits the factory before resolving an explicit CLI model.
        // session_start is too late to publish a dynamically discovered model.
        await catalog.load();
        await cpa.refreshStartupProjection();
    }

    // ── Future providers go here ──
    // Example:
    // if (isProviderEnabled("openrouter", cwd)) registerOpenRouterProvider(pi);
    // if (isProviderEnabled("groq", cwd)) registerGroqProvider(pi);

    // ── Global Commands ──
    registerProvidersCommand(pi, () => cpa?.getAvailability());
}
