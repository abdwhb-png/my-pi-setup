import { loadCompressorConfig } from "./config";
import type { CompressorConfig } from "./config";
import type {
    ArchiveRetentionConfig,
    CompressionBackendId,
    CompressionThresholds,
    LocalCompressorConfig,
} from "./tool-results/types";

// ---------------------------------------------------------------------------
// Per-backend defaults
// ---------------------------------------------------------------------------

const BACKEND_DEFAULTS: Record<
    CompressionBackendId,
    { baseUrl: string; timeoutMs: number }
> = {
    headroom: { baseUrl: "http://127.0.0.1:8787", timeoutMs: 1000 },
    edgee: { baseUrl: "http://127.0.0.1:8320", timeoutMs: 800 },
};

const ENV_PREFIXES: Record<CompressionBackendId, string> = {
    headroom: "HEADROOM_COMPRESSOR",
    edgee: "EDGEE_COMPRESSOR",
};

const DEFAULT_AGENT = "claude";
const DEFAULT_MIN_BYTES_BY_GROUP: CompressionThresholds = {
    shell: 4096,
    read: 8192,
    search: 4096,
};
const DEFAULT_ARCHIVE_RETENTION: ArchiveRetentionConfig = {
    maxAgeDays: 30,
    maxBytes: 1_073_741_824,
};

const VALID_BACKENDS: ReadonlySet<string> = new Set(["headroom", "edgee"]);

// ---------------------------------------------------------------------------
// Config diagnostics
// ---------------------------------------------------------------------------

export interface ConfigDiagnostic {
    id: "invalid_backend" | "legacy_benchmark";
    message: string;
}

// ---------------------------------------------------------------------------
// Resolved config
// ---------------------------------------------------------------------------

export interface ResolvedBackendConfig {
    baseUrl: string;
    timeoutMs: number;
    agent?: string;
}

export interface ResolvedCompressorConfig {
    backend: CompressionBackendId;
    backendConfig: ResolvedBackendConfig;
    valid: boolean;
    diagnostics: ConfigDiagnostic[];
    // policy fields preserved from CompressorConfig
    showStatus: boolean;
    showWidget: boolean;
    archiveOriginal: boolean;
    capFallbackBytes?: number;
    summaryGranularity: "none" | "turn" | "agent" | "all";
    enabled: boolean;
    excludeTools: string[];
    minBytesByGroup: CompressionThresholds;
    archiveRetention: ArchiveRetentionConfig;
    aggregates: boolean;
    capErrors: boolean;
}

// ---------------------------------------------------------------------------
// resolveCompressorConfig — pure function, testable without Pi runtime
// ---------------------------------------------------------------------------

export function resolveCompressorConfig(
    cfg: CompressorConfig,
): ResolvedCompressorConfig {
    const diagnostics: ConfigDiagnostic[] = [];
    let valid = true;

    // --- backend selection ---
    let backend: CompressionBackendId = "headroom";
    if (cfg.invalidBackend !== undefined) {
        valid = false;
        diagnostics.push({
            id: "invalid_backend",
            message: `Unknown compression backend "${cfg.invalidBackend}". Valid: headroom, edgee.`,
        });
    } else if (cfg.backend !== undefined) {
        if (VALID_BACKENDS.has(cfg.backend)) {
            backend = cfg.backend;
        } else {
            valid = false;
            diagnostics.push({
                id: "invalid_backend",
                message: `Unknown compression backend "${cfg.backend}". Valid: headroom, edgee.`,
            });
        }
    }

    // --- legacy benchmark deprecation ---
    if (cfg.routingStrategy === "benchmark") {
        diagnostics.push({
            id: "legacy_benchmark",
            message:
                'routingStrategy "benchmark" is deprecated. Using selected backend instead.',
        });
    }

    // --- resolve backend connection config ---
    const defaults = BACKEND_DEFAULTS[backend];
    const backendBlock = cfg.backends?.[backend] ?? {};
    const prefix = ENV_PREFIXES[backend];

    // Legacy top-level baseUrl/timeoutMs/agent map to edgee only
    // oxlint-disable typescript/no-deprecated -- intentional legacy migration
    const legacyBaseUrl =
        backend === "edgee" && cfg.baseUrl ? cfg.baseUrl : undefined;
    const legacyTimeoutMs =
        backend === "edgee" && cfg.timeoutMs !== undefined
            ? cfg.timeoutMs
            : undefined;
    const legacyAgent =
        backend === "edgee" && cfg.agent ? cfg.agent : undefined;
    // oxlint-enable typescript/no-deprecated

    // Env overrides
    const envBaseUrl = process.env[`${prefix}_BASE_URL`]?.trim() || undefined;
    const envTimeoutRaw = process.env[`${prefix}_TIMEOUT_MS`]?.trim();
    const parsedEnvTimeout = envTimeoutRaw ? Number(envTimeoutRaw) : NaN;
    const envTimeoutMs =
        Number.isFinite(parsedEnvTimeout) &&
        Number.isInteger(parsedEnvTimeout) &&
        parsedEnvTimeout > 0
            ? parsedEnvTimeout
            : undefined;

    const resolvedBaseUrl =
        envBaseUrl ?? backendBlock.baseUrl ?? legacyBaseUrl ?? defaults.baseUrl;

    const resolvedTimeoutMs =
        envTimeoutMs ??
        backendBlock.timeoutMs ??
        legacyTimeoutMs ??
        defaults.timeoutMs;

    const resolvedAgent = backendBlock.agent ?? legacyAgent;

    const backendConfig: ResolvedBackendConfig = {
        baseUrl: resolvedBaseUrl,
        timeoutMs: Number.isFinite(resolvedTimeoutMs)
            ? resolvedTimeoutMs
            : defaults.timeoutMs,
        ...(resolvedAgent ? { agent: resolvedAgent } : {}),
    };

    // --- policy fields ---
    const legacyMinBytes = cfg.minBytes;

    return {
        backend,
        backendConfig,
        valid,
        diagnostics,
        showStatus: cfg.showStatus ?? false,
        showWidget: cfg.showWidget ?? true,
        archiveOriginal: cfg.archiveOriginal ?? true,
        ...(typeof cfg.capFallbackBytes === "number" && cfg.capFallbackBytes > 0
            ? { capFallbackBytes: cfg.capFallbackBytes }
            : {}),
        summaryGranularity: cfg.summaryGranularity ?? "all",
        enabled: cfg.enabled ?? true,
        excludeTools: cfg.excludeTools ?? [],
        minBytesByGroup: {
            shell:
                cfg.minBytesByGroup?.shell ??
                legacyMinBytes ??
                DEFAULT_MIN_BYTES_BY_GROUP.shell,
            read:
                cfg.minBytesByGroup?.read ??
                legacyMinBytes ??
                DEFAULT_MIN_BYTES_BY_GROUP.read,
            search:
                cfg.minBytesByGroup?.search ??
                legacyMinBytes ??
                DEFAULT_MIN_BYTES_BY_GROUP.search,
        },
        archiveRetention: {
            maxAgeDays:
                cfg.archiveRetention?.maxAgeDays ??
                DEFAULT_ARCHIVE_RETENTION.maxAgeDays,
            maxBytes:
                cfg.archiveRetention?.maxBytes ??
                DEFAULT_ARCHIVE_RETENTION.maxBytes,
        },
        aggregates: cfg.aggregates ?? true,
        capErrors: cfg.capErrors ?? true,
    };
}

// ---------------------------------------------------------------------------
// Legacy API — preserved for existing consumers
// ---------------------------------------------------------------------------

export function getLocalCompressorConfig(
    cwd = process.cwd(),
): LocalCompressorConfig {
    const cfg = loadCompressorConfig(cwd);

    // oxlint-disable -- typescript/no-deprecated: intentional reads of legacy fields for backward compat
    const baseUrl =
        process.env.EDGEE_COMPRESSOR_BASE_URL?.trim() ||
        cfg.baseUrl ||
        BACKEND_DEFAULTS.edgee.baseUrl;
    const agent =
        process.env.EDGEE_COMPRESSOR_AGENT?.trim() ||
        cfg.agent ||
        DEFAULT_AGENT;
    const timeoutRaw = process.env.EDGEE_COMPRESSOR_TIMEOUT_MS?.trim();
    const timeoutMs = timeoutRaw
        ? Number(timeoutRaw)
        : (cfg.timeoutMs ?? BACKEND_DEFAULTS.edgee.timeoutMs);
    // oxlint-enable
    const legacyMinBytes = cfg.minBytes;

    return {
        baseUrl,
        agent,
        timeoutMs: Number.isFinite(timeoutMs)
            ? timeoutMs
            : BACKEND_DEFAULTS.edgee.timeoutMs,
        showStatus: cfg.showStatus ?? false,
        showWidget: cfg.showWidget ?? true,
        archiveOriginal: cfg.archiveOriginal ?? true,
        ...(typeof cfg.capFallbackBytes === "number" && cfg.capFallbackBytes > 0
            ? { capFallbackBytes: cfg.capFallbackBytes }
            : {}),
        routingStrategy: cfg.routingStrategy ?? "edgee",
        summaryGranularity: cfg.summaryGranularity ?? "all",
        enabled: cfg.enabled ?? true,
        excludeTools: cfg.excludeTools ?? [],
        minBytesByGroup: {
            shell:
                cfg.minBytesByGroup?.shell ??
                legacyMinBytes ??
                DEFAULT_MIN_BYTES_BY_GROUP.shell,
            read:
                cfg.minBytesByGroup?.read ??
                legacyMinBytes ??
                DEFAULT_MIN_BYTES_BY_GROUP.read,
            search:
                cfg.minBytesByGroup?.search ??
                legacyMinBytes ??
                DEFAULT_MIN_BYTES_BY_GROUP.search,
        },
        archiveRetention: {
            maxAgeDays:
                cfg.archiveRetention?.maxAgeDays ??
                DEFAULT_ARCHIVE_RETENTION.maxAgeDays,
            maxBytes:
                cfg.archiveRetention?.maxBytes ??
                DEFAULT_ARCHIVE_RETENTION.maxBytes,
        },
        aggregates: cfg.aggregates ?? true,
        capErrors: cfg.capErrors ?? true,
    };
}
