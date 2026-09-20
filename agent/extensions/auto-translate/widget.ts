/**
 * Status widget for the auto-translate extension.
 *
 * Wraps the shared `_shared/fancy-footer.ts` `createWidget()` helper so the
 * status is rendered via pi-fancy-footer when available, with an automatic
 * fallback to `ctx.ui.setWidget` otherwise.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    createWidget as createFancyWidget,
    type WidgetHandle,
} from "../_shared/fancy-footer.ts";

export const WIDGET_ID = "auto-translate";
export const WIDGET_LABEL = "Auto-Translate";

/**
 * Register the translate status widget.
 *
 * `getStatus` and `isVisible` are called lazily on each render so the widget
 * always reflects the current runtime state — pass closures reading live state.
 * While `isVisible()` is false the widget renders nothing, which hides it both
 * in pi-fancy-footer and in the `ctx.ui.setWidget` fallback.
 */
export function createTranslateWidget(
    pi: ExtensionAPI,
    getStatus: () => string,
    isVisible: () => boolean,
): WidgetHandle {
    return createFancyWidget(pi, {
        id: WIDGET_ID,
        label: WIDGET_LABEL,
        description:
            "Shows the active translation target and send/display mode; hidden while translation is off.",
        row: 0,
        order: 64,
        align: "right",
        visible: () => isVisible(),
        render: () => (isVisible() ? getStatus() : ""),
    });
}
