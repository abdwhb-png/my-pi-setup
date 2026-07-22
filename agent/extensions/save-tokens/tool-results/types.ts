import type {
    CompressionFailedReason,
    CompressionKind,
    CompressionSkippedReason,
} from '../../_shared/compression-protocol';

export type FetchLike = (
    input: string | URL | Request,
    init?: RequestInit,
) => Promise<Response>;

export type CompressionGroup = 'shell' | 'read' | 'search';
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
};

export type CompressionMetricObservation = {
    kind: CompressionKind;
    toolName: string;
    originalLength: number;
    compressedLength: number;
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
    capFallbackBytes?: number;
    routingStrategy: 'edgee' | 'benchmark';
    summaryGranularity: 'none' | 'turn' | 'agent' | 'all';
    enabled: boolean;
    excludeTools: string[];
    minBytesByGroup: CompressionThresholds;
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

export interface ToolResultHandlerOptions {
    fetchImpl?: FetchLike;
    baseUrl?: string;
    agent?: string;
    timeoutMs?: number;
    onObservation?: (event: CompressionObservation) => void;
    archiveOriginal?: (input: ArchiveOriginalInput) => Promise<string | null>;
    capFallbackBytes?: number;
    routingStrategy?: 'edgee' | 'benchmark';
    enabled?: boolean;
    excludeTools?: string[];
    minBytes?: number;
    minBytesByGroup?: CompressionThresholds;
    aggregates?: boolean;
    capErrors?: boolean;
}

export interface CompressRequest {
    tool_name: string;
    arguments: string;
    output: string;
    agent: string;
}

export interface CompressResponse {
    compressed_output?: string | null;
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
};
