import { loadCompressorConfig } from './config';
import type {
    ArchiveRetentionConfig,
    CompressionThresholds,
    LocalCompressorConfig,
} from './tool-results/types';

const DEFAULT_COMPRESSOR_BASE_URL = 'http://127.0.0.1:8320';
const DEFAULT_AGENT = 'claude';
const DEFAULT_TIMEOUT_MS = 800;
const DEFAULT_MIN_BYTES_BY_GROUP: CompressionThresholds = {
    shell: 4096,
    read: 8192,
    search: 4096,
};
const DEFAULT_ARCHIVE_RETENTION: ArchiveRetentionConfig = {
    maxAgeDays: 30,
    maxBytes: 1_073_741_824,
};

export function getLocalCompressorConfig(
    cwd = process.cwd(),
): LocalCompressorConfig {
    const cfg = loadCompressorConfig(cwd);

    const baseUrl =
        process.env.EDGEE_COMPRESSOR_BASE_URL?.trim() ||
        cfg.baseUrl ||
        DEFAULT_COMPRESSOR_BASE_URL;
    const agent =
        process.env.EDGEE_COMPRESSOR_AGENT?.trim() ||
        cfg.agent ||
        DEFAULT_AGENT;
    const timeoutRaw = process.env.EDGEE_COMPRESSOR_TIMEOUT_MS?.trim();
    const timeoutMs = timeoutRaw
        ? Number(timeoutRaw)
        : (cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const legacyMinBytes = cfg.minBytes;

    return {
        baseUrl,
        agent,
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS,
        showStatus: cfg.showStatus ?? false,
        showWidget: cfg.showWidget ?? true,
        archiveOriginal: cfg.archiveOriginal ?? true,
        ...(typeof cfg.capFallbackBytes === 'number' && cfg.capFallbackBytes > 0
            ? { capFallbackBytes: cfg.capFallbackBytes }
            : {}),
        routingStrategy: cfg.routingStrategy ?? 'edgee',
        summaryGranularity: cfg.summaryGranularity ?? 'all',
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
    };
}
