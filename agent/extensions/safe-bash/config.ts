/**
 * Config loader for the safe-bash extension.
 *
 * Reads the `safeBash` key from settings.json (global + project) via the
 * shared config-loader. Project settings override global.
 *
 * Schema (settings.json):
 *   "safeBash": { "mode": "replace" | "coexist" }
 *
 * Unknown / invalid values fall back to the default ("coexist").
 */
import type { SettingsManager } from '@earendil-works/pi-coding-agent';
import { loadExtensionConfig } from '../_shared/config-loader.ts';

export type SafeBashMode = 'coexist' | 'replace';

export interface SafeBashConfig {
    mode: SafeBashMode;
}

export const DEFAULT_SAFE_BASH_CONFIG: SafeBashConfig = {
    mode: 'coexist',
};

/**
 * Normalize raw JSON → Partial<SafeBashConfig>.
 * Keeps only a valid `mode` field; drops everything else.
 */
export function normalizeSafeBashConfig(raw: unknown): Partial<SafeBashConfig> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return {};
    }
    const obj = raw as Record<string, unknown>;
    const mode = obj.mode;
    if (mode === 'replace' || mode === 'coexist') {
        return { mode };
    }
    return {};
}

/**
 * Load safe-bash config from settings.json via the shared config-loader.
 *
 * @param cwd - Working directory (defaults to process.cwd())
 * @param agentDir - Agent directory override (for testing)
 * @param _settingsManager - Injected SettingsManager (for testing)
 */
export function loadSafeBashConfig(
    cwd: string = process.cwd(),
    agentDir?: string,
    _settingsManager?: SettingsManager,
): SafeBashConfig {
    return loadExtensionConfig<SafeBashConfig>(cwd, {
        defaults: DEFAULT_SAFE_BASH_CONFIG,
        normalize: normalizeSafeBashConfig,
        sources: [{ settingsKey: 'safeBash' }],
        agentDir,
        _settingsManager,
    });
}
