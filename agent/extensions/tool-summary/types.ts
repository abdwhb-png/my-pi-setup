/**
 * Type definitions for the tool-summary extension.
 */

/** Configuration loaded via _shared/config-loader. */
export interface ToolSummaryConfig {
    /**
     * Allowlist of tool names to display in the summary.
     * Empty array (default) = show all tools.
     */
    tools: string[];
}

/** Resolved tool usage counts for a single turn. */
export interface ToolCounts {
    /** toolName -> total call count (including errors). */
    total: Record<string, number>;
    /** toolName -> error call count. */
    errors: Record<string, number>;
}

/** Default config when no source provides a value. */
export const DEFAULT_CONFIG: ToolSummaryConfig = {
    tools: [],
};

/** Extension state key in settings.json. */
export const SETTINGS_KEY = 'toolSummary';
