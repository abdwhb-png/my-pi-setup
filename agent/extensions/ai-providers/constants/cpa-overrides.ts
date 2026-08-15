import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

type ProviderOverride = Partial<
    Pick<
        ProviderModelConfig,
        "contextWindow" | "maxTokens" | "reasoning" | "cost"
    >
>;

/**
 * Named override tables consumed by `enrichModel`. The config key
 * `aiProviders.cpa.overridePrefixes` maps a CPA model-id prefix to one of
 * these table names (default `{ ocg: "go" }`). Each table is keyed by the
 * model alias as it appears after the prefix — e.g. `go-glm-5.2` for
 * `cpa/ocg/go-glm-5.2`.
 *
 * Adding/renaming a provider whose models reuse an existing family: config
 * edit only, no code change. Adding a brand-new family: add a new table here
 * plus one config entry pointing at it. Per-model pricing/specs cannot be
 * derived and always belong in code (verify per AGENTS.md model-config rules).
 */
export const OVERRIDE_TABLES: Record<
    string,
    Record<string, ProviderOverride>
> = {
    go: {
        "go-glm-5.2": {
            contextWindow: 1_000_000,
            maxTokens: 131_072,
            reasoning: true,
            cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
        },
        "go-glm-5.1": {
            contextWindow: 200_000,
            maxTokens: 128_000,
            reasoning: true,
            cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
        },
        "go-kimi-k2.7-code": {
            contextWindow: 262_144,
            maxTokens: 33_000,
            reasoning: true,
            cost: { input: 0.95, output: 4.0, cacheRead: 0.19, cacheWrite: 0 },
        },
        "go-kimi-k2.6": {
            contextWindow: 262_144,
            maxTokens: 16_384,
            reasoning: true,
            cost: { input: 0.95, output: 4.0, cacheRead: 0.16, cacheWrite: 0 },
        },
        "go-deepseek-v4-pro": {
            contextWindow: 1_000_000,
            maxTokens: 384_000,
            reasoning: true,
            cost: {
                input: 1.74,
                output: 3.48,
                cacheRead: 0.0145,
                cacheWrite: 0,
            },
        },
        "go-deepseek-v4-flash": {
            contextWindow: 1_000_000,
            maxTokens: 384_000,
            reasoning: true,
            cost: {
                input: 0.14,
                output: 0.28,
                cacheRead: 0.0028,
                cacheWrite: 0,
            },
        },
        "go-mimo-v2.5": {
            contextWindow: 1_000_000,
            maxTokens: 128_000,
            reasoning: true,
            cost: {
                input: 0.14,
                output: 0.28,
                cacheRead: 0.0028,
                cacheWrite: 0,
            },
        },
        "go-mimo-v2.5-pro": {
            contextWindow: 1_000_000,
            maxTokens: 131_072,
            reasoning: true,
            cost: {
                input: 1.74,
                output: 3.48,
                cacheRead: 0.0145,
                cacheWrite: 0,
            },
        },
        "deepseek-v4-flash-free": {
            contextWindow: 1_000_000,
            maxTokens: 131_072,
            reasoning: true,
            cost: {
                input: 0.14,
                output: 0.28,
                cacheRead: 0.0028,
                cacheWrite: 0,
            },
        },
        "mimo-v2.5-free": {
            contextWindow: 1_000_000,
            maxTokens: 128_000,
            reasoning: true,
            cost: {
                input: 0.14,
                output: 0.28,
                cacheRead: 0.0028,
                cacheWrite: 0,
            },
        },
    }, // end table "go"
};
