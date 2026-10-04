/** Tool summary settings use config/tool-summary.json in global and trusted project scopes. */

import { loadExtensionConfig } from "../_shared/config-loader.ts";
import { DEFAULT_CONFIG, type ToolSummaryConfig } from "./types.ts";

/** Type guard: a plain object (not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalize raw JSON into a partial config, dropping invalid fields. */
export function normalizeConfig(raw: unknown): Partial<ToolSummaryConfig> {
    if (!isRecord(raw)) return {};

    const result: Partial<ToolSummaryConfig> = {};

    if (Array.isArray(raw.tools)) {
        result.tools = raw.tools.filter(
            (t): t is string => typeof t === "string" && t.length > 0,
        );
    }

    return result;
}

/** Deep-merge configs (tools union, overlay wins on duplicates). */
export function mergeConfig(
    base: ToolSummaryConfig,
    overlay: Partial<ToolSummaryConfig>,
): ToolSummaryConfig {
    if (overlay.tools && overlay.tools.length > 0) {
        // overlay replaces the entire tools list (not additive)
        return { tools: overlay.tools };
    }
    return base;
}

/** Load and merge the tool-summary config from all configured sources. */
export function loadToolSummaryConfig(
    cwd: string,
    agentDir?: string,
    projectTrusted?: boolean,
): ToolSummaryConfig {
    return loadExtensionConfig<ToolSummaryConfig>(cwd, {
        defaults: DEFAULT_CONFIG,
        normalize: normalizeConfig,
        merge: mergeConfig,
        owner: "toolSummary",
        agentDir,
        projectTrusted,
    });
}
