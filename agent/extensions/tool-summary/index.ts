/**
 * Tool Summary Extension
 *
 * Shows a compact tool-usage summary in the TUI footer after each agent turn.
 *
 * Hooks into `turn_end`, counts tool calls from `event.toolResults`,
 * and renders a compact bar like `read(3) grep(1) bash✗(2)`.
 *
 * Configurable via settings.json key "toolSummary" and /tool-summary command.
 * When tools[] is empty (default), all tools used are shown.
 * When tools[] has entries, only those tools are displayed.
 */

import type {
    ExtensionAPI,
    ExtensionContext,
    TurnEndEvent,
} from '@earendil-works/pi-coding-agent';
import type { WidgetHandle } from '../_shared/fancy-footer.ts';
import { createUiColors } from '../_shared/ui-colors.ts';
import { ToolFilter, handleToolSummaryCommand } from './commands.ts';
import { countToolUsage, formatSummary } from './summary.ts';
import { createSummaryWidget } from './widget.ts';

/** Check for RPC mode — skip TUI-only extension. */
function isRPCMode(): boolean {
    return process.argv.includes('--mode') && process.argv.includes('rpc');
}

export default function (pi: ExtensionAPI) {
    if (isRPCMode()) return;

    // Session state (rebuilt each session)
    let widget: WidgetHandle | null = null;
    let filter = new ToolFilter();
    let latestSummary = '';

    /**
     * Refresh the TUI widget with the current tool summary.
     */
    function refreshWidget(ctx: ExtensionContext): void {
        if (!ctx.hasUI) return;
        if (!widget) return;

        widget.update(ctx, latestSummary || null);
    }

    // ── Session lifecycles ───────────────────────────────────────

    pi.on('session_start', async (_event, _ctx) => {
        filter = new ToolFilter();
        latestSummary = '';

        widget = createSummaryWidget(pi, () => latestSummary);
    });

    pi.on('session_shutdown', async () => {
        if (widget) {
            widget = null;
        }
    });

    // ── Turn end: compute and display summary ─────────────────────

    pi.on('turn_end', async (event: TurnEndEvent, ctx) => {
        if (!ctx.hasUI) return;

        const colors = createUiColors(ctx.ui.theme);
        const counts = countToolUsage(event.toolResults);

        const effectiveFilter = filter.getFilterArray();
        latestSummary = formatSummary(counts, effectiveFilter, colors);

        refreshWidget(ctx);
    });

    // ── /tool-summary command ─────────────────────────────────────

    pi.registerCommand('tool-summary', {
        description:
            'Manage tool summary filter. Subcommands: list, add <tools...>, remove <tools...>, reset',
        handler: async (args, ctx) => {
            const colors = createUiColors(ctx.ui.theme);
            await handleToolSummaryCommand(args, ctx, filter, colors);
            // Update widget after filter change to reflect new filter immediately
            // (even though there are no new tool counts yet)
            refreshWidget(ctx);
        },
    });
}
