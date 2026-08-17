import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
    CompressionFailedReason,
    CompressionSkippedReason,
} from "../../_shared/compression-protocol";
import { listCompressionEvents } from "../../_shared/compression-protocol";
import { createCompressionMetricsFromEvents } from "./metrics";
import type { CompressionObservation } from "./types";

type SessionEntryReader = {
    sessionManager?: {
        getEntries?: () => ReadonlyArray<{
            type: string;
            customType?: string;
            data?: object;
        }>;
    };
};

export function restoreMetricsFromSession(
    ctx: ExtensionContext,
): ReturnType<typeof createCompressionMetricsFromEvents> {
    const entries =
        (ctx as SessionEntryReader).sessionManager?.getEntries?.() ?? [];
    return createCompressionMetricsFromEvents(listCompressionEvents(entries));
}

export function toCompressionEventPayload(event: CompressionObservation) {
    const timestamp = Date.now();
    const enriched = {
        ...(event.backend ? { backend: event.backend } : {}),
        ...(event.backendVersion
            ? { backendVersion: event.backendVersion }
            : {}),
        ...(event.latencyMs !== undefined
            ? { latencyMs: event.latencyMs }
            : {}),
        ...(event.tokenizer ? { tokenizer: event.tokenizer } : {}),
        ...(event.nativeMetrics && Object.keys(event.nativeMetrics).length > 0
            ? { nativeMetrics: event.nativeMetrics }
            : {}),
    };
    if (event.kind === "compressed") {
        const savedBytes = Math.max(
            0,
            event.originalLength - event.compressedLength,
        );
        const savedPct =
            event.originalLength > 0
                ? Math.round((savedBytes / event.originalLength) * 100)
                : 0;
        return {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            timestamp,
            kind: "compressed" as const,
            originalLength: event.originalLength,
            subject: event.subject,
            compressedLength: event.compressedLength,
            savedBytes,
            savedPct,
            archivePath: event.archivePath,
            ...(event.originalUtf8Bytes !== undefined
                ? { originalUtf8Bytes: event.originalUtf8Bytes }
                : {}),
            ...(event.compressedUtf8Bytes !== undefined
                ? { compressedUtf8Bytes: event.compressedUtf8Bytes }
                : {}),
            ...(event.estimatedTokensBefore !== undefined
                ? { estimatedTokensBefore: event.estimatedTokensBefore }
                : {}),
            ...(event.estimatedTokensAfter !== undefined
                ? { estimatedTokensAfter: event.estimatedTokensAfter }
                : {}),
            ...enriched,
        };
    }

    if (event.kind === "skipped") {
        return {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            timestamp,
            kind: "skipped" as const,
            originalLength: event.originalLength,
            subject: event.subject,
            reason: event.reason as CompressionSkippedReason,
            ...enriched,
        };
    }

    return {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        timestamp,
        kind: "failed" as const,
        originalLength: event.originalLength,
        subject: event.subject,
        reason: event.reason as CompressionFailedReason,
        ...enriched,
    };
}
