import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { createWidget, type WidgetHandle } from "./_shared/fancy-footer";
import { createUiColors } from "./_shared/ui-colors";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const DEFAULT_COMPRESSOR_BASE_URL = "http://127.0.0.1:8320";
const DEFAULT_AGENT = "claude";
const DEFAULT_TIMEOUT_MS = 800;
const STATUS_ID = "local-compressor";
const WIDGET_ID = "local-compressor";

type CompressionObservation =
  | { kind: "compressed"; toolName: string; originalLength: number; compressedLength: number }
  | { kind: "skipped"; toolName: string; reason: "non_text_content" | "no_change"; originalLength: number }
  | { kind: "failed"; toolName: string; reason: "service_error"; originalLength: number };

interface LocalCompressorConfig {
  baseUrl: string;
  agent: string;
  timeoutMs: number;
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

export function getLocalCompressorConfig(): LocalCompressorConfig {
  const timeoutRaw = process.env.EDGEE_COMPRESSOR_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : DEFAULT_TIMEOUT_MS;
  return {
    baseUrl: process.env.EDGEE_COMPRESSOR_BASE_URL?.trim() || DEFAULT_COMPRESSOR_BASE_URL,
    agent: process.env.EDGEE_COMPRESSOR_AGENT?.trim() || DEFAULT_AGENT,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS,
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
    record(event: CompressionObservation) {
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
    .sort((a, b) => b[1].bytesSaved - a[1].bytesSaved || b[1].compressed - a[1].compressed || a[0].localeCompare(b[0]))
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

function formatCompressionNotification(event: Extract<CompressionObservation, { kind: "compressed" }>): string {
  const saved = Math.max(0, event.originalLength - event.compressedLength);
  const savedPct = event.originalLength > 0 ? Math.round((saved / event.originalLength) * 100) : 0;
  return `compressed ${event.toolName}: ${event.originalLength} → ${event.compressedLength} chars (-${saved}, ${savedPct}%)`;
}

function updateUi(
  ctx: ExtensionContext | null,
  snapshot: CompressionSnapshot,
  baseUrl: string,
  widget: WidgetHandle | null,
  setWidgetText: (text: string) => void,
): void {
  if (!ctx?.hasUI) return;
  const colors = createUiColors(ctx.ui.theme);
  const status = formatStatsStatus(snapshot);
  const lines = formatStatsWidgetLines(snapshot, baseUrl);
  const statusText = snapshot.failed > 0
    ? colors.warning(status)
    : snapshot.compressed > 0
      ? colors.success(status)
      : colors.subtle(status);
  const widgetText = [
    colors.primary(lines[0] ?? "compressor"),
    colors.separator(" │ "),
    snapshot.failed > 0 ? colors.warning(lines[1] ?? "") : colors.meta(lines[1] ?? ""),
  ].join("");

  ctx.ui.setStatus(STATUS_ID, statusText);
  setWidgetText(widgetText);
  widget?.update(ctx, widgetText);
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

    const text = extractCompressibleText(event.content);
    if (!text) {
      options?.onObservation?.({
        kind: "skipped",
        toolName: event.toolName,
        reason: "non_text_content",
        originalLength: 0,
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
          toolName: event.toolName,
          reason: "no_change",
          originalLength: text.length,
        });
        return;
      }

      options?.onObservation?.({
        kind: "compressed",
        toolName: event.toolName,
        originalLength: text.length,
        compressedLength: result.compressed_output.length,
      });
      return {
        content: [{ type: "text" as const, text: result.compressed_output }],
      };
    } catch {
      options?.onObservation?.({
        kind: "failed",
        toolName: event.toolName,
        reason: "service_error",
        originalLength: text.length,
      });
      return;
    }
  };
}

export default function localToolResultCompressor(pi: ExtensionAPI): void {
  let latestCtx: ExtensionContext | null = null;
  let config = getLocalCompressorConfig();
  let metrics = createCompressionMetrics();
  let notifiedTools = new Set<string>();
  let notifiedFailure = false;
  let widgetText = "";
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
    updateUi(latestCtx, snapshot, config.baseUrl, widget, setWidgetText);

    if (!latestCtx?.hasUI) return;
    if (event.kind === "compressed" && !notifiedTools.has(event.toolName)) {
      notifiedTools.add(event.toolName);
      latestCtx.ui.notify(formatCompressionNotification(event), "info");
      return;
    }

    if (event.kind === "failed" && !notifiedFailure) {
      notifiedFailure = true;
      latestCtx.ui.notify(`compressor unavailable: ${config.baseUrl}`, "warning");
    }
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
    notifiedTools = new Set<string>();
    notifiedFailure = false;
    handler = createToolResultHandler({
      baseUrl: config.baseUrl,
      agent: config.agent,
      timeoutMs: config.timeoutMs,
      onObservation: handleObservation,
    });
    updateUi(latestCtx, metrics.snapshot(), config.baseUrl, widget, setWidgetText);
  });

  pi.registerCommand("compressor-stats", {
    description: "Show or reset local tool-result compressor stats. Usage: /compressor-stats [reset]",
    handler: async (args, ctx) => {
      latestCtx = ctx;
      const command = args.trim().toLowerCase();
      if (command === "reset") {
        metrics.reset();
        notifiedTools = new Set<string>();
        notifiedFailure = false;
        updateUi(latestCtx, metrics.snapshot(), config.baseUrl, widget, setWidgetText);
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
