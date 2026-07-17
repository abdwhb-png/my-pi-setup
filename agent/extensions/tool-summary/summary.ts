/**
 * Core logic for tool-summary: counting and formatting tool usage.
 */

import type { ToolResultMessage } from '@earendil-works/pi-ai';
import type { UiColorsCreation } from '../_shared/ui-colors.ts';
import type { ToolCounts } from './types.ts';

/**
 * Count tool usage from turn-end tool results.
 * Groups by toolName, counting total calls and errors.
 */
export function countToolUsage(results: ToolResultMessage[]): ToolCounts {
    const total: Record<string, number> = {};
    const errors: Record<string, number> = {};

    for (const r of results) {
        total[r.toolName] = (total[r.toolName] ?? 0) + 1;
        if (r.isError) {
            errors[r.toolName] = (errors[r.toolName] ?? 0) + 1;
        }
    }

    return { total, errors };
}

/**
 * Format tool counts into a compact single-line summary.
 *
 * @param counts - from countToolUsage()
 * @param filteredTools - allowlist (empty = show all tools)
 * @param colors - from createUiColors()
 * @returns compact bar like "read(3) grep(1) bash✗(2)" or "" if no tools
 */
export function formatSummary(
    counts: ToolCounts,
    filteredTools: string[],
    colors: UiColorsCreation,
): string {
    const toolNames = Object.keys(counts.total);

    if (toolNames.length === 0) return '';

    // Determine which tools to show
    const showAll = filteredTools.length === 0;
    const visibleTools = showAll
        ? toolNames
        : toolNames.filter((t) => filteredTools.includes(t));

    if (visibleTools.length === 0) return '';

    const parts = visibleTools.map((name) => {
        const totalCount = counts.total[name] ?? 0;
        const errorCount = counts.errors[name] ?? 0;
        const hasErrors = errorCount > 0;

        const countStr = hasErrors
            ? name + colors.danger('✗') + '(' + totalCount + ')'
            : name + '(' + totalCount + ')';

        return countStr;
    });

    return parts.join(' ');
}
