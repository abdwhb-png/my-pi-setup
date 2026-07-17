/**
 * Tool Summary Extension
 *
 * Shows a compact tool-usage summary after each agent turn via ctx.ui.notify().
 *
 * Hooks into `turn_end`, counts tool calls from `event.toolResults`,
 * and shows a compact bar like `read(3) grep(1) bash✗(2)`.
 *
 * Configurable via settings.json key "toolSummary" and /tool-summary command.
 * When tools[] is empty (default), all tools used are shown.
 * When tools[] has entries, only those tools are displayed.
 */

import type {
    ExtensionAPI,
    TurnEndEvent,
} from '@earendil-works/pi-coding-agent';
import { createUiColors } from '../_shared/ui-colors.ts';
import { ToolFilter, handleToolSummaryCommand } from './commands.ts';
import { countToolUsage, formatSummary } from './summary.ts';

/** Check for RPC mode — skip TUI-only extension. */
function isRPCMode(): boolean {
    return process.argv.includes('--mode') && process.argv.includes('rpc');
}

export default function (pi: ExtensionAPI) {
    if (isRPCMode()) return;

    let filter = new ToolFilter();

    pi.on('turn_end', async (event: TurnEndEvent, ctx) => {
        if (!ctx.hasUI) return;

        const colors = createUiColors(ctx.ui.theme);
        const counts = countToolUsage(event.toolResults);
        const effectiveFilter = filter.getFilterArray();
        const summary = formatSummary(counts, effectiveFilter, colors);

        if (summary) {
            ctx.ui.notify(summary, 'info');
        }
    });

    pi.registerCommand('tool-summary', {
        description:
            'Manage tool summary filter. Subcommands: list, add <tools...>, remove <tools...>, reset',
        handler: async (args, ctx) => {
            const colors = createUiColors(ctx.ui.theme);
            await handleToolSummaryCommand(args, ctx, filter, colors);
        },
    });
}
