import type { CompressionEventPayload } from "../../_shared/compression-protocol";
import type { CompressionMetricObservation, CompressionSnapshot, ToolCompressionStats } from "./types";

export function formatSavedBytes(bytesSaved: number): string {
  if (bytesSaved < 1000) return `${bytesSaved}B`;
  if (bytesSaved < 1_000_000) return `${(bytesSaved / 1000).toFixed(bytesSaved < 10_000 ? 1 : 0)}kB`;
  return `${(bytesSaved / 1_000_000).toFixed(1)}MB`;
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
  }

  return {
    record(event: CompressionMetricObservation) {
      seen += 1;
      const stats = ensureTool(event.toolName);

      if (event.kind === "compressed") {
        const saved = Math.max(0, event.originalLength - event.compressedLength);
        compressed += 1;
        bytesSaved += saved;
        stats.compressed += 1;
        stats.bytesSaved += saved;
        toolCounts.set(event.toolName, (toolCounts.get(event.toolName) ?? 0) + 1);
        if (!firstCompressedTools.includes(event.toolName)) firstCompressedTools.push(event.toolName);
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
      };
    },
  };
}

export function createCompressionMetricsFromEvents(events: CompressionEventPayload[]) {
  const metrics = createCompressionMetrics();
  for (const event of events) {
    if (event.kind === "compressed") {
      metrics.record({
        kind: "compressed",
        toolName: event.toolName,
        originalLength: event.originalLength,
        compressedLength: event.compressedLength,
      });
      continue;
    }
    metrics.record({
      kind: event.kind,
      toolName: event.toolName,
      originalLength: event.originalLength,
      compressedLength: 0,
    });
  }
  return metrics;
}

export function formatStatsStatus(snapshot: CompressionSnapshot): string {
  return `cmp ${snapshot.compressed}/${snapshot.seen} ok • saved ${formatSavedBytes(snapshot.bytesSaved)} • fail ${snapshot.failed}`;
}

function getTopTools(snapshot: CompressionSnapshot, limit = 3): Array<[string, ToolCompressionStats]> {
  return Object.entries(snapshot.toolStats)
    .filter(([, stats]) => stats.compressed > 0 || stats.bytesSaved > 0)
    .toSorted((a, b) => b[1].bytesSaved - a[1].bytesSaved || b[1].compressed - a[1].compressed || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

export function formatStatsWidgetLines(snapshot: CompressionSnapshot, baseUrl: string): string[] {
  const topTools = getTopTools(snapshot)
    .map(([toolName, stats]) => `${toolName} ${formatSavedBytes(stats.bytesSaved)}`)
    .join(", ");

  return [
    `compressor ${baseUrl}`,
    `ok ${snapshot.compressed}/${snapshot.seen} • saved ${formatSavedBytes(snapshot.bytesSaved)} • fail ${snapshot.failed} • top: ${topTools || "none"}`,
  ];
}

export function formatDetailedStats(snapshot: CompressionSnapshot, baseUrl: string): string {
  const topTools = getTopTools(snapshot, 10);
  const lines = [
    `Local compressor: ${baseUrl}`,
    `Summary: ok ${snapshot.compressed}/${snapshot.seen} • skipped ${snapshot.skipped} • fail ${snapshot.failed} • saved ${formatSavedBytes(snapshot.bytesSaved)}`,
    "",
    "Top tools:",
  ];

  if (topTools.length === 0) {
    lines.push("none yet");
  } else {
    topTools.forEach(([toolName, stats], index) => {
      lines.push(`${index + 1}. ${toolName} — saved ${formatSavedBytes(stats.bytesSaved)} • ok ${stats.compressed} • skipped ${stats.skipped} • fail ${stats.failed}`);
    });
  }

  return lines.join("\n");
}