/** ai-providers dedicated configuration loader. */

import { loadExtensionConfig } from "../_shared/config-loader.ts";
import {
    normalizeModelRule,
    type JsonValue,
    type ModelRule,
} from "./rules/model-rules.ts";

export type { ModelRule } from "./rules/model-rules.ts";

/** Backward-compatible alias for legacy consumers. */
export type CpaMetadataRule = ModelRule;

export interface AiProvidersConfig {
    providers: Record<string, boolean>;
    widgets: Record<string, boolean>;
    maxVisibleRows?: number;
    /** Provider-agnostic model rules. Globs apply before exact model IDs. */
    modelRules?: ModelRule[];
    cpa: {
        /** Refresh TTL for the CPA catalog guard. Defaults to 30 seconds. */
        refreshTtlMs?: number;
        /** Suppresses CPA catalog drift warnings when true. */
        silentCatalogDiff?: boolean;
    };
}

const DEFAULT_CONFIG: AiProvidersConfig = {
    providers: {},
    widgets: {},
    modelRules: [],
    cpa: { refreshTtlMs: 30_000 },
};

function isRecord(
    value: JsonValue | undefined,
): value is Record<string, JsonValue | undefined> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeBooleanMap(raw: JsonValue | undefined): Record<string, boolean> {
    if (!isRecord(raw)) return {};
    const result: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "boolean") result[key] = value;
    }
    return result;
}

function isPositiveInteger(value: JsonValue | undefined): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function normalizeAiProvidersConfig(
    // oxlint-disable-next-line typescript/no-restricted-types -- config-loader passes untrusted JSON as unknown.
    raw: unknown,
): Partial<AiProvidersConfig> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const rawJson = raw as JsonValue | undefined;
    if (!isRecord(rawJson)) return {};
    const rawCpa = isRecord(rawJson.cpa) ? rawJson.cpa : {};
    const config: Partial<AiProvidersConfig> = {
        providers: normalizeBooleanMap(rawJson.providers),
        widgets: normalizeBooleanMap(rawJson.widgets),
    };

    if (Array.isArray(rawJson.modelRules)) {
        const rules = rawJson.modelRules
            .map(normalizeModelRule)
            .filter((rule): rule is ModelRule => rule !== undefined);
        if (rules.length > 0) config.modelRules = rules;
    }

    const cpa: Partial<AiProvidersConfig["cpa"]> = {};
    if (isPositiveInteger(rawCpa.refreshTtlMs)) {
        cpa.refreshTtlMs = rawCpa.refreshTtlMs;
    }
    if (typeof rawCpa.silentCatalogDiff === "boolean") {
        cpa.silentCatalogDiff = rawCpa.silentCatalogDiff;
    }
    if (Object.keys(cpa).length > 0)
        config.cpa = cpa as AiProvidersConfig["cpa"];

    if (typeof rawJson.maxVisibleRows === "number") {
        config.maxVisibleRows = rawJson.maxVisibleRows;
    }
    return config;
}

export function mergeAiProvidersConfig(
    base: AiProvidersConfig,
    overrides: Partial<AiProvidersConfig>,
): AiProvidersConfig {
    const baseCpa = base.cpa ?? DEFAULT_CONFIG.cpa;
    const overrideCpa: Partial<AiProvidersConfig["cpa"]> = overrides.cpa ?? {};
    return {
        providers: { ...base.providers, ...overrides.providers },
        widgets: { ...base.widgets, ...overrides.widgets },
        maxVisibleRows: overrides.maxVisibleRows ?? base.maxVisibleRows,
        modelRules: [
            ...(base.modelRules ?? []),
            ...(overrides.modelRules ?? []),
        ],
        cpa: {
            refreshTtlMs:
                overrideCpa.refreshTtlMs ?? baseCpa.refreshTtlMs ?? 30_000,
            silentCatalogDiff:
                overrideCpa.silentCatalogDiff ?? baseCpa.silentCatalogDiff,
        },
    };
}

/**
 * Loads only dedicated legacy config files:
 * `~/.pi/agent/ai-providers.json`, then `<cwd>/.pi/ai-providers.json`.
 */
export function loadAiProvidersConfig(cwd = process.cwd()): AiProvidersConfig {
    return loadExtensionConfig(cwd, {
        defaults: DEFAULT_CONFIG,
        normalize: normalizeAiProvidersConfig,
        merge: mergeAiProvidersConfig,
        sources: [{ legacyFilename: "ai-providers.json" }],
    });
}

export function isProviderEnabled(
    providerName: string,
    cwd = process.cwd(),
): boolean {
    return loadAiProvidersConfig(cwd).providers[providerName] ?? true;
}

export function isWidgetEnabled(
    widgetId: string,
    cwd = process.cwd(),
): boolean {
    return loadAiProvidersConfig(cwd).widgets[widgetId] ?? true;
}
