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

/**
 * Register the translate status widget.
 *
 * `getStatus` is called lazily on each render so the widget always reflects the
 * current runtime state — pass it as a closure reading live state.
 */
export function createTranslateWidget(
    pi: ExtensionAPI,
    getStatus: () => string,
): WidgetHandle {
    return createFancyWidget(pi, {
        id: WIDGET_ID,
        label: "Auto-Translate",
        description: "Shows translation target, on/off, and send/display mode.",
        row: 0,
        order: 64,
        align: "right",
        render: () => getStatus(),
    });
}
