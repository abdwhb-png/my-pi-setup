import { loadExtensionConfig } from "../config-loader.ts";
import type { ToolGroupsConfig } from "./types.ts";

/** Options for {@link loadToolGroupsConfig}. */
export interface LoadToolGroupsOptions {
    /** Override agent directory (for testing). */
    agentDir?: string;
    /** Exclude project settings and legacy files when false. */
    projectTrusted?: boolean;
    /** Reject malformed sources instead of silently dropping them. */
    strict?: boolean;
    /** Inject a pre-built SettingsManager (for testing). */
    _settingsManager?: import("../config-loader.ts").LoadConfigOptions<unknown>["_settingsManager"];
}

const DEFAULTS: ToolGroupsConfig = { groups: {} };

const GROUP_NAME_RE = /^[a-z][a-z0-9_-]*$/;

function normalize(raw: unknown, strict = false): Partial<ToolGroupsConfig> {
    // An absent settings key permits legacy fallback; a present malformed value does not.
    if (raw === undefined) return {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        if (strict) throw new Error("Invalid tool-groups: expected an object");
        return {};
    }
    const groupsVal = "groups" in raw ? raw.groups : undefined;
    if (
        !groupsVal ||
        typeof groupsVal !== "object" ||
        Array.isArray(groupsVal)
    ) {
        if (strict)
            throw new Error("Invalid tool-groups: groups must be an object");
        return {};
    }
    const groups: Record<string, string[]> = {};
    for (const [key, val] of Object.entries(groupsVal)) {
        if (!GROUP_NAME_RE.test(key)) {
            if (strict)
                throw new Error(
                    `Invalid tool-groups: invalid group name ${JSON.stringify(key)}`,
                );
            continue;
        }
        if (!Array.isArray(val) || val.length === 0) {
            if (strict)
                throw new Error(
                    `Invalid tool-groups: ${key} requires a nonempty member array`,
                );
            continue;
        }
        const members: string[] = [];
        for (const m of val) {
            if (typeof m !== "string" || m.trim().length === 0) {
                if (strict)
                    throw new Error(
                        `Invalid tool-groups: ${key} contains an invalid member`,
                    );
                continue;
            }
            const trimmed = m.trim();
            members.push(trimmed);
        }
        if (members.length > 0) {
            groups[key] = members;
        }
    }
    return { groups };
}

function mergeGroups(
    base: ToolGroupsConfig,
    overlay: Partial<ToolGroupsConfig>,
): ToolGroupsConfig {
    return {
        groups: { ...base.groups, ...overlay.groups },
    };
}

/**
 * Load tool-groups configuration.
 *
 * Sources (cascade per source: settings wins, legacy fallback):
 *   1. Settings key `toolGroups`
 *   2. Legacy file `tool-groups.json`
 *
 * Group names are validated against `/^[a-z][a-z0-9_-]*$/`.
 * Invalid group names and members are silently dropped unless strict is true.
 * Later group arrays fully replace same-named groups.
 */
export function loadToolGroupsConfig(
    cwd: string,
    options: LoadToolGroupsOptions = {},
): ToolGroupsConfig {
    return loadExtensionConfig(cwd, {
        defaults: DEFAULTS,
        normalize: (raw) => normalize(raw, options.strict),
        sources: [
            {
                settingsKey: "toolGroups",
                legacyFilename: "tool-groups.json",
            },
        ],
        merge: mergeGroups,
        agentDir: options.agentDir,
        projectTrusted: options.projectTrusted,
        strict: options.strict,
        _settingsManager: options._settingsManager,
    });
}
