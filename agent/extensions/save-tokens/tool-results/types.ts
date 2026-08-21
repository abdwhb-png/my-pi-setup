import type {
    CompressionBackendMetrics,
    CompressionFailedReason,
    CompressionKind,
    CompressionSkippedReason,
} from "../../_shared/compression-protocol";

// ---------------------------------------------------------------------------
// Backend contracts
// ---------------------------------------------------------------------------

export type CompressionBackendId = "headroom" | "edgee";

/**
 * Verified engine versions for telemetry.
 * - `edgee`: vendored `edgee-compressor` crate version 0.1.3 (crates.io).
 * - `headroom`: upstream pin (full commit) of the headroom-source clone.
 */
export const COMPRESSION_BACKEND_VERSIONS: Record<
    CompressionBackendId,
    string
> = {
    headroom: "322425c43bffde1ed0b64fecf3cf5951565dd82b",
    edgee: "0.1.3",
};

export interface CompressorModel {
    provider: string;
    id: string;
    contextWindow: number;
}

export interface CompressionBackendRequest {
    toolCallId: string;
    toolName: string;
    arguments: unknown;
    output: string;
    model: CompressorModel;
}

export interface CompressionBackendResult {
    output: string | null;
    reason?: string;
    metrics?: CompressionBackendMetrics;
}

export interface CompressionBackend {
    readonly id: CompressionBackendId;
    compress(
        request: CompressionBackendRequest,
        signal?: AbortSignal,
    ): Promise<CompressionBackendResult>;
    /**
     * Optional reachability probe used by the health poller. Any HTTP response
     * (even a 4xx from a relay that rejects non-compress paths) means the
     * service is up; network errors and timeouts mean down. Backends that do
     * not implement it are treated as "unknown" by the health poller.
     */
    ping?(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// General types
// ---------------------------------------------------------------------------

export type FetchLike = (
    input: string | URL | Request,
    init?: RequestInit,
) => Promise<Response>;

export type CompressionGroup = "shell" | "read" | "search";
export type CompressionThresholds = Record<CompressionGroup, number>;

export interface ArchiveRetentionConfig {
    maxAgeDays: number;
    maxBytes: number;
}

export type CompressionObservation = {
    kind: CompressionKind;
    toolCallId: string;
    toolName: string;
    originalLength: number;
    compressedLength: number;
    subject?: string;
    reason?: CompressionSkippedReason | CompressionFailedReason;
    archivePath?: string;
    /** Selected backend id, when a backend was configured (Task 10). */
    backend?: CompressionBackendId;
    /** Verified backend engine version (Task 10). */
    backendVersion?: string;
    /** Backend call latency in ms, measured by the policy layer (Task 10). */
    latencyMs?: number;
    /** Native engine metrics normalized by the adapter (Task 10). */
    nativeMetrics?: CompressionBackendMetrics;
    /** Tokenizer family selected by the engine registry, when factual (Task 10). */
    tokenizer?: string;
    /** UTF-8 byte length of the original tool output. */
    originalUtf8Bytes?: number;
    /** UTF-8 byte length of the compressed/replaced output. */
    compressedUtf8Bytes?: number;
    /** Conservative local token estimate of the original output. */
    estimatedTokensBefore?: number;
    /** Conservative local token estimate of the compressed output. */
    estimatedTokensAfter?: number;
};

export type CompressionMetricObservation = {
    kind: CompressionKind;
    toolName: string;
    originalLength: number;
    compressedLength: number;
    latencyMs?: number;
};

/** One bounded recent call, used to derive widget state. */
export type RecentCompressionCall = {
    kind: CompressionKind;
    toolName: string;
    originalLength: number;
    compressedLength: number;
    latencyMs?: number;
};

export type CompressionSummary = {
    seen: number;
    compressed: number;
    skipped: number;
    failed: number;
    bytesSaved: number;
};

export interface LocalCompressorConfig {
    baseUrl: string;
    agent: string;
    timeoutMs: number;
    showStatus: boolean;
    showWidget: boolean;
    archiveOriginal: boolean;
    capFallbackTokens?: number;
    maxFallbackBytes?: number;
    routingStrategy: "edgee" | "benchmark";
    summaryGranularity: "none" | "turn" | "agent" | "all";
    enabled: boolean;
    excludeTools: string[];
    /** Input threshold, in estimated tokens, per compression group. */
    minTokensByGroup: CompressionThresholds;
    archiveRetention: ArchiveRetentionConfig;
    aggregates: boolean;
    capErrors: boolean;
}

export interface ArchiveOriginalInput {
    toolCallId: string;
    toolName: string;
    subject?: string;
    input?: object;
    text: string;
    sourcePath?: string;
}

/**
 * Policy-only options. Transport concerns (URL, timeout, agent, fetch) live in
 * the selected {@link CompressionBackend} adapter, never here.
 */
export interface ToolResultHandlerOptions {
    backend?: CompressionBackend | null;
    backendFailureReason?: Extract<CompressionFailedReason, "invalid_backend">;
    /** Verified version of the selected backend engine (Task 10 telemetry). */
    backendVersion?: string;
    onObservation?: (event: CompressionObservation) => void;
    archiveOriginal?: (input: ArchiveOriginalInput) => Promise<string | null>;
    /** Cap budget in estimated tokens (primary policy unit). */
    capFallbackTokens?: number;
    /** Hard safety ceiling on the capped result, in UTF-8 bytes. */
    maxFallbackBytes?: number;
    routingStrategy?: "edgee" | "benchmark";
    enabled?: boolean;
    excludeTools?: string[];
    /** Input threshold, in estimated tokens, per compression group. */
    minTokensByGroup?: CompressionThresholds;
    aggregates?: boolean;
    capErrors?: boolean;
}

export type ToolCompressionStats = {
    compressed: number;
    skipped: number;
    failed: number;
    bytesSaved: number;
};

export type CompressionSnapshot = {
    seen: number;
    compressed: number;
    skipped: number;
    failed: number;
    bytesSaved: number;
    toolCounts: Record<string, number>;
    toolStats: Record<string, ToolCompressionStats>;
    firstCompressedTools: string[];
    /** Bounded recent-call state; widget derived state comes from it. */
    recentCalls: RecentCompressionCall[];
};
