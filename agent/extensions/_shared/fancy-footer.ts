import type {
    ExtensionContext,
    ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { FancyFooterWidgetContribution } from "pi-fancy-footer/api";
import {
    contributeFancyFooterWidgets,
    requestFancyFooterWidgetDiscovery,
    requestFancyFooterRefresh,
} from "pi-fancy-footer/api";

// ── Bridge to pi-fancy-footer/api/metrics ────────────────────────────────
//
// Re-exported so consumers import from this bridge instead of depending
// on pi-fancy-footer/api/metrics directly. If the package changes the
// entry point, only this file needs updating.

export {
    collectSessionUsageMetrics as getSessionUsageMetrics,
    type SessionUsageMetrics,
    type UsageSnapshot,
} from "pi-fancy-footer/api/metrics";

// ── Extension status snapshot API ────────────────────────────────────────
//
// Re-exported so command-style extensions can read/observe extension statuses
// without clobbering pi-fancy-footer's footer. The snapshot is republished by
// the above-editor widget after every render.

export {
    getExtensionStatusesSnapshot as getFancyFooterExtensionStatusesSnapshot,
    subscribeExtensionStatusesSnapshot as subscribeFancyFooterExtensionStatuses,
    publishExtensionStatusesSnapshot,
    FANCY_FOOTER_EXTENSION_STATUSES_SNAPSHOT_EVENT,
    type FancyFooterExtensionStatusSnapshot,
    type FancyFooterExtensionStatusesListener,
} from "pi-fancy-footer/api";

export interface WidgetHandle {
    /** Whether fancy-footer is active. If false, use update(_, text) and remove() for fallback. */
    readonly active: boolean;
    /**
     * Refresh the widget display.
     * - fancy-footer mode: the render closure provides text automatically.
     * - fallback mode: pass the text to display, or null/undefined to hide.
     */
    update(ctx: ExtensionContext, fallbackText?: string | null): void;
    /** Hide/remove the widget (only needed in fallback mode). */
    remove(ctx: ExtensionContext): void;
}

/**
 * Register a fancy-footer widget with automatic fallback to pi's built-in widget API.
 *
 * Usage:
 *   const w = createWidget(pi, { id: "my.widget", render: () => text });
 *   w.update(ctx);         // fancy-footer refresh
 *   w.update(ctx, "text"); // fallback setWidget
 *   w.remove(ctx);         // fallback cleanup
 */
/** fancy-footer rejects order > 64 — clamp silently to avoid log noise. */
const MAX_ORDER = 64;

export function createWidget(
    pi: ExtensionAPI,
    def: FancyFooterWidgetContribution,
): WidgetHandle {
    const safeDef: FancyFooterWidgetContribution = {
        ...def,
        order:
            def.order !== undefined
                ? Math.min(def.order, MAX_ORDER)
                : undefined,
    };

    let isActive = false;

    try {
        contributeFancyFooterWidgets(pi, safeDef);
        requestFancyFooterWidgetDiscovery(pi);
        isActive = true;
    } catch {
        // pi-fancy-footer not installed — widget will use fallback path
    }

    return {
        get active() {
            return isActive;
        },

        update(ctx: ExtensionContext, fallbackText?: string | null): void {
            if (isActive) {
                try {
                    requestFancyFooterRefresh(pi);
                } catch {
                    // Ignore if extension runtime is stale or invalidated after session replacement/reload
                }
            } else if (ctx.hasUI) {
                try {
                    ctx.ui.setWidget(
                        def.id,
                        fallbackText ? [fallbackText] : undefined,
                    );
                } catch {
                    // Ignore if context is stale or invalidated
                }
            }
        },

        remove(ctx: ExtensionContext): void {
            if (!isActive && ctx.hasUI) {
                try {
                    ctx.ui.setWidget(def.id, undefined);
                } catch {
                    // Ignore if context is stale or invalidated
                }
            }
        },
    };
}
