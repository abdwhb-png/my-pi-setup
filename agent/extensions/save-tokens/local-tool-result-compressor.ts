import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWidget } from "../_shared/fancy-footer";
import { appendCompressionEvent } from "../_shared/compression-protocol";
import { getLocalCompressorConfig } from "./config-runtime";
import { archiveOriginalToolResult } from "./tool-results/archive";
import { chooseCompressionRoute, createToolResultHandler, extractCompressibleText, isCompressibleToolName } from "./tool-results/core";
import {
  createCompressionMetrics,
  createCompressionMetricsFromEvents,
  formatDetailedStats,
  formatSavedBytes,
  formatStatsStatus,
  formatStatsWidgetLines,
} from "./tool-results/metrics";
import type {
  CompressionObservation,
  LocalCompressorConfig,
} from "./tool-results/types";
import { restoreMetricsFromSession, toCompressionEventPayload } from "./tool-results/session";
import { formatCompressionNotificationSummary, formatTurnNotification, STATUS_ID, summarizeCompressionEvents, updateUi, WIDGET_ID } from "./tool-results/ui";

export {
  createCompressionMetrics,
  createCompressionMetricsFromEvents,
  formatDetailedStats,
  formatSavedBytes,
  formatStatsStatus,
  formatStatsWidgetLines,
  createToolResultHandler,
  chooseCompressionRoute,
  extractCompressibleText,
  getLocalCompressorConfig,
  isCompressibleToolName,
  summarizeCompressionEvents,
};

export function shouldNotifyCompressionSummary(
  granularity: LocalCompressorConfig["summaryGranularity"],
  scope: "turn" | "agent",
): boolean {
  return granularity === "all" || granularity === scope;
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
    archiveOriginal: config.archiveOriginal || config.capFallbackBytes ? archiveOriginalToolResult : undefined,
    capFallbackBytes: config.capFallbackBytes,
    routingStrategy: config.routingStrategy,
    onObservation: handleObservation,
  });

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    config = getLocalCompressorConfig();
    metrics = restoreMetricsFromSession(ctx);
    pendingTurnEvents = [];
    pendingAgentEvents = [];
    handler = createToolResultHandler({
      baseUrl: config.baseUrl,
      agent: config.agent,
      timeoutMs: config.timeoutMs,
      archiveOriginal: config.archiveOriginal || config.capFallbackBytes ? archiveOriginalToolResult : undefined,
      capFallbackBytes: config.capFallbackBytes,
      routingStrategy: config.routingStrategy,
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
    if (!ctx.hasUI || pendingTurnEvents.length === 0 || !shouldNotifyCompressionSummary(config.summaryGranularity, "turn")) return;
    const summary = formatTurnNotification(pendingTurnEvents);
    ctx.ui.notify(summary.message, summary.type);
    pendingTurnEvents = [];
  });

  pi.on("agent_end", async (_event, ctx) => {
    latestCtx = ctx;
    if (!ctx.hasUI || pendingAgentEvents.length === 0 || !shouldNotifyCompressionSummary(config.summaryGranularity, "agent")) return;
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


