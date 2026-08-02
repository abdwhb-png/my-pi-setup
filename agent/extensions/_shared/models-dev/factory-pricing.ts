import type { ModelsDevCost } from "./catalog";

/** Factory-owned route prices in USD per million tokens. */
export const FACTORY_ROUTE_COSTS: Readonly<Record<string, ModelsDevCost>> = {
    "glm-5.2": { input: 0.5, output: 2 },
    "glm-5.1": { input: 0.5, output: 2 },
    "nemotron-3-ultra": { input: 0.5, output: 2 },
    "kimi-k2.7-code": { input: 0.95, output: 4 },
    "kimi-k2.6": { input: 0.95, output: 4 },
    "kimi-k2.5": { input: 0.95, output: 4 },
    "deepseek-v4-pro": { input: 0.5, output: 2 },
    "minimax-m3": { input: 0.5, output: 2 },
    "minimax-m2.7": { input: 0.5, output: 2 },
    "minimax-m2.5": { input: 0.5, output: 2 },
};

const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** Merge only defined values so explicit zero survives and absent fields do not erase facts. */
export function mergeDefinedCosts(
    base: ModelsDevCost = {},
    override: ModelsDevCost = {},
): ModelsDevCost {
    const merged: ModelsDevCost = { ...base };
    for (const field of COST_FIELDS) {
        const value = override[field];
        if (value !== undefined) merged[field] = value;
    }
    return merged;
}

export function applyFactoryRouteCostOverride(
    modelId: string,
    base: ModelsDevCost = {},
): { cost: ModelsDevCost; overridden: boolean } {
    const override = FACTORY_ROUTE_COSTS[modelId];
    return override
        ? { cost: mergeDefinedCosts(base, override), overridden: true }
        : { cost: base, overridden: false };
}
