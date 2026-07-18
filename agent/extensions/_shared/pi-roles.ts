// Bridge to pi-roles/api. Consumers import from this bridge instead of
// depending on pi-roles subpaths directly. If pi-roles changes its public
// entry points, only this file needs updating.
export {
    ACTIVE_ROLE_ENTRY_TYPE,
    ROLE_SWITCH_PROCESSED_TYPE,
    ROLE_SWITCH_REQUEST_ENTRY_TYPE,
    findLatestActiveRoleState,
    findUnprocessedSwitchRequest,
    writeActiveRoleState,
    writeRoleSwitchRequest,
    type ActiveRoleState,
    type RoleSwitchRequest,
    type SwitchProcessedPayload,
} from 'pi-roles/api';

import { readFileSync } from 'node:fs';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { findLatestActiveRoleState, type ActiveRoleState } from 'pi-roles/api';
import { getSettingsValue, type GetSettingsOptions } from './settings';

// ── Shared helpers for pi-roles addons ──

/** Resolve the configured pi-roles default through one shared fallback. */
export function getDefaultRole(options?: GetSettingsOptions): string {
    return getSettingsValue('pi-roles.defaultRole', 'pi-agent', options);
}

/**
 * Read a file and parse its YAML frontmatter.
 * Returns null on any error (missing file, unreadable, malformed, no frontmatter).
 */
export function readFrontmatter<
    T extends Record<string, unknown> = Record<string, unknown>,
>(path: string): T | null {
    try {
        const raw = readFileSync(path, 'utf-8');
        const { frontmatter } = parseFrontmatter<T>(raw);
        return frontmatter;
    } catch {
        return null;
    }
}

/**
 * Find the currently active role from session entries.
 * Returns null if no role is active.
 */
export function getActiveRole(
    entries: ReadonlyArray<{
        type: string;
        customType?: string;
        data?: unknown;
    }>,
): ActiveRoleState | null {
    return findLatestActiveRoleState(entries);
}

/**
 * Parse a comma-separated string into a trimmed, non-empty string array.
 * "a, b, c" → ["a", "b", "c"]
 * undefined or "" → []
 */
export function parseCommaList(raw: string | undefined): string[] {
    if (!raw || !raw.trim()) return [];
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}
