/**
 * Tool Summary Extension
 *
 * Shows a compact tool-usage summary when the agent ends, via ctx.ui.notify().
 * Extracts tool results directly from AgentEndEvent.messages — no accumulation needed.
 *
 * Example output: 🔧 read(3) grep(1) bash✗(2)
 *
 * Configurable via settings.json key "toolSummary" and /tool-summary command.
 * When tools[] is empty (default), all tools used are shown.
 * When tools[] has entries, only those tools are displayed.
 */

import type { ToolResultMessage } from '@earendil-works/pi-ai';
import type {
    ExtensionAPI,
    ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { TOOL_SUMMARY_EVENT } from '../_shared/agent-run-summary.ts';
import { createUiColors } from '../_shared/ui-colors.ts';
import { ToolFilter, handleToolSummaryCommand } from './commands.ts';
import { loadToolSummaryConfig } from './config.ts';
import { countToolUsage, formatSummary } from './summary.ts';

const ICON = '🔧';

/** Check for RPC mode — skip TUI-only extension. */
function isRPCMode(): boolean {
    return process.argv.includes('--mode') && process.argv.includes('rpc');
}

export default function (pi: ExtensionAPI) {
    if (isRPCMode()) return;

    const filter = new ToolFilter();
    let toolResults: ToolResultMessage[] = [];

    pi.on('session_start', async (_event, ctx) => {
        const config = loadToolSummaryConfig(ctx.cwd);
        filter.reset();
        if (config.tools.length > 0) {
            filter.add(...config.tools);
        }
    });

    pi.on('agent_start', async () => {
        toolResults = [];
    });

    pi.on('tool_result', async (event: ToolResultEvent) => {
        toolResults.push({
            role: 'toolResult',
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            content: event.content,
            details: event.details,
            isError: event.isError,
            timestamp: Date.now(),
        });
    });

    pi.on('agent_end', async (_event, ctx) => {
        if (!ctx.hasUI) return;

        const colors = createUiColors(ctx.ui.theme);
        const counts = countToolUsage(toolResults);
        const effectiveFilter = filter.getFilterArray();
        const summary = formatSummary(counts, effectiveFilter, colors);

        if (summary) {
            pi.events.emit(TOOL_SUMMARY_EVENT, {
                prefix: 'TOOLS',
                text: `${colors.primary(ICON)} ${summary}`,
            });
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
