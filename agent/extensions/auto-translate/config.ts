/**
 * auto-translate config loader.
 *
 * Wraps the shared `_shared/config-loader.ts` `loadExtensionConfig<T>()` helper.
 *
 * Sources (merged in order, later wins):
 *   1. settings.json key "translate" (global -> project)
 *   2. legacy file translate.json (global -> project) — fallback only
 */

import { loadExtensionConfig } from '../_shared/config-loader.ts';
import {
    DEFAULT_CONFIG,
    type TranslateConfig,
    type LanguagesMap,
} from './types.ts';

/** Type guard: a plain string-keyed object (not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalize a single parsed JSON object into a partial config, dropping invalid fields. */
export function normalizeTranslateConfig(
    raw: unknown,
): Partial<TranslateConfig> {
    if (!isRecord(raw)) return {};
    const value = raw;

    const result: Partial<TranslateConfig> = {};

    if (typeof value.model === 'string' && value.model.length > 0) {
        result.model = value.model;
    }
    if (
        typeof value.defaultTargetLanguage === 'string' &&
        value.defaultTargetLanguage.length > 0
    ) {
        result.defaultTargetLanguage = value.defaultTargetLanguage;
    }

    if (isRecord(value.languages)) {
        const languages: LanguagesMap = {};
        for (const [code, name] of Object.entries(value.languages)) {
            if (typeof name === 'string' && name.length > 0) {
                languages[code] = name;
            }
        }
        result.languages = languages;
    }

    return result;
}

/** Deep-merge languages (union, overlay wins on conflict); shallow for scalars. */
export function mergeTranslateConfig(
    base: TranslateConfig,
    overlay: Partial<TranslateConfig>,
): TranslateConfig {
    return {
        model: overlay.model ?? base.model,
        defaultTargetLanguage:
            overlay.defaultTargetLanguage ?? base.defaultTargetLanguage,
        languages: {
            ...base.languages,
            ...overlay.languages,
        },
    };
}

/** Load and merge the translate config from all configured sources. */
export function loadTranslateConfig(
    cwd: string,
    agentDir?: string,
): TranslateConfig {
    return loadExtensionConfig<TranslateConfig>(cwd, {
        defaults: DEFAULT_CONFIG,
        normalize: normalizeTranslateConfig,
        merge: mergeTranslateConfig,
        sources: [
            {
                settingsKey: 'translate',
                legacyFilename: 'translate.json',
                projectLocal: true,
            },
        ],
        agentDir,
    });
}
