/** Pure configuration contract, also used by the portable setup preflight. */
import { isDeepStrictEqual } from "node:util";
import {
    normalizeModelRule,
    type JsonValue,
    type ModelRule,
} from "./rules/model-rules.ts";
export type { ModelRule } from "./rules/model-rules.ts";
export interface ProviderSettings {
    enabled?: boolean;
}
export interface CpaSettings extends ProviderSettings {
    baseUrl?: string;
    refreshTtlMs?: number;
    silentCatalogDiff?: boolean;
}
export interface AiProvidersConfig {
    providers: Record<string, ProviderSettings> & { cpa?: CpaSettings };
    maxVisibleRows?: number;
    /** Provider-agnostic model rules. Globs apply before exact model IDs. */
    modelRules?: ModelRule[];
}

const DEFAULT_CPA_CONFIG: CpaSettings = {
    enabled: true,
    refreshTtlMs: 30_000,
    silentCatalogDiff: false,
};
export const DEFAULT_CONFIG: AiProvidersConfig = {
    providers: { cpa: DEFAULT_CPA_CONFIG },
    maxVisibleRows: 20,
    modelRules: [],
};

function invalid(path: string): never {
    throw new Error(
        `Invalid ai-providers configuration: ${path}. Use providers.cpa for CPA settings and object entries with enabled booleans.`,
    );
}

export function validateCpaBaseUrl(value: string): string {
    const baseUrl = value.trim().replace(/\/+$/, "");
    const endpoint = URL.canParse(baseUrl) ? new URL(baseUrl) : undefined;
    if (
        !endpoint ||
        !["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        baseUrl.includes("?") ||
        baseUrl.includes("#")
    )
        invalid(
            "providers.cpa.baseUrl (or CLIPROXY_BASE_URL): expected an absolute HTTP(S) URL without credentials, query or fragment",
        );
    return baseUrl;
}

function isRecord(
    value: JsonValue | undefined,
): value is Record<string, JsonValue | undefined> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: JsonValue | undefined): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function normalizeAiProvidersConfig(
    // oxlint-disable-next-line typescript/no-restricted-types -- JSON boundary from config-loader.
    raw: unknown,
): Partial<AiProvidersConfig> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validated below.
    const input = raw as JsonValue | undefined;
    if (!isRecord(input)) invalid("expected an object");
    for (const key of Object.keys(input))
        if (!["providers", "maxVisibleRows", "modelRules"].includes(key))
            invalid(key);
    const config: Partial<AiProvidersConfig> = {};
    if (input.providers !== undefined) {
        if (!isRecord(input.providers)) invalid("providers");
        const providers: AiProvidersConfig["providers"] = {};
        for (const [name, value] of Object.entries(input.providers)) {
            if (!isRecord(value)) invalid(`providers.${name}`);
            const provider: CpaSettings = {};
            for (const key of Object.keys(value))
                if (
                    !(
                        name === "cpa"
                            ? [
                                  "enabled",
                                  "baseUrl",
                                  "refreshTtlMs",
                                  "silentCatalogDiff",
                              ]
                            : ["enabled"]
                    ).includes(key)
                )
                    invalid(`providers.${name}.${key}`);
            if (value.enabled !== undefined) {
                if (typeof value.enabled !== "boolean")
                    invalid(`providers.${name}.enabled`);
                provider.enabled = value.enabled;
            }
            if (value.baseUrl !== undefined) {
                if (typeof value.baseUrl !== "string")
                    invalid("providers.cpa.baseUrl");
                provider.baseUrl = validateCpaBaseUrl(value.baseUrl);
            }
            if (value.refreshTtlMs !== undefined) {
                if (!isPositiveInteger(value.refreshTtlMs))
                    invalid("providers.cpa.refreshTtlMs");
                provider.refreshTtlMs = value.refreshTtlMs;
            }
            if (value.silentCatalogDiff !== undefined) {
                if (typeof value.silentCatalogDiff !== "boolean")
                    invalid("providers.cpa.silentCatalogDiff");
                provider.silentCatalogDiff = value.silentCatalogDiff;
            }
            Object.defineProperty(providers, name, {
                value: provider,
                enumerable: true,
                writable: true,
                configurable: true,
            });
        }
        config.providers = providers;
    }
    if (input.modelRules !== undefined) {
        if (!Array.isArray(input.modelRules)) invalid("modelRules");
        config.modelRules = input.modelRules.map((value, index) => {
            const rule = normalizeModelRule(value);
            if (!rule || !isDeepStrictEqual(rule, value))
                invalid(`modelRules[${index}]`);
            return rule;
        });
    }
    if (input.maxVisibleRows !== undefined) {
        if (!isPositiveInteger(input.maxVisibleRows)) invalid("maxVisibleRows");
        config.maxVisibleRows = input.maxVisibleRows;
    }
    return config;
}

export function mergeAiProvidersConfig(
    base: AiProvidersConfig,
    overrides: Partial<AiProvidersConfig>,
): AiProvidersConfig {
    const providers = Object.fromEntries(
        [
            ...new Set([
                ...Object.keys(base.providers),
                ...Object.keys(overrides.providers ?? {}),
            ]),
        ].map((name) => [
            name,
            {
                ...base.providers[name],
                ...overrides.providers?.[name],
            },
        ]),
    );
    return {
        providers,
        maxVisibleRows: overrides.maxVisibleRows ?? base.maxVisibleRows,
        modelRules: [
            ...(base.modelRules ?? []),
            ...(overrides.modelRules ?? []),
        ],
    };
}
