import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ModelRates } from "./types";

/** Default cache file path */
export const PRICING_CACHE_PATH: string = path.join(
  process.env.HOME || "/home/abdwhb",
  ".pi",
  "agent",
  "pricing-cache.json",
);

/**
 * Load cached pricing from local JSON file.
 * Returns empty Map if file doesn't exist or is invalid.
 */
export async function loadPricingCache(
  cachePath?: string,
): Promise<Map<string, ModelRates>> {
  const resolvedPath = cachePath ?? PRICING_CACHE_PATH;
  try {
    const raw = await fs.readFile(resolvedPath, "utf-8");
    const parsed: Record<string, { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number }> =
      JSON.parse(raw);
    const map = new Map<string, ModelRates>();
    for (const [key, rates] of Object.entries(parsed)) {
      map.set(key, {
        modelKey: key,
        inputPerMillion: rates.inputPerMillion ?? 0,
        outputPerMillion: rates.outputPerMillion ?? 0,
        cacheReadPerMillion: rates.cacheReadPerMillion ?? 0,
        source: "cached",
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Save pricing to local cache file.
 */
export async function savePricingCache(
  prices: Map<string, ModelRates>,
  cachePath?: string,
): Promise<void> {
  const resolvedPath = cachePath ?? PRICING_CACHE_PATH;
  const obj: Record<string, { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number }> = {};
  for (const [key, rates] of prices) {
    obj[key] = {
      inputPerMillion: rates.inputPerMillion,
      outputPerMillion: rates.outputPerMillion,
      cacheReadPerMillion: rates.cacheReadPerMillion,
    };
  }
  await fs.writeFile(resolvedPath, JSON.stringify(obj, null, 2), "utf-8");
}

/**
 * Fetch pricing for specific model sourceKeys from models.dev API.
 * Uses a filtered approach — fetches the API and extracts only matching models.
 * Returns Map of matched models. On any error, returns empty Map.
 */
export async function fetchFromModelsDev(
  sourceKeys: string[],
): Promise<Map<string, ModelRates>> {
  if (sourceKeys.length === 0) return new Map();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch("https://models.dev/api.json", {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) return new Map();

    const data: unknown = await response.json();
    if (typeof data !== "object" || data === null) return new Map();

    const result = new Map<string, ModelRates>();

    // Normalise sourceKeys for matching — support prefix match or contains match
    const lowerKeys = sourceKeys.map((k) => k.toLowerCase());

    for (const [modelKey, rates] of Object.entries(data)) {
      const lowerModelKey = modelKey.toLowerCase();

      // Check if this model key starts with or contains any requested key
      const matches = lowerKeys.some(
        (k) => lowerModelKey.startsWith(k) || lowerModelKey.includes(k),
      );
      if (!matches) continue;

      if (typeof rates !== "object" || rates === null) continue;

      const r = rates as Record<string, unknown>;
      const input = typeof r.input === "number" ? r.input : 0;
      const output = typeof r.output === "number" ? r.output : 0;
      const cacheRead = typeof r.cache_read === "number" ? r.cache_read : 0;

      result.set(modelKey, {
        modelKey,
        inputPerMillion: input,
        outputPerMillion: output,
        cacheReadPerMillion: cacheRead,
        source: "models.dev",
      });
    }

    return result;
  } catch {
    return new Map();
  }
}

/**
 * Look up pricing for a set of model sourceKeys.
 * Returns a Map<sourceKey, ModelRates>.
 * Uses local cache first, then tries models.dev API for uncached models.
 * On fetch failure, marks models as "unavailable".
 */
export async function lookupPricing(
  sourceKeys: string[],
  cachePath?: string,
): Promise<Map<string, ModelRates>> {
  // 1. Load cache
  const cache = await loadPricingCache(cachePath);

  // 2. Find uncached keys
  const uncached = sourceKeys.filter((key) => !cache.has(key));

  // 3. Fetch from API for uncached keys
  if (uncached.length > 0) {
    const fetched = await fetchFromModelsDev(uncached);

    // Merge fetched into cache
    for (const [key, rates] of fetched) {
      cache.set(key, rates);
    }

    // 4. Save updated cache (only if we got something new)
    if (fetched.size > 0) {
      await savePricingCache(cache, cachePath).catch(() => {});
    }
  }

  // 5. For any key still missing, mark as unavailable
  for (const key of sourceKeys) {
    if (!cache.has(key)) {
      cache.set(key, {
        modelKey: key,
        inputPerMillion: 0,
        outputPerMillion: 0,
        cacheReadPerMillion: 0,
        source: "unavailable",
      });
    }
  }

  return cache;
}