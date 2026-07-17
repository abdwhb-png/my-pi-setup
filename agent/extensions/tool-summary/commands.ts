/**
 * /tool-summary command handler.
 *
 * Subcommands:
 *   list           — show current tool filter
 *   add <names...> — add tools to allowlist
 *   remove <names...> — remove tools from allowlist
 *   reset          — clear filter (show all tools)
 */

import type {
    ExtensionContext,
    ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import type { UiColorsCreation } from '../_shared/ui-colors.ts';

/** Runtime mutable filter state (session-only). */
export class ToolFilter {
    /** null = show all. string[] = only show these tools. */
    private tools: string[] | null = null;

    /** Get currently filtered tools (null means show all). */
    getFilter(): string[] | null {
        return this.tools;
    }

    /** Get the effective filter as an array (empty = show all). */
    getFilterArray(): string[] {
        return this.tools ?? [];
    }

    add(...names: string[]): void {
        if (this.tools === null) {
            this.tools = [];
        }
        for (const name of names) {
            if (!this.tools.includes(name)) {
                this.tools.push(name);
            }
        }
    }

    remove(...names: string[]): void {
        if (this.tools === null) return;
        this.tools = this.tools.filter((t) => !names.includes(t));
        if (this.tools.length === 0) {
            this.tools = null; // reset to "show all"
        }
    }

    reset(): void {
        this.tools = null;
    }
}

/** Format a filter state for display in notifications. */
export function formatFilterState(
    filter: ToolFilter,
    colors: UiColorsCreation,
): string {
    const tools = filter.getFilter();
    if (tools === null || tools.length === 0) {
        return colors.success('All tools');
    }
    return colors.primary(tools.join(', '));
}

/**
 * Handle /tool-summary command.
 *
 * @param args - command arguments string
 * @param ctx - extension command context
 * @param filter - mutable filter state
 * @param colors - UI colors for formatting
 */
export async function handleToolSummaryCommand(
    args: string,
    ctx: ExtensionContext | ExtensionCommandContext,
    filter: ToolFilter,
    colors: UiColorsCreation,
): Promise<void> {
    const parts = args.trim().split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() ?? '';
    const rest = parts.slice(1);

    switch (subcommand) {
        case 'list':
        case '': {
            const current = formatFilterState(filter, colors);
            ctx.ui.notify(`Tool summary filter: ${current}`, 'info');
            break;
        }
        case 'add': {
            if (rest.length === 0) {
                ctx.ui.notify(
                    'Usage: /tool-summary add <tool names...>',
                    'error',
                );
                return;
            }
            filter.add(...rest);
            ctx.ui.notify(
                `Tool summary filter: ${formatFilterState(filter, colors)}`,
                'info',
            );
            break;
        }
        case 'remove': {
            if (rest.length === 0) {
                ctx.ui.notify(
                    'Usage: /tool-summary remove <tool names...>',
                    'error',
                );
                return;
            }
            filter.remove(...rest);
            ctx.ui.notify(
                `Tool summary filter: ${formatFilterState(filter, colors)}`,
                'info',
            );
            break;
        }
        case 'reset': {
            filter.reset();
            ctx.ui.notify(
                'Tool summary filter reset - showing all tools',
                'info',
            );
            break;
        }
        default: {
            ctx.ui.notify(
                `Unknown subcommand: ${subcommand}. Use list, add, remove, or reset.`,
                'error',
            );
        }
    }
}
