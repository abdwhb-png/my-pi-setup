import {
    getModelsDevCatalog,
    type ModelsDevCatalog,
    type ModelsDevCatalogStatus,
    type ModelsDevCost,
} from "../_shared/models-dev/catalog";
import { applyFactoryRouteCostOverride } from "../_shared/models-dev/factory-pricing";
import { resolveUsageModelsDevRefs } from "../_shared/models-dev/mapping";
import type { ModelRates } from "./types";

/**
 * Split a source key at its first slash. Both halves must be non-empty after
 * trimming; anything else is malformed and unmappable.
 */
function splitSourceKey(
    sourceKey: string,
): { provider: string; model: string } | undefined {
    const slash = sourceKey.indexOf("/");
    if (slash <= 0 || slash === sourceKey.length - 1) return undefined;
    const provider = sourceKey.slice(0, slash);
    const model = sourceKey.slice(slash + 1);
    if (provider.trim().length === 0 || model.trim().length === 0) {
        return undefined;
    }
    return { provider, model };
}

/** Map catalog provenance to the ModelRates source vocabulary. */
function provenanceToSource(
    provenance: ModelsDevCatalogStatus["provenance"],
): ModelRates["source"] {
    switch (provenance) {
        case "cache":
            return "cached";
        case "network":
            return "models.dev";
        default:
            return "unavailable";
    }
}

/**
 * Project one matched catalog cost onto the report rates. A record is
 * available when any normalized cost field is defined — including explicit
 * zero. Every other required number is filled with zero only here.
 */
function projectRates(
    sourceKey: string,
    source: ModelRates["source"],
    cost: ModelsDevCost | undefined,
): ModelRates {
    const available =
        cost !== undefined &&
        (cost.input !== undefined ||
            cost.output !== undefined ||
            cost.cacheRead !== undefined ||
            cost.cacheWrite !== undefined);
    if (!available) {
        return {
            modelKey: sourceKey,
            inputPerMillion: 0,
            outputPerMillion: 0,
            cacheReadPerMillion: 0,
            cacheWritePerMillion: 0,
            source: "unavailable",
        };
    }
    return {
        modelKey: sourceKey,
        inputPerMillion: cost.input ?? 0,
        outputPerMillion: cost.output ?? 0,
        cacheReadPerMillion: cost.cacheRead ?? 0,
        cacheWritePerMillion: cost.cacheWrite ?? 0,
        source,
    };
}

/**
 * Look up pricing for a set of model source keys.
 * Returns a Map<sourceKey, ModelRates>.
 *
 * Resolves each key through the shared models.dev mapping and catalog: exact
 * reference lookup only — no raw models.dev JSON parsing and no contains
 * fallback. The catalog is loaded once; when no snapshot exists the one
 * refresh is awaited (`/usage --full` is explicit), and when a snapshot does
 * exist it is served immediately while a non-blocking freshness check runs.
 */
export async function lookupPricing(
    sourceKeys: string[],
    catalog?: ModelsDevCatalog,
): Promise<Map<string, ModelRates>> {
    if (sourceKeys.length === 0) return new Map();

    const resolved = catalog ?? getModelsDevCatalog();

    const status = await resolved.load();
    if (status.providerCount === 0 && status.baseCount === 0) {
        await resolved.refresh();
    } else {
        void resolved.refresh();
    }

    const source = provenanceToSource(resolved.getStatus().provenance);
    const result = new Map<string, ModelRates>();
    for (const sourceKey of sourceKeys) {
        const split = splitSourceKey(sourceKey);
        const refs = split
            ? resolveUsageModelsDevRefs(split.provider, split.model)
            : [];
        const match = refs.length > 0 ? resolved.lookupFirst(refs) : undefined;
        const projected =
            split?.provider === "factory-ai"
                ? applyFactoryRouteCostOverride(split.model, match?.model.cost)
                : { cost: match?.model.cost, overridden: false };
        result.set(
            sourceKey,
            projectRates(
                sourceKey,
                projected.overridden ? "override" : source,
                projected.cost,
            ),
        );
    }
    return result;
}
