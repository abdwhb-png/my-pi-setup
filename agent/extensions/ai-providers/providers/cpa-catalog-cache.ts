import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { CpaModelEntry } from "./cpa-models.ts";

const CACHE_VERSION = 1;

// oxlint-disable-next-line typescript/no-restricted-types -- cache JSON is untrusted until validated.
type UntrustedJson = unknown;

interface PersistedCpaCatalog {
    version: typeof CACHE_VERSION;
    endpoint: string;
    fetchedAt: number;
    entries: CpaModelEntry[];
}

export interface CpaCatalogCache {
    load(): CpaModelEntry[] | undefined;
    save(entries: readonly CpaModelEntry[]): Promise<void>;
}

export interface CpaCatalogCacheOptions {
    cachePath: string;
    endpoint: string;
}

function isRecord(
    value: UntrustedJson,
): value is Record<string, UntrustedJson> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: UntrustedJson): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isStringArray(value: UntrustedJson): value is string[] {
    return (
        Array.isArray(value) &&
        value.every((item) => typeof item === "string" && item.length > 0)
    );
}

function isInputModalities(
    value: UntrustedJson,
): value is Array<"text" | "image"> {
    return (
        Array.isArray(value) &&
        value.every((item) => item === "text" || item === "image")
    );
}

function parseEntry(value: UntrustedJson): CpaModelEntry | undefined {
    if (!isRecord(value)) return undefined;
    if (typeof value.id !== "string" || value.id.length === 0) return undefined;
    if (typeof value.owned_by !== "string" || value.owned_by.length === 0) {
        return undefined;
    }
    if (
        value.contextLength !== undefined &&
        !isPositiveInteger(value.contextLength)
    ) {
        return undefined;
    }
    if (
        value.maxCompletionTokens !== undefined &&
        !isPositiveInteger(value.maxCompletionTokens)
    ) {
        return undefined;
    }
    if (
        value.thinkingLevels !== undefined &&
        !isStringArray(value.thinkingLevels)
    ) {
        return undefined;
    }
    if (
        value.inputModalities !== undefined &&
        !isInputModalities(value.inputModalities)
    ) {
        return undefined;
    }

    return {
        id: value.id,
        owned_by: value.owned_by,
        contextLength: value.contextLength,
        maxCompletionTokens: value.maxCompletionTokens,
        thinkingLevels: value.thinkingLevels,
        inputModalities: value.inputModalities,
    };
}

function parseCache(
    raw: UntrustedJson,
    endpoint: string,
): CpaModelEntry[] | undefined {
    if (!isRecord(raw)) return undefined;
    if (raw.version !== CACHE_VERSION || raw.endpoint !== endpoint) {
        return undefined;
    }
    if (!isPositiveInteger(raw.fetchedAt)) return undefined;
    if (!Array.isArray(raw.entries) || raw.entries.length === 0) {
        return undefined;
    }

    const entries = raw.entries.map(parseEntry);
    return entries.every((entry) => entry !== undefined) ? entries : undefined;
}

export function createCpaCatalogCache(
    options: CpaCatalogCacheOptions,
): CpaCatalogCache {
    return {
        load() {
            if (!existsSync(options.cachePath)) return undefined;
            try {
                return parseCache(
                    JSON.parse(readFileSync(options.cachePath, "utf8")),
                    options.endpoint,
                );
            } catch {
                return undefined;
            }
        },
        async save(entries) {
            const directory = dirname(options.cachePath);
            const temporaryPath = join(
                directory,
                `.${basename(options.cachePath)}.${process.pid}.${randomUUID()}.tmp`,
            );
            const payload: PersistedCpaCatalog = {
                version: CACHE_VERSION,
                endpoint: options.endpoint,
                fetchedAt: Date.now(),
                entries: [...entries],
            };
            await mkdir(directory, { recursive: true });
            await writeFile(
                temporaryPath,
                `${JSON.stringify(payload)}\n`,
                "utf8",
            );
            await rename(temporaryPath, options.cachePath);
        },
    };
}
