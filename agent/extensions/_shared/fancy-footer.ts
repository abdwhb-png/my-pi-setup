import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FancyFooterWidgetContribution } from "pi-fancy-footer/api";
import {
  contributeFancyFooterWidgets,
  requestFancyFooterWidgetDiscovery,
  requestFancyFooterRefresh,
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
    order: def.order !== undefined ? Math.min(def.order, MAX_ORDER) : undefined,
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
        requestFancyFooterRefresh(pi);
      } else if (ctx.hasUI) {
        ctx.ui.setWidget(def.id, fallbackText ? [fallbackText] : undefined);
      }
    },

    remove(ctx: ExtensionContext): void {
      if (!isActive && ctx.hasUI) {
        ctx.ui.setWidget(def.id, undefined);
      }
    },
  };
}

