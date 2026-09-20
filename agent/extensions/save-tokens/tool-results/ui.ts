import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { icon } from "../../_shared/compression-render";
import type { WidgetHandle } from "../../_shared/fancy-footer";
import {
    createUiColors,
    type UiColorsCreation,
} from "../../_shared/ui/ui-colors";
import type { HealthState } from "./health";
import {
    formatSavedBytes,
    formatStatsStatus,
    formatStatsWidgetLines,
} from "./metrics";
import type {
    CompressionObservation,
    CompressionSnapshot,
    CompressionSummary,
} from "./types";

export const STATUS_ID = "local-compressor";
export const WIDGET_ID = "local-compressor";

export function renderCompressionStatusText(
    snapshot: CompressionSnapshot,
    health: HealthState,
    colors: UiColorsCreation,
): string {
    const status = formatStatsStatus(snapshot);
    if (health === "down") return colors.warning(`${status} • offline`);
    if (snapshot.failed > 0) return colors.warning(status);
    if (snapshot.compressed > 0) return colors.success(status);
    return colors.subtle(status);
}

export function renderCompressionWidgetText(
    snapshot: CompressionSnapshot,
    engine: string,
    health: HealthState,
    colors: UiColorsCreation,
    event?: CompressionObservation,
): string {
    const lines = formatStatsWidgetLines(snapshot, engine);
    const lineOne = `${icon} • ${lines[0] ?? "compressor"}`;
    const lineTwo = health === "down" ? "offline" : (lines[1] ?? "");
    return [
        event?.kind === "failed"
            ? colors.danger(lineOne)
            : colors.primary(lineOne),
        colors.separator(" │ "),
        health === "down"
            ? colors.danger(lineTwo)
            : snapshot.failed > 0
              ? colors.warning(lineTwo)
              : colors.meta(lineTwo),
    ].join("");
}

export function summarizeCompressionEvents(
    events: CompressionObservation[],
): CompressionSummary {
    return events.reduce<CompressionSummary>(
        (summary, event) => {
            summary.seen += 1;
            if (event.kind === "compressed") {
                summary.compressed += 1;
                summary.bytesSaved += Math.max(
                    0,
                    event.originalLength - event.compressedLength,
                );
            } else if (event.kind === "skipped") {
                summary.skipped += 1;
            } else {
                summary.failed += 1;
            }
            return summary;
        },
        { seen: 0, compressed: 0, skipped: 0, failed: 0, bytesSaved: 0 },
    );
}

export function updateUi(
    ctx: ExtensionContext | null,
    snapshot: CompressionSnapshot,
    engine: string,
    health: HealthState,
    widget: WidgetHandle | null,
    setWidgetText: (text: string) => void,
    showStatus: boolean,
    showWidget: boolean,
    event?: CompressionObservation,
): void {
    if (!ctx?.hasUI) return;
    const colors = createUiColors(ctx.ui.theme);

    if (showStatus) {
        ctx.ui.setStatus(
            STATUS_ID,
            renderCompressionStatusText(snapshot, health, colors),
        );
    } else {
        ctx.ui.setStatus(STATUS_ID, "");
    }

    if (showWidget) {
        const widgetText = renderCompressionWidgetText(
            snapshot,
            engine,
            health,
            colors,
            event,
        );
        setWidgetText(widgetText);
        widget?.update(ctx, widgetText);
    }
}

export function formatCompressionNotificationSummary(
    scope: "turn" | "agent",
    events: CompressionObservation[],
): { message: string; type: "info" | "warning" } {
    const summary = summarizeCompressionEvents(events);
    const parts = [`ok ${summary.compressed}/${summary.seen}`];
    if (summary.bytesSaved > 0)
        parts.push(`saved ${formatSavedBytes(summary.bytesSaved)}`);
    if (summary.skipped > 0 || summary.failed > 0)
        parts.push(`skipped ${summary.skipped}`);
    parts.push(`fail ${summary.failed}`);

    return {
        message: `${icon} compression ${scope}: ${parts.join(" • ")}`,
        type: summary.failed > 0 ? "warning" : "info",
    };
}

export function formatTurnNotification(events: CompressionObservation[]): {
    message: string;
    type: "info" | "warning";
} {
    return formatCompressionNotificationSummary("turn", events);
}
