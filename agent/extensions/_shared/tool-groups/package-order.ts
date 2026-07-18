import { resolve } from 'node:path';
import { getAgentDir, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { PackageSource } from '@earendil-works/pi-coding-agent';

/**
 * Canonical package source string for the tool-groups extension package.
 */
export const TOOL_GROUPS_PACKAGE_SOURCE = './extensions/tool-groups';

export interface PinPackageOrderResult {
    changed: boolean;
    found: boolean;
}

/**
 * Resolve a raw package source to an absolute path for comparison.
 * Relative paths (including those starting with ./) are resolved against agentDir.
 */
function resolvePackageSource(raw: string, agentDir: string): string {
    if (raw.startsWith('/')) {
        return resolve(raw);
    }
    const stripped = raw.replace(/^\.\//, '');
    return resolve(agentDir, stripped);
}

/**
 * Check whether a PackageSource entry refers to the tool-groups package.
 * Handles string form (`"./extensions/tool-groups"`) and object form
 * (`{ source: "...", extensions: [...] }`). Recognises equivalent paths:
 * `./extensions/tool-groups`, `extensions/tool-groups`, and absolute
 * `<agentDir>/extensions/tool-groups`.
 */
export function isToolGroupsEntry(
    entry: PackageSource,
    agentDir: string,
): boolean {
    const rawSource = typeof entry === 'string' ? entry : entry.source;
    const resolved = resolvePackageSource(rawSource, agentDir);
    const canonical = resolvePackageSource(
        TOOL_GROUPS_PACKAGE_SOURCE,
        agentDir,
    );
    return resolved === canonical;
}

/**
 * Check whether the tool-groups package is the last entry in the given
 * packages array.  Returns false when the array is empty or when the
 * tool-groups package is absent.
 */
export function isToolGroupsPackageLast(
    packages: PackageSource[],
    agentDir?: string,
): boolean {
    const dir = agentDir ?? getAgentDir();
    if (packages.length === 0) return false;
    return isToolGroupsEntry(packages[packages.length - 1], dir);
}

/**
 * Ensure the tool-groups package is pinned to the last position in the
 * settings packages list.
 *
 * - Reads packages via `SettingsManager.getPackages()`.
 * - If tool-groups is absent → no-op, `{ changed: false, found: false }`.
 * - If already last → no-op, `{ changed: false, found: true }`.
 * - Otherwise moves the exact original entry (string or object) to the end
 *   and writes via `SettingsManager.setPackages()`, then flushes.
 *
 * Idempotent: repeated calls after a successful pin return
 * `{ changed: false, found: true }`.
 */
export async function pinToolGroupsPackageLast(
    cwd: string,
    agentDir?: string,
    manager?: SettingsManager,
): Promise<PinPackageOrderResult> {
    const dir = agentDir ?? getAgentDir();
    const sm = manager ?? SettingsManager.create(cwd, dir);
    const packages = sm.getPackages().slice();

    const index = packages.findIndex((p) => isToolGroupsEntry(p, dir));

    if (index === -1) {
        return { changed: false, found: false };
    }

    if (index === packages.length - 1) {
        return { changed: false, found: true };
    }

    const [entry] = packages.splice(index, 1);
    packages.push(entry);

    sm.setPackages(packages);
    await sm.flush();

    return { changed: true, found: true };
}
