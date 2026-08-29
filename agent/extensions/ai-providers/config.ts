/** ai-providers dedicated configuration loader. */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { loadExtensionConfig } from "../_shared/config-loader.ts";

// oxlint-disable-next-line typescript/no-restricted-types -- config-loader passes untrusted JSON as unknown.
type UntrustedJson = unknown;

type CpaApi = "openai-completions" | "openai-responses";

export interface CpaMetadataRule {
    match: {
        id: string;
        ownedBy?: string;
    };
    metadata: {
        api?: CpaApi;
        contextWindow?: number;
        maxTokens?: number;
        reasoning?: boolean;
        input?: Array<"text" | "image">;
        cost?: Partial<ProviderModelConfig["cost"]>;
    };
}

export interface AiProvidersConfig {
    providers: Record<string, boolean>;
    widgets: Record<string, boolean>;
    maxVisibleRows?: number;
    cpa: {
        /** Refresh TTL for the CPA catalog guard. Defaults to 30 seconds. */
        refreshTtlMs?: number;
        /** Suppresses CPA catalog drift warnings when true. */
        silentCatalogDiff?: boolean;
        /** Local metadata rules. Globs apply before exact model IDs. */
        metadataRules?: CpaMetadataRule[];
    };
}

const DEFAULT_CONFIG: AiProvidersConfig = {
    providers: {},
    widgets: {},
    cpa: { refreshTtlMs: 30_000, metadataRules: [] },
};

function isRecord(
    value: UntrustedJson,
): value is Record<string, UntrustedJson> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeBooleanMap(raw: UntrustedJson): Record<string, boolean> {
    if (!isRecord(raw)) return {};
    const result: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "boolean") result[key] = value;
    }
    return result;
}

function isPositiveInteger(value: UntrustedJson): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function normalizeInput(
    raw: UntrustedJson,
): Array<"text" | "image"> | undefined {
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    if (!raw.every((item) => item === "text" || item === "image")) {
        return undefined;
    }
    if (!raw.includes("text")) return undefined;
    return raw.includes("image") ? ["text", "image"] : ["text"];
}

function normalizeCost(
    raw: UntrustedJson,
): Partial<ProviderModelConfig["cost"]> | undefined {
    if (!isRecord(raw)) return undefined;
    const cost: Partial<ProviderModelConfig["cost"]> = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        const value = raw[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
            cost[key] = value;
        }
    }
    return Object.keys(cost).length > 0 ? cost : undefined;
}

function normalizeMetadataRule(
    raw: UntrustedJson,
): CpaMetadataRule | undefined {
    if (!isRecord(raw) || !isRecord(raw.match) || !isRecord(raw.metadata)) {
        return undefined;
    }
    const id = raw.match.id;
    const ownedBy = raw.match.ownedBy;
    if (typeof id !== "string" || id.length === 0) return undefined;
    if (
        ownedBy !== undefined &&
        (typeof ownedBy !== "string" || ownedBy.length === 0)
    ) {
        return undefined;
    }

    const metadata: CpaMetadataRule["metadata"] = {};
    if (
        raw.metadata.api === "openai-completions" ||
        raw.metadata.api === "openai-responses"
    ) {
        metadata.api = raw.metadata.api;
    }
    if (isPositiveInteger(raw.metadata.contextWindow)) {
        metadata.contextWindow = raw.metadata.contextWindow;
    }
    if (isPositiveInteger(raw.metadata.maxTokens)) {
        metadata.maxTokens = raw.metadata.maxTokens;
    }
    if (typeof raw.metadata.reasoning === "boolean") {
        metadata.reasoning = raw.metadata.reasoning;
    }
    const input = normalizeInput(raw.metadata.input);
    if (input) metadata.input = input;
    const cost = normalizeCost(raw.metadata.cost);
    if (cost) metadata.cost = cost;
    if (Object.keys(metadata).length === 0) return undefined;

    return {
        match: ownedBy === undefined ? { id } : { id, ownedBy },
        metadata,
    };
}

export function normalizeAiProvidersConfig(
    raw: UntrustedJson,
): Partial<AiProvidersConfig> {
    if (!isRecord(raw)) return {};
    const rawCpa = isRecord(raw.cpa) ? raw.cpa : {};
    const config: Partial<AiProvidersConfig> = {
        providers: normalizeBooleanMap(raw.providers),
        widgets: normalizeBooleanMap(raw.widgets),
    };

    const cpa: Partial<AiProvidersConfig["cpa"]> = {};
    if (isPositiveInteger(rawCpa.refreshTtlMs)) {
        cpa.refreshTtlMs = rawCpa.refreshTtlMs;
    }
    if (typeof rawCpa.silentCatalogDiff === "boolean") {
        cpa.silentCatalogDiff = rawCpa.silentCatalogDiff;
    }
    if (Array.isArray(rawCpa.metadataRules)) {
        const rules = rawCpa.metadataRules
            .map(normalizeMetadataRule)
            .filter((rule): rule is CpaMetadataRule => rule !== undefined);
        if (rules.length > 0) cpa.metadataRules = rules;
    }
    if (Object.keys(cpa).length > 0)
        config.cpa = cpa as AiProvidersConfig["cpa"];

    if (typeof raw.maxVisibleRows === "number") {
        config.maxVisibleRows = raw.maxVisibleRows;
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
        cpa: {
            refreshTtlMs:
                overrideCpa.refreshTtlMs ?? baseCpa.refreshTtlMs ?? 30_000,
            silentCatalogDiff:
                overrideCpa.silentCatalogDiff ?? baseCpa.silentCatalogDiff,
            metadataRules: [
                ...(baseCpa.metadataRules ?? []),
                ...(overrideCpa.metadataRules ?? []),
            ],
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
