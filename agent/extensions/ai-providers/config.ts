/** Runtime loading of the shared AI-provider configuration contract. */
import { loadExtensionConfig } from "../_shared/config-loader.ts";
import {
    DEFAULT_CONFIG,
    normalizeAiProvidersConfig,
    mergeAiProvidersConfig,
    type AiProvidersConfig,
} from "./schema.ts";
export {
    normalizeAiProvidersConfig,
    mergeAiProvidersConfig,
    validateCpaBaseUrl,
} from "./schema.ts";
export type {
    AiProvidersConfig,
    CpaSettings,
    ProviderSettings,
    ModelRule,
} from "./schema.ts";
/**
 * Loads dedicated extension config files:
 * `~/.pi/agent/config/ai-providers.json`, then `<cwd>/.pi/config/ai-providers.json`.
 */
export function loadAiProvidersConfig(cwd = process.cwd()): AiProvidersConfig {
    return loadExtensionConfig(cwd, {
        defaults: DEFAULT_CONFIG,
        normalize: normalizeAiProvidersConfig,
        merge: mergeAiProvidersConfig,
        owner: "aiProviders",
    });
}

export function isProviderEnabled(
    providerName: string,
    cwd = process.cwd(),
): boolean {
    return loadAiProvidersConfig(cwd).providers[providerName]?.enabled ?? true;
}
