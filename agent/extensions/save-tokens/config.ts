/**
 * save-tokens config loader
 *
 * Reads config from settings.json under the "saveTokens" key.
 * Merges global (~/.pi/agent/settings.json) and project-local (<cwd>/.pi/settings.json).
 *
 * Example settings.json:
 * {
 *   "saveTokens": {
 *     "compressor": {
 *       "showStatus": false
 *     },
 *     "caveman": {
 *       "defaultLevel": "full",
 *       "showStatus": true
 *     },
 *     "ponytail": {
 *       "enabled": true,
 *       "defaultMode": "full",
 *       "showStatus": true
 *     },
 *     "telemetry": {
 *       "enabled": true,
 *       "directory": "/custom/path",
 *       "captureContent": true,
 *       "redactSecrets": true,
 *       "retentionDays": 90,
 *       "maxStringLength": 10000,
 *       "maxArrayItems": 100,
 *       "maxDepth": 20
 *     }
 *   }
 * }
 */

import { homedir } from "os";
import { join } from "path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type {
    ArchiveRetentionConfig,
    CompressionBackendId,
    CompressionThresholds,
} from "./tool-results/types";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface BackendConnectionConfig {
    baseUrl?: string;
    timeoutMs?: number;
    agent?: string;
}

export interface CompressorConfig {
    backend?: CompressionBackendId;
    invalidBackend?: string;
    backends?: Partial<Record<CompressionBackendId, BackendConnectionConfig>>;
    /** @deprecated Legacy Edgee alias — migrated to backends.edgee.baseUrl */
    baseUrl?: string;
    /** @deprecated Legacy Edgee alias — migrated to backends.edgee.agent */
    agent?: string;
    /** @deprecated Legacy Edgee alias — migrated to backends.edgee.timeoutMs */
    timeoutMs?: number;
    showStatus?: boolean;
    showWidget?: boolean;
    archiveOriginal?: boolean;
    capFallbackBytes?: number;
    routingStrategy?: "edgee" | "benchmark";
    summaryGranularity?: "none" | "turn" | "agent" | "all";
    enabled?: boolean;
    excludeTools?: string[];
    /** Legacy global threshold; group values take precedence. */
    minBytes?: number;
    minBytesByGroup?: Partial<CompressionThresholds>;
    archiveRetention?: Partial<ArchiveRetentionConfig>;
    aggregates?: boolean;
    capErrors?: boolean;
}

export interface CavemanConfig {
    defaultLevel?: string;
    showStatus?: boolean;
}

export interface PonytailConfig {
    enabled?: boolean;
    defaultMode?: string;
    showStatus?: boolean;
}

export interface TelemetryConfig {
    enabled?: boolean;
    directory?: string;
    captureContent?: boolean;
    redactSecrets?: boolean;
    retentionDays?: number;
    maxStringLength?: number;
    maxArrayItems?: number;
    maxDepth?: number;
}

export interface SaveTokensConfig {
    compressor?: CompressorConfig;
    caveman?: CavemanConfig;
    ponytail?: PonytailConfig;
    telemetry?: TelemetryConfig;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export function resolveDefaultTelemetryDirectory(): string {
    return join(homedir(), ".pi", "agent", "save-tokens-telemetry");
}

const DEFAULT_TELEMETRY: TelemetryConfig = {
    enabled: true,
    directory: resolveDefaultTelemetryDirectory(),
    captureContent: true,
    redactSecrets: true,
    retentionDays: 90,
    maxStringLength: 10_000,
    maxArrayItems: 100,
    maxDepth: 20,
};

const DEFAULT_CONFIG: SaveTokensConfig = {
    compressor: {
        enabled: true,
        excludeTools: [],
        archiveOriginal: true,
    },
};

// ---------------------------------------------------------------------------
// Normalization (from raw settings.json values)
// ---------------------------------------------------------------------------

/** Non-recursive loose dict for safe property reads (avoids `any`/`unknown`). */
interface LooseDict {
    [key: string]: string | number | boolean | null | object;
}

const COMPRESSION_GROUPS = ["shell", "read", "search"] as const;

function isNonNegativeInteger(value: unknown): value is number {
    return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        Number.isInteger(value) &&
        value >= 0
    );
}

function normalizeThresholds(
    raw: unknown,
): Partial<CompressionThresholds> | undefined {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const entries = Object.entries(raw);
    if (entries.some(([key]) => !COMPRESSION_GROUPS.includes(key as never))) {
        return undefined;
    }
    const normalized: Partial<CompressionThresholds> = {};
    for (const [key, value] of entries) {
        if (isNonNegativeInteger(value)) {
            normalized[key as keyof CompressionThresholds] = value;
        }
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeArchiveRetention(
    raw: unknown,
): Partial<ArchiveRetentionConfig> | undefined {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const value = raw as Record<string, unknown>;
    const normalized: Partial<ArchiveRetentionConfig> = {};
    if (isFinitePositive(value.maxAgeDays)) {
        normalized.maxAgeDays = value.maxAgeDays;
    }
    if (isFinitePositive(value.maxBytes)) {
        normalized.maxBytes = value.maxBytes;
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
}

const VALID_BACKENDS: readonly string[] = ["headroom", "edgee"];

function normalizeBackendConnectionConfig(
    raw: unknown,
): BackendConnectionConfig | undefined {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const r = raw as Record<string, unknown>;
    const out: BackendConnectionConfig = {};
    if (typeof r.baseUrl === "string") out.baseUrl = r.baseUrl;
    if (typeof r.timeoutMs === "number" && Number.isFinite(r.timeoutMs))
        out.timeoutMs = r.timeoutMs;
    if (typeof r.agent === "string") out.agent = r.agent;
    return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeBackends(
    raw: unknown,
): Partial<Record<CompressionBackendId, BackendConnectionConfig>> | undefined {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const r = raw as Record<string, unknown>;
    const out: Partial<Record<CompressionBackendId, BackendConnectionConfig>> =
        {};
    for (const id of VALID_BACKENDS) {
        const sub = normalizeBackendConnectionConfig(r[id]);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validated by VALID_BACKENDS
        if (sub) out[id as CompressionBackendId] = sub;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeCompressor(raw: object): CompressorConfig | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const r = raw as LooseDict;
    const out: CompressorConfig = {};
    if (typeof r.backend === "string" && VALID_BACKENDS.includes(r.backend)) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validated above
        out.backend = r.backend as CompressionBackendId;
    } else if (typeof r.backend === "string") {
        out.invalidBackend = r.backend;
    }
    const backends = normalizeBackends(r.backends);
    if (backends) out.backends = backends;
    // oxlint-disable-next-line typescript/no-deprecated -- legacy migration reads deprecated fields
    if (typeof r.baseUrl === "string") out.baseUrl = r.baseUrl;
    // oxlint-disable-next-line typescript/no-deprecated -- legacy migration reads deprecated fields
    if (typeof r.agent === "string") out.agent = r.agent;
    // oxlint-disable-next-line typescript/no-deprecated -- legacy migration reads deprecated fields
    if (typeof r.timeoutMs === "number") out.timeoutMs = r.timeoutMs;
    if (typeof r.showStatus === "boolean") out.showStatus = r.showStatus;
    if (typeof r.showWidget === "boolean") out.showWidget = r.showWidget;
    if (typeof r.archiveOriginal === "boolean")
        out.archiveOriginal = r.archiveOriginal;
    if (typeof r.capFallbackBytes === "number")
        out.capFallbackBytes = r.capFallbackBytes;
    if (r.routingStrategy === "edgee" || r.routingStrategy === "benchmark")
        out.routingStrategy = r.routingStrategy;
    if (
        r.summaryGranularity === "none" ||
        r.summaryGranularity === "turn" ||
        r.summaryGranularity === "agent" ||
        r.summaryGranularity === "all"
    ) {
        out.summaryGranularity = r.summaryGranularity;
    }
    if (typeof r.enabled === "boolean") out.enabled = r.enabled;
    if (Array.isArray(r.excludeTools)) {
        out.excludeTools = [
            ...new Set(
                r.excludeTools.filter(
                    (tool): tool is string => typeof tool === "string",
                ),
            ),
        ];
    }
    if (isNonNegativeInteger(r.minBytes)) out.minBytes = r.minBytes;
    const minBytesByGroup = normalizeThresholds(r.minBytesByGroup);
    if (minBytesByGroup) out.minBytesByGroup = minBytesByGroup;
    const archiveRetention = normalizeArchiveRetention(r.archiveRetention);
    if (archiveRetention) out.archiveRetention = archiveRetention;
    if (typeof r.aggregates === "boolean") out.aggregates = r.aggregates;
    if (typeof r.capErrors === "boolean") out.capErrors = r.capErrors;
    return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeCaveman(raw: object): CavemanConfig | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const r = raw as LooseDict;
    const out: CavemanConfig = {};
    if (typeof r.defaultLevel === "string") out.defaultLevel = r.defaultLevel;
    if (typeof r.showStatus === "boolean") out.showStatus = r.showStatus;
    return Object.keys(out).length > 0 ? out : undefined;
}

function normalizePonytail(raw: object): PonytailConfig | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const r = raw as LooseDict;
    const out: PonytailConfig = {};
    if (typeof r.enabled === "boolean") out.enabled = r.enabled;
    if (typeof r.defaultMode === "string") out.defaultMode = r.defaultMode;
    if (typeof r.showStatus === "boolean") out.showStatus = r.showStatus;
    return Object.keys(out).length > 0 ? out : undefined;
}

export function isFinitePositive(v: unknown): v is number {
    return (
        typeof v === "number" &&
        Number.isFinite(v) &&
        Number.isInteger(v) &&
        v > 0
    );
}

export function normalizeTelemetry(raw: object): TelemetryConfig {
    if (!raw || typeof raw !== "object") {
        return { ...DEFAULT_TELEMETRY };
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const r = raw as LooseDict;
    // Start with defaults, overlay valid overrides
    const out: TelemetryConfig = { ...DEFAULT_TELEMETRY };

    if (typeof r.enabled === "boolean") out.enabled = r.enabled;
    if (typeof r.directory === "string") out.directory = r.directory;
    if (typeof r.captureContent === "boolean")
        out.captureContent = r.captureContent;
    if (typeof r.redactSecrets === "boolean")
        out.redactSecrets = r.redactSecrets;

    // Numeric bounds: must be finite, positive integers
    if (isFinitePositive(r.retentionDays)) out.retentionDays = r.retentionDays;
    if (isFinitePositive(r.maxStringLength))
        out.maxStringLength = r.maxStringLength;
    if (isFinitePositive(r.maxArrayItems)) out.maxArrayItems = r.maxArrayItems;
    if (isFinitePositive(r.maxDepth)) out.maxDepth = r.maxDepth;

    return out;
}

export function normalizeConfig(raw: object): Partial<SaveTokensConfig> {
    if (!raw || typeof raw !== "object") return {};
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const r = raw as LooseDict;
    const cv = r.compressor;
    const ca = r.caveman;
    const pt = r.ponytail;
    const tl = r.telemetry;
    const compressor =
        typeof cv === "object" && cv !== null
            ? normalizeCompressor(cv)
            : undefined;
    const caveman =
        typeof ca === "object" && ca !== null
            ? normalizeCaveman(ca)
            : undefined;
    const ponytail =
        typeof pt === "object" && pt !== null
            ? normalizePonytail(pt)
            : undefined;
    const telemetry =
        typeof tl === "object" && tl !== null
            ? normalizeTelemetry(tl)
            : undefined;
    return {
        ...(compressor ? { compressor } : {}),
        ...(caveman ? { caveman } : {}),
        ...(ponytail ? { ponytail } : {}),
        ...(telemetry && Object.keys(telemetry).length > 0
            ? { telemetry }
            : {}),
    };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export function mergeConfig(
    base: SaveTokensConfig,
    overrides: Partial<SaveTokensConfig>,
): SaveTokensConfig {
    const baseCompressor = base.compressor ?? {};
    const overrideCompressor = overrides.compressor ?? {};
    const minBytesByGroup = {
        ...baseCompressor.minBytesByGroup,
        ...overrideCompressor.minBytesByGroup,
    };
    const archiveRetention = {
        ...baseCompressor.archiveRetention,
        ...overrideCompressor.archiveRetention,
    };
    const baseBackends = baseCompressor.backends ?? {};
    const overrideBackends = overrideCompressor.backends ?? {};
    const backends: Partial<
        Record<CompressionBackendId, BackendConnectionConfig>
    > = {};
    for (const id of VALID_BACKENDS) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validated by VALID_BACKENDS
        const bid = id as CompressionBackendId;
        const b = baseBackends[bid];
        const o = overrideBackends[bid];
        if (b || o) backends[bid] = { ...b, ...o };
    }
    const mergedCompressor: CompressorConfig = {
        ...baseCompressor,
        ...overrideCompressor,
        ...("backend" in overrideCompressor ||
        "invalidBackend" in overrideCompressor
            ? { invalidBackend: overrideCompressor.invalidBackend }
            : {}),
        ...(Object.keys(minBytesByGroup).length > 0 ? { minBytesByGroup } : {}),
        ...(Object.keys(archiveRetention).length > 0
            ? { archiveRetention }
            : {}),
        ...(Object.keys(backends).length > 0 ? { backends } : {}),
    };

    return {
        compressor: mergedCompressor,
        caveman: { ...base.caveman, ...overrides.caveman },
        ponytail: { ...base.ponytail, ...overrides.ponytail },
        telemetry: {
            ...DEFAULT_TELEMETRY,
            ...base.telemetry,
            ...overrides.telemetry,
        },
    };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function loadSaveTokensConfig(
    cwd = process.cwd(),
    agentDir?: string,
): SaveTokensConfig {
    let globalConfig: Partial<SaveTokensConfig> = {};
    let projectConfig: Partial<SaveTokensConfig> = {};

    try {
        const manager = SettingsManager.create(cwd, agentDir);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const globalSettings = manager.getGlobalSettings() as LooseDict;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const projectSettings = manager.getProjectSettings() as LooseDict;
        const st = globalSettings.saveTokens;
        const sp = projectSettings.saveTokens;
        globalConfig =
            typeof st === "object" && st !== null ? normalizeConfig(st) : {};
        projectConfig =
            typeof sp === "object" && sp !== null ? normalizeConfig(sp) : {};
    } catch {
        // not in pi runtime or settings inaccessible
    }

    return mergeConfig(
        mergeConfig(DEFAULT_CONFIG, globalConfig),
        projectConfig,
    );
}

export function loadCompressorConfig(
    cwd = process.cwd(),
    agentDir?: string,
): CompressorConfig {
    return loadSaveTokensConfig(cwd, agentDir).compressor ?? {};
}

export function loadCavemanConfig(
    cwd = process.cwd(),
    agentDir?: string,
): CavemanConfig {
    return loadSaveTokensConfig(cwd, agentDir).caveman ?? {};
}

export function loadPonytailConfig(
    cwd = process.cwd(),
    agentDir?: string,
): PonytailConfig {
    return loadSaveTokensConfig(cwd, agentDir).ponytail ?? {};
}

export function loadTelemetryConfig(
    cwd = process.cwd(),
    agentDir?: string,
): TelemetryConfig {
    const cfg = loadSaveTokensConfig(cwd, agentDir).telemetry;
    return cfg ?? DEFAULT_TELEMETRY;
}
