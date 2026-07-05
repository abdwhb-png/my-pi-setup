import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WidgetHandle } from "../../_shared/fancy-footer";
import { icon } from "../../_shared/compression-render";
import { createUiColors } from "../../_shared/ui-colors";
import { formatSavedBytes, formatStatsStatus, formatStatsWidgetLines } from "./metrics";
import type { CompressionObservation, CompressionSnapshot, CompressionSummary } from "./types";

export const STATUS_ID = "local-compressor";
export const WIDGET_ID = "local-compressor";

export function summarizeCompressionEvents(events: CompressionObservation[]): CompressionSummary {
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

export function updateUi(
  ctx: ExtensionContext | null,
  snapshot: CompressionSnapshot,
  baseUrl: string,
  widget: WidgetHandle | null,
  setWidgetText: (text: string) => void,
  showStatus: boolean,
  showWidget: boolean,
  event?: CompressionObservation,
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

export function formatCompressionNotificationSummary(scope: "turn" | "agent", events: CompressionObservation[]): { message: string; type: "info" | "warning" } {
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

export function formatTurnNotification(events: CompressionObservation[]): { message: string; type: "info" | "warning" } {
  return formatCompressionNotificationSummary("turn", events);
}