/**
 * Shared, provider-agnostic model rules engine.
 *
 * Evaluates pattern-based overrides against standard Pi ProviderModelConfig.
 */

import type { ModelCostTier } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { [key: string]: JsonValue | undefined };
export type JsonArray = JsonValue[];
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export interface ModelRuleMatch {
    id: string;
    provider?: string;
    ownedBy?: string;
    [key: string]: JsonValue | undefined;
}

export interface ModelRule {
    match: ModelRuleMatch;
    metadata: Partial<Omit<ProviderModelConfig, "id">> & Record<string, JsonValue | undefined>;
}

const KNOWN_METADATA_KEYS = new Set([
    "api",
    "name",
    "baseUrl",
    "contextWindow",
    "maxTokens",
    "reasoning",
    "input",
    "cost",
    "thinkingLevelMap",
    "compat",
    "samplingParams",
    "headers",
]);

function isRecord(value: JsonValue | undefined): value is JsonObject {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: JsonValue | undefined): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function matchesGlob(pattern: string, value: string): boolean {
    let patternIndex = 0;
    let valueIndex = 0;
    let starIndex = -1;
    let starValueIndex = 0;

    while (valueIndex < value.length) {
        if (
            pattern[patternIndex] === "?" ||
            pattern[patternIndex] === value[valueIndex]
        ) {
            patternIndex++;
            valueIndex++;
        } else if (pattern[patternIndex] === "*") {
            starIndex = patternIndex++;
            starValueIndex = valueIndex;
        } else if (starIndex >= 0) {
            patternIndex = starIndex + 1;
            valueIndex = ++starValueIndex;
        } else {
            return false;
        }
    }

    while (pattern[patternIndex] === "*") patternIndex++;
    return patternIndex === pattern.length;
}

export function isExactRule(rule: ModelRule): boolean {
    return !rule.match.id.includes("*") && !rule.match.id.includes("?");
}

export function matchesModelRule(
    rule: ModelRule,
    target: { id: string; provider?: string; [key: string]: JsonValue | undefined },
): boolean {
    if (!matchesGlob(rule.match.id, target.id)) {
        return false;
    }
    if (
        rule.match.provider !== undefined &&
        rule.match.provider !== target.provider
    ) {
        return false;
    }
    for (const [key, value] of Object.entries(rule.match)) {
        if (key === "id" || key === "provider") continue;
        if (value !== undefined && target[key] !== value) {
            return false;
        }
    }
    return true;
}

function normalizeCost(raw: JsonValue | undefined): Partial<ProviderModelConfig["cost"]> | undefined {
    if (!isRecord(raw)) return undefined;
    const cost: Partial<ProviderModelConfig["cost"]> = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        const value = raw[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
            cost[key] = value;
        }
    }
    if (Array.isArray(raw.tiers)) {
        const tiers: ModelCostTier[] = [];
        for (const tier of raw.tiers) {
            if (isRecord(tier) && typeof tier.inputTokensAbove === "number" && tier.inputTokensAbove > 0) {
                const normalizedTier: ModelCostTier = {
                    inputTokensAbove: tier.inputTokensAbove,
                    input: typeof tier.input === "number" && tier.input >= 0 ? tier.input : 0,
                    output: typeof tier.output === "number" && tier.output >= 0 ? tier.output : 0,
                    cacheRead: typeof tier.cacheRead === "number" && tier.cacheRead >= 0 ? tier.cacheRead : 0,
                    cacheWrite: typeof tier.cacheWrite === "number" && tier.cacheWrite >= 0 ? tier.cacheWrite : 0,
                };
                tiers.push(normalizedTier);
            }
        }
        if (tiers.length > 0) cost.tiers = tiers;
    }
    return Object.keys(cost).length > 0 ? cost : undefined;
}

function normalizeInput(raw: JsonValue | undefined): Array<"text" | "image"> | undefined {
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    if (!raw.every((item) => item === "text" || item === "image")) {
        return undefined;
    }
    if (!raw.includes("text")) return undefined;
    return raw.includes("image") ? ["text", "image"] : ["text"];
}

export function normalizeModelRule(raw: JsonValue | undefined): ModelRule | undefined {
    if (!isRecord(raw) || !isRecord(raw.match) || !isRecord(raw.metadata)) {
        return undefined;
    }
    const id = raw.match.id;
    if (typeof id !== "string" || id.length === 0) return undefined;

    const ownedBy = raw.match.ownedBy;
    if (ownedBy !== undefined && (typeof ownedBy !== "string" || ownedBy.length === 0)) {
        return undefined;
    }

    const provider = raw.match.provider;
    if (provider !== undefined && (typeof provider !== "string" || provider.length === 0)) {
        return undefined;
    }

    const match: ModelRuleMatch = { id };
    if (provider !== undefined) match.provider = provider;
    if (ownedBy !== undefined) match.ownedBy = ownedBy;

    for (const [key, value] of Object.entries(raw.match)) {
        if (key === "id" || key === "provider" || key === "ownedBy") continue;
        if (value !== undefined) {
            match[key] = value;
        }
    }

    const metadata: ModelRule["metadata"] = {};
    if (typeof raw.metadata.api === "string" && raw.metadata.api.length > 0) {
        metadata.api = raw.metadata.api as ProviderModelConfig["api"];
    }
    if (typeof raw.metadata.name === "string" && raw.metadata.name.length > 0) {
        metadata.name = raw.metadata.name;
    }
    if (typeof raw.metadata.baseUrl === "string" && raw.metadata.baseUrl.length > 0) {
        metadata.baseUrl = raw.metadata.baseUrl;
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
    if (cost) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        metadata.cost = cost as ProviderModelConfig["cost"];
    }

    if (isRecord(raw.metadata.thinkingLevelMap)) {
        metadata.thinkingLevelMap = { ...raw.metadata.thinkingLevelMap } as ProviderModelConfig["thinkingLevelMap"];
    }
    if (isRecord(raw.metadata.compat)) {
        metadata.compat = { ...raw.metadata.compat } as ProviderModelConfig["compat"];
    }
    if (isRecord(raw.metadata.samplingParams)) {
        metadata.samplingParams = { ...raw.metadata.samplingParams };
    }
    if (isRecord(raw.metadata.headers)) {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw.metadata.headers)) {
            if (typeof v === "string") headers[k] = v;
        }
        if (Object.keys(headers).length > 0) metadata.headers = headers;
    }

    // Pass through any other unknown properties (skipping known invalid ones)
    for (const [key, value] of Object.entries(raw.metadata)) {
        if (!KNOWN_METADATA_KEYS.has(key) && value !== undefined) {
            metadata[key] = value;
        }
    }

    if (Object.keys(metadata).length === 0) return undefined;

    return { match, metadata };
}

export function mergeModelMetadata(
    base: ProviderModelConfig,
    override: Record<string, JsonValue | undefined>,
): ProviderModelConfig {
    const baseCast = base as ProviderModelConfig & { samplingParams?: JsonObject };
    // SAFETY: result is a cloned ProviderModelConfig with validated overrides applied.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const result = { ...base } as ProviderModelConfig & { [key: string]: JsonValue | undefined };

    for (const [key, value] of Object.entries(override)) {
        if (value === undefined) continue;

        if (key === "thinkingLevelMap" && isRecord(value)) {
            result.thinkingLevelMap = {
                ...(base.thinkingLevelMap ? base.thinkingLevelMap : {}),
                ...value,
            } as ProviderModelConfig["thinkingLevelMap"];
        } else if (key === "compat" && isRecord(value)) {
            result.compat = {
                ...(base.compat ? base.compat : {}),
                ...value,
            } as ProviderModelConfig["compat"];
        } else if (key === "samplingParams" && isRecord(value)) {
            result.samplingParams = {
                ...(baseCast.samplingParams ? baseCast.samplingParams : {}),
                ...value,
            };
        } else if (key === "headers" && isRecord(value)) {
            const headers: Record<string, string> = {
                ...(base.headers ? base.headers : {}),
            };
            for (const [hKey, hVal] of Object.entries(value)) {
                if (typeof hVal === "string") headers[hKey] = hVal;
            }
            result.headers = headers;
        } else if (key === "cost" && isRecord(value)) {
            const baseCost = base.cost ? base.cost : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
            const overrideCost = value as Partial<ProviderModelConfig["cost"]>;
            result.cost = {
                ...baseCost,
                ...overrideCost,
                ...(overrideCost.tiers ? { tiers: overrideCost.tiers } : {}),
            } as ProviderModelConfig["cost"];
        } else {
            result[key] = value;
        }
    }

    return result;
}

export function applyModelRules(
    model: ProviderModelConfig,
    rules: readonly ModelRule[],
    context?: Record<string, JsonValue | undefined>,
): ProviderModelConfig {
    const target = { id: model.id, ...context };

    const matchingRules = [
        ...rules.filter((rule) => !isExactRule(rule) && matchesModelRule(rule, target)),
        ...rules.filter((rule) => isExactRule(rule) && matchesModelRule(rule, target)),
    ];

    let current = model;
    for (const rule of matchingRules) {
        current = mergeModelMetadata(current, rule.metadata);
    }
    return current;
}
