import { loadExtensionConfig } from '../config-loader.ts';
import type { ToolGroupsConfig } from './types.ts';

/** Options for {@link loadToolGroupsConfig}. */
export interface LoadToolGroupsOptions {
    /** Override agent directory (for testing). */
    agentDir?: string;
    /** Inject a pre-built SettingsManager (for testing). */
    _settingsManager?: import('../config-loader.ts').LoadConfigOptions<unknown>['_settingsManager'];
}

const DEFAULTS: ToolGroupsConfig = { groups: {} };

const GROUP_NAME_RE = /^[a-z][a-z0-9_-]*$/;

function normalize(raw: unknown): Partial<ToolGroupsConfig> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
    }
    const obj = raw as Record<string, unknown>;
    const groupsVal = obj.groups;
    if (
        !groupsVal ||
        typeof groupsVal !== 'object' ||
        Array.isArray(groupsVal)
    ) {
        return {};
    }
    const groups: Record<string, string[]> = {};
    for (const [key, val] of Object.entries(
        groupsVal as Record<string, unknown>,
    )) {
        if (!GROUP_NAME_RE.test(key)) continue;
        if (!Array.isArray(val)) continue;
        const members: string[] = [];
        for (const m of val) {
            if (typeof m !== 'string') continue;
            const trimmed = m.trim();
            if (trimmed.length === 0) continue;
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
 * Invalid group names and members are silently dropped.
 * Later group arrays fully replace same-named groups.
 */
export function loadToolGroupsConfig(
    cwd: string,
    options: LoadToolGroupsOptions = {},
): ToolGroupsConfig {
    return loadExtensionConfig(cwd, {
        defaults: DEFAULTS,
        normalize,
        sources: [
            {
                settingsKey: 'toolGroups',
                legacyFilename: 'tool-groups.json',
            },
        ],
        merge: mergeGroups,
        agentDir: options.agentDir,
        _settingsManager: options._settingsManager,
    });
}
