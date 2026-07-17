/**
 * Status widget for the tool-summary extension.
 *
 * Wraps the shared `_shared/fancy-footer.ts` `createWidget()` helper so the
 * summary is rendered via pi-fancy-footer when available, with an automatic
 * fallback to `ctx.ui.setWidget` otherwise.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
    createWidget as createFancyWidget,
    type WidgetHandle,
} from '../_shared/fancy-footer.ts';

export const WIDGET_ID = 'tool-summary';

/** pi-fancy-footer row and order constants. */
const WIDGET_ROW = 0;
const WIDGET_ORDER = 65; // After auto-translate at 64

/**
 * Register the tool-summary widget.
 *
 * `getSummary` is called lazily on each render so the widget always
 * reflects the current turn's tool counts.
 */
export function createSummaryWidget(
    pi: ExtensionAPI,
    getSummary: () => string,
): WidgetHandle {
    return createFancyWidget(pi, {
        id: WIDGET_ID,
        label: 'Tool Summary',
        description: 'Shows tool call counts for the current turn.',
        row: WIDGET_ROW,
        order: WIDGET_ORDER,
        align: 'right',
        render: () => {
            const text = getSummary();
            return text || undefined;
        },
    });
}
