import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import {
    clearTimeout as clearAbortTimer,
    setTimeout as scheduleAbortTimer,
} from "node:timers";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** models.dev catalog endpoint carrying provider-aware and base records plus an ETag. */
export const MODELS_DEV_CATALOG_URL = "https://models.dev/catalog.json";

const CACHE_TTL_MS = 86_400_000;
const CACHE_TIMEOUT_MS = 5_000;
const CACHE_FILE_NAME = "models-dev-catalog-v1.json";
const DEFAULT_CACHE_PATH = join(getAgentDir(), "cache", CACHE_FILE_NAME);

/** Unique global slot so separately evaluated extensions share one catalog instance. */
const CATALOG_SLOT: symbol = Symbol.for("pi.models-dev-catalog.v1");

/** Exact model reference used for catalog lookup. */
export type ModelsDevRef =
    | { scope: "provider"; providerId: string; modelId: string }
    | { scope: "model"; modelId: string };

/** Normalized optional model facts, all values validated at parse time. */
export interface ModelsDevModel {
    name: string;
    reasoning?: boolean;
    inputModalities?: readonly string[];
    contextWindow?: number;
    maxTokens?: number;
    cost?: ModelsDevCost;
}

/** Per-million-token prices in USD; absent means unknown, zero is a real price. */
export interface ModelsDevCost {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
}

/** Exact result of a successful lookup. */
export interface ModelsDevMatch {
    ref: ModelsDevRef;
    model: ModelsDevModel;
}

/** Snapshot provenance and freshness reported by {@link ModelsDevCatalog}. */
export interface ModelsDevCatalogStatus {
    provenance: "unavailable" | "cache" | "network";
    fetchedAt: number | null;
    etag: string | null;
    stale: boolean;
    providerCount: number;
    baseCount: number;
}

/** Outcome of a catalog refresh; `error` is only ever present for `failed`. */
export interface ModelsDevRefreshResult {
    status: "fresh" | "updated" | "not-modified" | "failed";
    catalog: ModelsDevCatalogStatus;
    error?: string;
}

/** Fetch contract used for deterministic tests; mirrors the global `fetch` shape. */
export type ModelsDevFetchFn = (
    url: string,
    init: RequestInit,
) => Promise<Response>;

/** Options accepted by {@link createModelsDevCatalog}; every field is injectable for tests. */
export interface ModelsDevCatalogOptions {
    cachePath?: string;
    fetchFn?: ModelsDevFetchFn;
    now?: () => number;
    ttlMs?: number;
    timeoutMs?: number;
}

/** Process-wide validated models.dev catalog with a resilient disk cache. */
export interface ModelsDevCatalog {
    load(): Promise<ModelsDevCatalogStatus>;
    lookupFirst(refs: readonly ModelsDevRef[]): ModelsDevMatch | undefined;
    refresh(options?: { force?: boolean }): Promise<ModelsDevRefreshResult>;
    getStatus(): ModelsDevCatalogStatus;
}

/** Normalized snapshot kept in memory; also the shape persisted to disk. */
interface NormalizedSnapshot {
    fetchedAt: number;
    etag?: string;
    providers: ReadonlyMap<string, ReadonlyMap<string, ModelsDevModel>>;
    models: ReadonlyMap<string, ModelsDevModel>;
    providerCount: number;
    baseCount: number;
}

/** Any value JSON.parse can produce; every field is validated before use. */
type JsonValue =
    | null
    | boolean
    | number
    | string
    | JsonValue[]
    | { [key: string]: JsonValue };

/** JSON object payload, established by the {@link isRecord} type guard. */
type JsonObject = { [key: string]: JsonValue };

/** Opaque handle for the owned abort timer; see doRefresh. */
type AbortTimer = ReturnType<typeof scheduleAbortTimer>;

class ModelsDevCatalogImpl implements ModelsDevCatalog {
    private readonly cachePath: string;
    private readonly fetchFn: ModelsDevFetchFn;
    private readonly now: () => number;
    private readonly ttlMs: number;
    private readonly timeoutMs: number;

    private snapshot: NormalizedSnapshot | null = null;
    private provenance: ModelsDevCatalogStatus["provenance"] = "unavailable";
    private loadPromise: Promise<ModelsDevCatalogStatus> | null = null;
    private loadedOnce = false;
    private refreshPromise: Promise<ModelsDevRefreshResult> | null = null;
    private refreshForced = false;

    constructor(options: ModelsDevCatalogOptions) {
        this.cachePath = options.cachePath ?? DEFAULT_CACHE_PATH;
        this.fetchFn = options.fetchFn ?? fetch;
        this.now = options.now ?? (() => Date.now());
        this.ttlMs = options.ttlMs ?? CACHE_TTL_MS;
        this.timeoutMs = options.timeoutMs ?? CACHE_TIMEOUT_MS;
    }

    getStatus(): ModelsDevCatalogStatus {
        const snapshot = this.snapshot;
        if (!snapshot) {
            return {
                provenance: "unavailable",
                fetchedAt: null,
                etag: null,
                stale: true,
                providerCount: 0,
                baseCount: 0,
            };
        }
        return {
            provenance: this.provenance,
            fetchedAt: snapshot.fetchedAt,
            etag: snapshot.etag ?? null,
            stale: this.now() - snapshot.fetchedAt >= this.ttlMs,
            providerCount: snapshot.providerCount,
            baseCount: snapshot.baseCount,
        };
    }

    async load(): Promise<ModelsDevCatalogStatus> {
        if (!this.loadPromise) {
            this.loadPromise = this.doLoad().finally(() => {
                this.loadPromise = null;
            });
        }
        return this.loadPromise;
    }

    private async doLoad(): Promise<ModelsDevCatalogStatus> {
        if (this.loadedOnce) return this.getStatus();
        this.loadedOnce = true;
        try {
            const raw = await fs.readFile(this.cachePath, "utf-8");
            const snapshot = normalizeCacheEnvelope(parseJson(raw));
            if (snapshot) {
                this.snapshot = snapshot;
                this.provenance = "cache";
            }
        } catch {
            // Missing, unreadable, or malformed cache stays unavailable; never throws.
        }
        return this.getStatus();
    }

    lookupFirst(refs: readonly ModelsDevRef[]): ModelsDevMatch | undefined {
        for (const ref of refs) {
            const model = this.lookup(ref);
            if (model) return { ref, model };
        }
        return undefined;
    }

    private lookup(ref: ModelsDevRef): ModelsDevModel | undefined {
        const snapshot = this.snapshot;
        if (!snapshot) return undefined;
        if (ref.scope === "provider") {
            return snapshot.providers.get(ref.providerId)?.get(ref.modelId);
        }
        return snapshot.models.get(ref.modelId);
    }

    async refresh(options?: {
        force?: boolean;
    }): Promise<ModelsDevRefreshResult> {
        const force = options?.force === true;
        const active = this.refreshPromise;
        if (active) {
            if (!force || this.refreshForced) return active;
            await active;
            return this.refresh({ force: true });
        }

        const operation = this.doRefresh({ force });
        this.refreshForced = force;
        this.refreshPromise = operation;
        try {
            return await operation;
        } finally {
            if (this.refreshPromise === operation) {
                this.refreshPromise = null;
                this.refreshForced = false;
            }
        }
    }

    private async doRefresh(options: {
        force?: boolean;
    }): Promise<ModelsDevRefreshResult> {
        await this.load();
        const status = this.getStatus();
        const age =
            status.fetchedAt === null
                ? Infinity
                : this.now() - status.fetchedAt;
        if (!options.force && age < this.ttlMs) {
            return { status: "fresh", catalog: this.getStatus() };
        }

        // Owned abort timer: cleared in `finally` on every path, so a fast
        // request never leaves a stray timeout scheduled. The handle is
        // annotated so the timer result never leaks as an implicit `any`.
        const controller = new AbortController();
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- typeAware lint resolves node:timers setTimeout as `any`; the handle is opaque and only passed back to clearTimeout.
        const timer: AbortTimer = scheduleAbortTimer(
            () => controller.abort(),
            this.timeoutMs,
        );
        try {
            const headers: Record<string, string> = {
                "User-Agent": "Mozilla/5.0",
            };
            if (status.etag) headers["If-None-Match"] = status.etag;
            const response = await this.fetchFn(MODELS_DEV_CATALOG_URL, {
                headers,
                signal: controller.signal,
            });

            if (response.status === 304) {
                if (!this.snapshot) {
                    // Nothing to preserve or advance: a 304 is meaningless
                    // without a previously cached snapshot.
                    return {
                        status: "failed",
                        catalog: this.getStatus(),
                        error: "not-modified without cached snapshot",
                    };
                }
                const refreshed: NormalizedSnapshot = {
                    ...this.snapshot,
                    fetchedAt: this.now(),
                };
                try {
                    await this.persistSnapshot(refreshed);
                } catch {
                    return {
                        status: "failed",
                        catalog: this.getStatus(),
                        error: "failed to persist cache",
                    };
                }
                this.snapshot = refreshed;
                return { status: "not-modified", catalog: this.getStatus() };
            }

            if (!response.ok) {
                return {
                    status: "failed",
                    catalog: this.getStatus(),
                    error: `HTTP ${response.status}`,
                };
            }

            let raw: JsonValue;
            try {
                raw = parseJson(await response.text());
            } catch {
                return {
                    status: "failed",
                    catalog: this.getStatus(),
                    error: "invalid response payload",
                };
            }

            const normalized = normalizeNetworkEnvelope(raw);
            if (!normalized) {
                return {
                    status: "failed",
                    catalog: this.getStatus(),
                    error: "invalid catalog payload",
                };
            }

            const etag = response.headers.get("etag") ?? normalized.etag;
            const snapshot: NormalizedSnapshot = {
                ...normalized,
                fetchedAt: this.now(),
                ...(etag ? { etag } : {}),
            };

            try {
                await this.persistSnapshot(snapshot);
            } catch {
                return {
                    status: "failed",
                    catalog: this.getStatus(),
                    error: "failed to persist cache",
                };
            }

            this.snapshot = snapshot;
            this.provenance = "network";
            return { status: "updated", catalog: this.getStatus() };
        } catch (error) {
            return {
                status: "failed",
                catalog: this.getStatus(),
                error: sanitizeFailure(error),
            };
        } finally {
            clearAbortTimer(timer);
        }
    }

    private async persistSnapshot(snapshot: NormalizedSnapshot): Promise<void> {
        const directory = dirname(this.cachePath);
        await fs.mkdir(directory, { recursive: true });
        const tempPath = `${this.cachePath}.${process.pid}.${randomUUID()}.tmp`;
        const envelope = {
            version: 1,
            fetchedAt: snapshot.fetchedAt,
            ...(snapshot.etag ? { etag: snapshot.etag } : {}),
            providers: serializeProviders(snapshot.providers),
            models: Object.fromEntries(snapshot.models),
        };
        try {
            await fs.writeFile(tempPath, JSON.stringify(envelope), "utf-8");
            await fs.rename(tempPath, this.cachePath);
        } catch (error) {
            await fs.rm(tempPath, { force: true }).catch(() => {});
            throw error;
        }
    }
}

// oxlint-disable-next-line @typescript-eslint/no-restricted-types -- catch clauses are `unknown` by TS design; only `instanceof`/`name` are inspected.
function sanitizeFailure(error: unknown): string {
    if (error instanceof Error && error.name === "AbortError")
        return "request timed out";
    return "network request failed";
}

/** Parse untrusted text; the single boundary where raw JSON enters the system. */
function parseJson(text: string): JsonValue {
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse returns any; JsonValue is the validation boundary for untrusted payloads.
    return JSON.parse(text) as JsonValue;
}

/**
 * Validate an untrusted envelope into a snapshot.
 * `requireVersionOne` is true only for persisted cache envelopes, which must
 * carry an explicit `version: 1` marker; network payloads are raw models.dev
 * records with no version field of their own.
 */
function normalizeEnvelope(
    raw: JsonValue,
    requireVersionOne: boolean,
): NormalizedSnapshot | null {
    if (!isRecord(raw)) return null;
    if (requireVersionOne) {
        if (raw.version !== 1) return null;
        if (
            typeof raw.fetchedAt !== "number" ||
            !Number.isFinite(raw.fetchedAt) ||
            raw.fetchedAt < 0
        ) {
            return null;
        }
    }
    // Raw network payloads have no cache-envelope requirements: a present
    // version/fetchedAt marker is irrelevant and must not reject a catalog.
    if (raw.providers !== undefined && !isRecord(raw.providers)) return null;
    if (raw.models !== undefined && !isRecord(raw.models)) return null;

    const providers = normalizeProviders(raw.providers);
    const models = normalizeModels(raw.models);
    let providerCount = 0;
    for (const providerModels of providers.values())
        providerCount += providerModels.size;
    if (providerCount === 0 && models.size === 0) return null;

    const fetchedAt =
        typeof raw.fetchedAt === "number" && Number.isFinite(raw.fetchedAt)
            ? raw.fetchedAt
            : 0;
    const etag =
        typeof raw.etag === "string" && raw.etag.length > 0
            ? raw.etag
            : undefined;
    return {
        fetchedAt,
        ...(etag ? { etag } : {}),
        providers,
        models,
        providerCount,
        baseCount: models.size,
    };
}

function normalizeProviders(
    raw: JsonValue,
): Map<string, Map<string, ModelsDevModel>> {
    const providers = new Map<string, Map<string, ModelsDevModel>>();
    if (!isRecord(raw)) return providers;
    for (const [providerId, provider] of Object.entries(raw)) {
        if (!isRecord(provider)) continue;
        const models = normalizeModels(provider.models);
        if (models.size > 0) providers.set(providerId, models);
    }
    return providers;
}

function normalizeModels(raw: JsonValue): Map<string, ModelsDevModel> {
    const models = new Map<string, ModelsDevModel>();
    if (!isRecord(raw)) return models;
    for (const [modelId, record] of Object.entries(raw)) {
        const model = normalizeModel(modelId, record);
        if (model) models.set(modelId, model);
    }
    return models;
}

/** Persisted cache envelopes must carry an explicit version-1 marker. */
function normalizeCacheEnvelope(raw: JsonValue): NormalizedSnapshot | null {
    return normalizeEnvelope(raw, true);
}

/** Raw models.dev network payloads have no version field; a present one must still be 1. */
function normalizeNetworkEnvelope(raw: JsonValue): NormalizedSnapshot | null {
    return normalizeEnvelope(raw, false);
}

/** Normalize one record; returns null so malformed records are skipped, not fatal. */
function normalizeModel(
    modelId: string,
    raw: JsonValue,
): ModelsDevModel | null {
    if (!isRecord(raw)) return null;

    const name =
        typeof raw.name === "string" && raw.name.length > 0
            ? raw.name
            : modelId;
    const model: ModelsDevModel = { name };

    if (typeof raw.reasoning === "boolean") model.reasoning = raw.reasoning;

    // Accept both the raw models.dev shape and the normalized persisted shape.
    const modalities = isRecord(raw.modalities) ? raw.modalities : undefined;
    const inputModalities =
        pickStringArray(raw.inputModalities) ??
        (modalities ? pickStringArray(modalities.input) : undefined);
    if (inputModalities) model.inputModalities = inputModalities;

    const limit = isRecord(raw.limit) ? raw.limit : undefined;
    const contextWindow =
        pickPositiveInteger(raw.contextWindow) ??
        (limit ? pickPositiveInteger(limit.context) : undefined);
    if (contextWindow !== undefined) model.contextWindow = contextWindow;
    const maxTokens =
        pickPositiveInteger(raw.maxTokens) ??
        (limit ? pickPositiveInteger(limit.output) : undefined);
    if (maxTokens !== undefined) model.maxTokens = maxTokens;

    const cost = pickCost(raw.cost);
    if (cost) model.cost = cost;

    return model;
}

function pickCost(raw: JsonValue): ModelsDevCost | undefined {
    if (!isRecord(raw)) return undefined;
    const cost: ModelsDevCost = {};
    const input = pickNonNegativeFinite(raw.input);
    if (input !== undefined) cost.input = input;
    const output = pickNonNegativeFinite(raw.output);
    if (output !== undefined) cost.output = output;
    const cacheRead = pickNonNegativeFinite(raw.cache_read ?? raw.cacheRead);
    if (cacheRead !== undefined) cost.cacheRead = cacheRead;
    const cacheWrite = pickNonNegativeFinite(raw.cache_write ?? raw.cacheWrite);
    if (cacheWrite !== undefined) cost.cacheWrite = cacheWrite;
    return cost.input !== undefined ||
        cost.output !== undefined ||
        cost.cacheRead !== undefined ||
        cost.cacheWrite !== undefined
        ? cost
        : undefined;
}

function serializeProviders(
    providers: ReadonlyMap<string, ReadonlyMap<string, ModelsDevModel>>,
): Record<string, { models: Record<string, ModelsDevModel> }> {
    const out: Record<string, { models: Record<string, ModelsDevModel> }> = {};
    for (const [providerId, models] of providers) {
        out[providerId] = { models: Object.fromEntries(models) };
    }
    return out;
}

function isRecord(raw: JsonValue): raw is JsonObject {
    return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function pickStringArray(raw: JsonValue): readonly string[] | undefined {
    if (
        Array.isArray(raw) &&
        raw.every((item): item is string => typeof item === "string")
    ) {
        // Empty arrays are valid: every element is a string vacuously.
        return raw;
    }
    return undefined;
}

function pickPositiveInteger(raw: JsonValue): number | undefined {
    return typeof raw === "number" && Number.isInteger(raw) && raw > 0
        ? raw
        : undefined;
}

function pickNonNegativeFinite(raw: JsonValue): number | undefined {
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
        ? raw
        : undefined;
}

/** Create a catalog with optional injected dependencies for deterministic tests. */
export function createModelsDevCatalog(
    options: ModelsDevCatalogOptions = {},
): ModelsDevCatalog {
    return new ModelsDevCatalogImpl(options);
}

/**
 * Return the process-wide default catalog, creating it on first use.
 * The global holder is keyed by a symbol, so it is only ever a slot map;
 * the cast is local and documented.
 */
export function getModelsDevCatalog(): ModelsDevCatalog {
    const globalSlot = globalThis as {
        [key: symbol]: ModelsDevCatalog | undefined;
    };
    const existing = globalSlot[CATALOG_SLOT];
    if (!existing) {
        const catalog = createModelsDevCatalog();
        globalSlot[CATALOG_SLOT] = catalog;
        return catalog;
    }
    return existing;
}

/** Remove the process-wide default catalog; test-only. */
export function resetModelsDevCatalogForTests(): void {
    const globalSlot = globalThis as {
        [key: symbol]: ModelsDevCatalog | undefined;
    };
    delete globalSlot[CATALOG_SLOT];
}
