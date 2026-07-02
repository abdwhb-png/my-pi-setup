import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { createWidget, type WidgetHandle } from "../_shared/fancy-footer";
import { createUiColors } from "../_shared/ui-colors";
import {
  appendCompressionEvent,
  type CompressionDetails,
  type CompressionFailedReason,
  type CompressionKind,
  type CompressionSkippedReason,
} from "../_shared/compression-protocol";
import {icon} from "../_shared/compression-render";
import { loadCompressorConfig } from "./config";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const DEFAULT_COMPRESSOR_BASE_URL = "http://127.0.0.1:8320";
const DEFAULT_AGENT = "claude";
const DEFAULT_TIMEOUT_MS = 800;
const STATUS_ID = "local-compressor";
const WIDGET_ID = "local-compressor";

type CompressionObservation = {
  kind: CompressionKind;
  toolCallId: string;
  toolName: string;
  originalLength: number;
  compressedLength: number;
  subject?: string;
  reason?: CompressionSkippedReason | CompressionFailedReason;
};

type CompressionMetricObservation = {
  kind: CompressionKind;
  toolName: string;
  originalLength: number;
  compressedLength: number;
};

type CompressionSummary = {
  seen: number;
  compressed: number;
  skipped: number;
  failed: number;
  bytesSaved: number;
};

interface LocalCompressorConfig {
  baseUrl: string;
  agent: string;
  timeoutMs: number;
  showStatus: boolean;
  showWidget: boolean;
}

interface ToolResultHandlerOptions {
  fetchImpl?: FetchLike;
  baseUrl?: string;
  agent?: string;
  timeoutMs?: number;
  onObservation?: (event: CompressionObservation) => void;
}

interface CompressRequest {
  tool_name: string;
  arguments: string;
  output: string;
  agent: string;
}

interface CompressResponse {
  compressed_output?: string | null;
}

type ToolCompressionStats = {
  compressed: number;
  skipped: number;
  failed: number;
  bytesSaved: number;
};

type CompressionSnapshot = {
  seen: number;
  compressed: number;
  skipped: number;
  failed: number;
  bytesSaved: number;
  toolCounts: Record<string, number>;
  toolStats: Record<string, ToolCompressionStats>;
  firstCompressedTools: string[];
};

function normalizeToolName(toolName: string): string {
  if (toolName === "safe_bash") return "bash";
  if (toolName === "ls" || toolName === "find") return "glob";
  return toolName;
}

export function isCompressibleToolName(toolName: string): boolean {
  return toolName === "read" || toolName === "grep" || toolName === "bash" || toolName === "safe_bash" || toolName === "ls" || toolName === "find";
}

function isTextBlock(value: object | null | undefined): value is { type: "text"; text: string } {
  const block = value as { type?: string; text?: string } | null | undefined;
  return block?.type === "text" && typeof block.text === "string";
}

export function extractCompressibleText(content: object[]): string | null {
  if (!Array.isArray(content) || content.length === 0) return null;
  if (!content.every(isTextBlock)) return null;
  return content.map((block) => block.text).join("\n");
}

export function getLocalCompressorConfig(cwd = process.cwd()): LocalCompressorConfig {
  const cfg = loadCompressorConfig(cwd);

  const baseUrl = process.env.EDGEE_COMPRESSOR_BASE_URL?.trim() || cfg.baseUrl || DEFAULT_COMPRESSOR_BASE_URL;
  const agent = process.env.EDGEE_COMPRESSOR_AGENT?.trim() || cfg.agent || DEFAULT_AGENT;
  const timeoutRaw = process.env.EDGEE_COMPRESSOR_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : (cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  return {
    baseUrl,
    agent,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS,
    showStatus: cfg.showStatus ?? false,
    showWidget: cfg.showWidget ?? true,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function requestCompression(
  payload: CompressRequest,
  options: Required<Pick<ToolResultHandlerOptions, "fetchImpl" | "baseUrl" | "timeoutMs">>,
  signal?: AbortSignal,
): Promise<CompressResponse> {
  const response = await withTimeout(
    options.fetchImpl(`${options.baseUrl.replace(/\/$/, "")}/compress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    }),
    options.timeoutMs,
    signal,
  );

  if (!response.ok) {
    throw new Error(`compression service failed with status ${response.status}`);
  }

  const json = await response.json() as { compressed_output?: string | null };
  return { compressed_output: json.compressed_output };
}

function formatSavedBytes(bytesSaved: number): string {
  if (bytesSaved < 1000) return `${bytesSaved}B`;
  if (bytesSaved < 1_000_000) return `${(bytesSaved / 1000).toFixed(bytesSaved < 10_000 ? 1 : 0)}kB`;
  return `${(bytesSaved / 1_000_000).toFixed(1)}MB`;
}

function summarizeCompressionEvents(events: CompressionObservation[]): CompressionSummary {
  return events.reduce<CompressionSummary>((summary, event) => {
    summary.seen += 1;
    if (event.kind === "compressed") {
      summary.compressed += 1;
      summary.bytesSaved += Math.max(0, event.originalLength - event.compressedLength);
    } else if (event.kind === "skipped") {
      summary.skipped += 1;
    } else {
      summary.failed += 1;
    }
    return summary;
  }, { seen: 0, compressed: 0, skipped: 0, failed: 0, bytesSaved: 0 });
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

function updateUi(
  ctx: ExtensionContext | null,
  snapshot: CompressionSnapshot,
  baseUrl: string,
  widget: WidgetHandle | null,
  setWidgetText: (text: string) => void,
  showStatus: boolean,
  showWidget: boolean,
  event?: CompressionObservation
): void {
  if (!ctx?.hasUI) return;
  const colors = createUiColors(ctx.ui.theme);
  const status = formatStatsStatus(snapshot);
  const lines = formatStatsWidgetLines(snapshot, baseUrl);

  if (showStatus) {
    const statusText = snapshot.failed > 0
      ? colors.warning(status)
      : snapshot.compressed > 0
        ? colors.success(status)
        : colors.subtle(status);
    ctx.ui.setStatus(STATUS_ID, statusText);
  } else {
    ctx.ui.setStatus(STATUS_ID, "");
  }

  if (showWidget) {
    const lineOne = `${icon} • ${lines[0] ?? "compressor"}`;
    const lineTwo = lines[1] ?? "";
    const widgetText = [
      event?.kind === "failed" ? colors.danger(lineOne) : colors.primary(lineOne),
      colors.separator(" │ "),
      snapshot.failed > 0 ? colors.warning(lineTwo) : colors.meta(lineTwo),
    ].join("");
    setWidgetText(widgetText);
    widget?.update(ctx, widgetText);
  }
}

export function createToolResultHandler(options?: ToolResultHandlerOptions) {
  const env = getLocalCompressorConfig();
  const fetchImpl = options?.fetchImpl ?? fetch;
  const baseUrl = options?.baseUrl ?? env.baseUrl;
  const agent = options?.agent ?? env.agent;
  const timeoutMs = options?.timeoutMs ?? env.timeoutMs;

  return async (event: ToolResultEvent, signal?: AbortSignal) => {
    if (event.isError) return;
    if (!isCompressibleToolName(event.toolName)) return;

    const subject = summarizeToolSubject(event.toolName, event.input);

    const text = extractCompressibleText(event.content);
    if (!text) {
      options?.onObservation?.({
        kind: "skipped",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        originalLength: 0,
        compressedLength: 0,
        reason: "non_text_content",
        subject,
      });
      return;
    }

    const payload: CompressRequest = {
      tool_name: normalizeToolName(event.toolName),
      arguments: JSON.stringify(event.input ?? {}),
      output: text,
      agent,
    };

    try {
      const result = await requestCompression(payload, { fetchImpl, baseUrl, timeoutMs }, signal);
      if (!result.compressed_output || result.compressed_output === text) {
        options?.onObservation?.({
          kind: "skipped",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          originalLength: text.length,
          compressedLength: 0,
          reason: "no_change",
          subject,
        });
        return;
      }

      const originalLength = text.length;
      const compressedLength = result.compressed_output.length;
      if (compressedLength >= originalLength) {
        options?.onObservation?.({
          kind: "skipped",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          originalLength,
          compressedLength: 0,
          reason: "not_smaller",
          subject,
        });
        return;
      }

      const savedBytes = Math.max(0, originalLength - compressedLength);
      const savedPct = originalLength > 0 ? Math.round((savedBytes / originalLength) * 100) : 0;

      options?.onObservation?.({
        kind: "compressed",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        originalLength,
        compressedLength,
        subject,
      });
      return {
        content: [{ type: "text" as const, text: result.compressed_output }],
        details: {
          compression: {
            originalLength,
            compressedLength,
            savedBytes,
            savedPct,
          } satisfies CompressionDetails,
        },
      };
    } catch {
      options?.onObservation?.({
        kind: "failed",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        originalLength: text.length,
        compressedLength: 0,
        reason: "service_error",
        subject,
      });
      return;
    }
  };
}

export default function localToolResultCompressor(pi: ExtensionAPI): void {
  let latestCtx: ExtensionContext | null = null;
  let config = getLocalCompressorConfig();
  let metrics = createCompressionMetrics();
  let widgetText = "";
  let pendingTurnEvents: CompressionObservation[] = [];
  let pendingAgentEvents: CompressionObservation[] = [];
  const widget = createWidget(pi, {
    id: WIDGET_ID,
    label: "Compressor",
    description: "Local tool-result compression stats.",
    row: 0,
    order: 12,
    align: "left",
    grow: true,
    render: () => widgetText,
  });
  const setWidgetText = (text: string) => {
    widgetText = text;
  };

  const handleObservation = (event: CompressionObservation) => {
    metrics.record(event);
    const snapshot = metrics.snapshot();
    updateUi(latestCtx, snapshot, config.baseUrl, widget, setWidgetText, config.showStatus, config.showWidget, event);

    appendCompressionEvent(pi, toCompressionEventPayload(event));
    pendingTurnEvents.push(event);
    pendingAgentEvents.push(event);
  };

  let handler = createToolResultHandler({
    baseUrl: config.baseUrl,
    agent: config.agent,
    timeoutMs: config.timeoutMs,
    onObservation: handleObservation,
  });

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    config = getLocalCompressorConfig();
    metrics = createCompressionMetrics();
    pendingTurnEvents = [];
    pendingAgentEvents = [];
    handler = createToolResultHandler({
      baseUrl: config.baseUrl,
      agent: config.agent,
      timeoutMs: config.timeoutMs,
      onObservation: handleObservation,
    });
    updateUi(latestCtx, metrics.snapshot(), config.baseUrl, widget, setWidgetText, config.showStatus, config.showWidget);
  });

  pi.on("agent_start", async () => {
    pendingAgentEvents = [];
  });

  pi.on("turn_start", async () => {
    pendingTurnEvents = [];
  });

  pi.on("turn_end", async (_event, ctx) => {
    latestCtx = ctx;
    if (!ctx.hasUI || pendingTurnEvents.length === 0) return;
    const summary = formatTurnNotification(pendingTurnEvents);
    ctx.ui.notify(summary.message, summary.type);
    pendingTurnEvents = [];
  });

  pi.on("agent_end", async (_event, ctx) => {
    latestCtx = ctx;
    // If hasUI always notify on agent_end even if no events were recorded, to ensure the user sees the final summary.
    if (!ctx.hasUI) return;
    const summary = formatCompressionNotificationSummary("agent", pendingAgentEvents);
    ctx.ui.notify(summary.message, summary.type);
    pendingAgentEvents = [];
  });

  pi.registerCommand("compressor-stats", {
    description: "Show or reset local tool-result compressor stats. Usage: /compressor-stats [reset]",
    handler: async (args, ctx) => {
      latestCtx = ctx;
      const command = args.trim().toLowerCase();
      if (command === "reset") {
        metrics.reset();
        updateUi(latestCtx, metrics.snapshot(), config.baseUrl, widget, setWidgetText, config.showStatus, config.showWidget);
        ctx.ui.notify("compressor stats reset", "info");
        return;
      }

      ctx.ui.notify(formatDetailedStats(metrics.snapshot(), config.baseUrl), "info");
    },
  });

  pi.on("tool_result", async (event, ctx) => {
    latestCtx = ctx;
    const result = await handler(event, ctx.signal);
    return result;
  });

  pi.on("session_shutdown", async () => {
    if (latestCtx?.hasUI) {
      latestCtx.ui.setStatus(STATUS_ID, undefined);
      widget.remove(latestCtx);
    }
    latestCtx = null;
  });
}

function toCompressionEventPayload(event: CompressionObservation) {
  const timestamp = Date.now();
  if (event.kind === "compressed") {
    const savedBytes = Math.max(0, event.originalLength - event.compressedLength);
    const savedPct = event.originalLength > 0 ? Math.round((savedBytes / event.originalLength) * 100) : 0;
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
  };
}

function summarizeToolSubject(toolName: string, input: object | undefined): string | undefined {
  if (!input) return undefined;
  const record = input as Record<string, object | string | number | boolean | undefined>;
  if (toolName === "read") {
    const path = record.path ?? record.file_path;
    return typeof path === "string" ? basename(path) : undefined;
  }
  if (toolName === "grep") {
    const path = record.path;
    const pattern = record.pattern;
    if (typeof path === "string") return basename(path);
    return typeof pattern === "string" ? pattern : undefined;
  }
  if (toolName === "ls") {
    const path = record.path;
    return typeof path === "string" ? basename(path) || path : undefined;
  }
  if (toolName === "find") {
    const path = record.path;
    const pattern = record.pattern;
    if (typeof pattern === "string") return pattern;
    return typeof path === "string" ? basename(path) || path : undefined;
  }
  if (toolName === "bash" || toolName === "safe_bash") {
    const command = record.command;
    if (typeof command !== "string") return undefined;
    return command.length > 48 ? `${command.slice(0, 45)}...` : command;
  }
  return undefined;
}

function formatCompressionNotificationSummary(scope: "turn" | "agent", events: CompressionObservation[]): { message: string; type: "info" | "warning" } {
  const summary = summarizeCompressionEvents(events);
  const parts = [`ok ${summary.compressed}/${summary.seen}`];
  if (summary.bytesSaved > 0) parts.push(`saved ${formatSavedBytes(summary.bytesSaved)}`);
  if (summary.skipped > 0 || summary.failed > 0) parts.push(`skipped ${summary.skipped}`);
  parts.push(`fail ${summary.failed}`);

  return {
    message: `${icon} compression ${scope}: ${parts.join(" • ")}`,
    type: summary.failed > 0 ? "warning" : "info",
  };
}

function formatTurnNotification(events: CompressionObservation[]): { message: string; type: "info" | "warning" } {
  return formatCompressionNotificationSummary("turn", events);
}
