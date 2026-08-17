import type { CompressionEventPayload } from "../../_shared/compression-protocol";
import type {
    CompressionMetricObservation,
    CompressionSnapshot,
    RecentCompressionCall,
    ToolCompressionStats,
} from "./types";

/** Bound on the recent-call state kept for widget derived state. */
export const RECENT_CALL_LIMIT = 20;

export function formatSavedBytes(bytesSaved: number): string {
    if (bytesSaved < 1000) return `${bytesSaved}B`;
    if (bytesSaved < 1_000_000)
        return `${(bytesSaved / 1000).toFixed(bytesSaved < 10_000 ? 1 : 0)}kB`;
    return `${(bytesSaved / 1_000_000).toFixed(1)}MB`;
}

/**
 * Derives widget state exclusively from recent observations.
 * No health polling — everything comes from observed calls.
 */
export function deriveRecentState(calls: readonly RecentCompressionCall[]): {
    ok: number;
    skipped: number;
    failed: number;
    savedBytes: number;
    avgLatencyMs?: number;
} {
    let ok = 0;
    let skipped = 0;
    let failed = 0;
    let savedBytes = 0;
    let latencyTotal = 0;
    let latencyCount = 0;
    for (const call of calls) {
        if (call.kind === "compressed") {
            ok += 1;
            savedBytes += Math.max(
                0,
                call.originalLength - call.compressedLength,
            );
        } else if (call.kind === "skipped") {
            skipped += 1;
        } else {
            failed += 1;
        }
        if (call.latencyMs !== undefined) {
            latencyTotal += call.latencyMs;
            latencyCount += 1;
        }
    }
    return {
        ok,
        skipped,
        failed,
        savedBytes,
        ...(latencyCount > 0
            ? { avgLatencyMs: Math.round(latencyTotal / latencyCount) }
            : {}),
    };
}

export function createCompressionMetrics() {
    let seen = 0;
    let compressed = 0;
    let skipped = 0;
    let failed = 0;
    let bytesSaved = 0;
    const toolCounts = new Map<string, number>();
    const toolStats = new Map<string, ToolCompressionStats>();
    const firstCompressedTools: string[] = [];
    const recentCalls: RecentCompressionCall[] = [];

    function ensureTool(toolName: string): ToolCompressionStats {
        let stats = toolStats.get(toolName);
        if (!stats) {
            stats = { compressed: 0, skipped: 0, failed: 0, bytesSaved: 0 };
            toolStats.set(toolName, stats);
            toolCounts.set(toolName, 0);
        }
        return stats;
    }

    function reset() {
        seen = 0;
        compressed = 0;
        skipped = 0;
        failed = 0;
        bytesSaved = 0;
        toolCounts.clear();
        toolStats.clear();
        firstCompressedTools.length = 0;
        recentCalls.length = 0;
    }

    return {
        record(event: CompressionMetricObservation) {
            seen += 1;
            const stats = ensureTool(event.toolName);

            recentCalls.push({
                kind: event.kind,
                toolName: event.toolName,
                originalLength: event.originalLength,
                compressedLength: event.compressedLength,
                ...(event.latencyMs !== undefined
                    ? { latencyMs: event.latencyMs }
                    : {}),
            });
            if (recentCalls.length > RECENT_CALL_LIMIT) recentCalls.shift();

            if (event.kind === "compressed") {
                const saved = Math.max(
                    0,
                    event.originalLength - event.compressedLength,
                );
                compressed += 1;
                bytesSaved += saved;
                stats.compressed += 1;
                stats.bytesSaved += saved;
                toolCounts.set(
                    event.toolName,
                    (toolCounts.get(event.toolName) ?? 0) + 1,
                );
                if (!firstCompressedTools.includes(event.toolName))
                    firstCompressedTools.push(event.toolName);
                return;
            }

            if (event.kind === "skipped") {
                skipped += 1;
                stats.skipped += 1;
                return;
            }

            failed += 1;
            stats.failed += 1;
        },

        reset,

        snapshot(): CompressionSnapshot {
            return {
                seen,
                compressed,
                skipped,
                failed,
                bytesSaved,
                toolCounts: Object.fromEntries(toolCounts.entries()),
                toolStats: Object.fromEntries(toolStats.entries()),
                firstCompressedTools: [...firstCompressedTools],
                recentCalls: [...recentCalls],
            };
        },
    };
}

export function createCompressionMetricsFromEvents(
    events: CompressionEventPayload[],
) {
    const metrics = createCompressionMetrics();
    for (const event of events) {
        if (event.kind === "compressed") {
            metrics.record({
                kind: "compressed",
                toolName: event.toolName,
                originalLength: event.originalLength,
                compressedLength: event.compressedLength,
                ...(event.latencyMs !== undefined
                    ? { latencyMs: event.latencyMs }
                    : {}),
            });
            continue;
        }
        metrics.record({
            kind: event.kind,
            toolName: event.toolName,
            originalLength: event.originalLength,
            compressedLength: 0,
            ...(event.latencyMs !== undefined
                ? { latencyMs: event.latencyMs }
                : {}),
        });
    }
    return metrics;
}

export function formatStatsStatus(snapshot: CompressionSnapshot): string {
    return `cmp ${snapshot.compressed}/${snapshot.seen} ok • saved ${formatSavedBytes(snapshot.bytesSaved)} • fail ${snapshot.failed}`;
}

function getTopTools(
    snapshot: CompressionSnapshot,
    limit = 3,
): Array<[string, ToolCompressionStats]> {
    return Object.entries(snapshot.toolStats)
        .filter(([, stats]) => stats.compressed > 0 || stats.bytesSaved > 0)
        .toSorted(
            (a, b) =>
                b[1].bytesSaved - a[1].bytesSaved ||
                b[1].compressed - a[1].compressed ||
                a[0].localeCompare(b[0]),
        )
        .slice(0, limit);
}

/**
 * Widget lines: the active engine (never a base URL) plus state derived from
 * the bounded recent observations. No health polling.
 */
export function formatStatsWidgetLines(
    snapshot: CompressionSnapshot,
    engine: string,
): string[] {
    const recent = deriveRecentState(snapshot.recentCalls);
    const recentLine =
        snapshot.recentCalls.length === 0
            ? "no calls yet"
            : `last ${snapshot.recentCalls.length}: ok ${recent.ok} • saved ${formatSavedBytes(recent.savedBytes)} • fail ${recent.failed}${recent.avgLatencyMs !== undefined ? ` • avg ${recent.avgLatencyMs}ms` : ""}`;

    return [`compressor ${engine}`, recentLine];
}

export function formatDetailedStats(
    snapshot: CompressionSnapshot,
    engine: string,
): string {
    const topTools = getTopTools(snapshot, 10);
    const lines = [
        `Local compressor: ${engine}`,
        `Summary: ok ${snapshot.compressed}/${snapshot.seen} • skipped ${snapshot.skipped} • fail ${snapshot.failed} • saved ${formatSavedBytes(snapshot.bytesSaved)}`,
        "",
        "Top tools:",
    ];

    if (topTools.length === 0) {
        lines.push("none yet");
    } else {
        topTools.forEach(([toolName, stats], index) => {
            lines.push(
                `${index + 1}. ${toolName} — saved ${formatSavedBytes(stats.bytesSaved)} • ok ${stats.compressed} • skipped ${stats.skipped} • fail ${stats.failed}`,
            );
        });
    }

    return lines.join("\n");
}
