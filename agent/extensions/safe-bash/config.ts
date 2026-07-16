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
    /**
     * Shell commands (by first word) allowed to bypass native-tool redirection
     * in standard profile. Empty = redirection enforced as usual.
     * `isDangerous()` still runs on these commands — only the redirect is bypassed.
     */
    allowedShellCommands: string[];
}

export const DEFAULT_SAFE_BASH_CONFIG: SafeBashConfig = {
    mode: 'coexist',
    allowedShellCommands: [],
};

/**
 * Normalize raw JSON → Partial<SafeBashConfig>.
 * Keeps only valid `mode` and `allowedShellCommands` fields; drops everything else.
 */
export function normalizeSafeBashConfig(raw: unknown): Partial<SafeBashConfig> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return {};
    }
    const obj = raw as Record<string, unknown>;
    const result: Partial<SafeBashConfig> = {};

    const mode = obj.mode;
    if (mode === 'replace' || mode === 'coexist') {
        result.mode = mode;
    }

    const allowed = obj.allowedShellCommands;
    if (Array.isArray(allowed)) {
        const filtered = allowed.filter(
            (entry): entry is string => typeof entry === 'string',
        );
        if (filtered.length > 0) {
            result.allowedShellCommands = filtered;
        }
    }

    return result;
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
