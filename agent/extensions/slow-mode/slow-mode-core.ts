/**
 * Pure helpers for the slow-mode extension.
 *
 * All functions are pure (or take explicit dependencies) making them
 * fully testable without mocking the pi API, the filesystem, or shells.
 * Mirrors the pattern established by `extensions/diff/core.ts`.
 */

import { relative, resolve } from 'node:path';
import type { SettingsManager } from '@earendil-works/pi-coding-agent';
import { loadExtensionConfig } from '../_shared/config-loader.ts';
import { normalizeBooleanMap } from '../_shared/settings.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Edit operation in a diff: keep, insert, or delete a line.
 */
export type Edit =
    | { type: 'keep'; line: string }
    | { type: 'insert'; line: string }
    | { type: 'delete'; line: string };

/**
 * A hunk in a unified diff.
 */
export interface Hunk {
    oldStart: number; // 1-based start line in old file
    oldCount: number; // number of old-file lines in hunk
    newStart: number; // 1-based start line in new file
    newCount: number; // number of new-file lines in hunk
    lines: string[]; // prefixed lines (" ", "+", "-")
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a file path to be relative to cwd.
 * Normalizes absolute/relative paths for consistent staging.
 */
export function resolvePath(cwd: string, filePath: string): string {
    return relative(cwd, resolve(cwd, filePath));
}

// ---------------------------------------------------------------------------
// Myers diff algorithm
// ---------------------------------------------------------------------------

/**
 * Myers diff algorithm (linear-space variant).
 *
 * Computes the shortest edit script (SES) between two arrays of lines.
 * Time: O((N+M)D) where D is the edit distance.
 * Space: O((N+M)D) for the trace (acceptable for code diffs).
 *
 * Reference: Eugene W. Myers, "An O(ND) Difference Algorithm and Its
 * Variations", Algorithmica 1(2), 1986.
 */
export function myersDiff(oldLines: string[], newLines: string[]): Edit[] {
    const n = oldLines.length;
    const m = newLines.length;
    const max = n + m;

    // V[k] = furthest x-position reached on diagonal k
    // Diagonals range from -max..+max, offset by max for array indexing
    const size = 2 * max + 1;
    const v = new Int32Array(size);
    v[max + 1] = 0;

    // Store each V snapshot to reconstruct the path
    const trace: Int32Array[] = [];

    outer: for (let d = 0; d <= max; d++) {
        // Save current state before modification
        trace.push(v.slice());

        for (let k = -d; k <= d; k += 2) {
            const kIdx = k + max;

            // Decide whether to move down (insert) or right (delete)
            let x: number;
            if (k === -d || (k !== d && v[kIdx - 1] < v[kIdx + 1])) {
                x = v[kIdx + 1]; // move down: take x from diagonal k+1
            } else {
                x = v[kIdx - 1] + 1; // move right: take x from diagonal k-1 and advance
            }
            let y = x - k;

            // Follow the diagonal (matching lines)
            while (x < n && y < m && oldLines[x] === newLines[y]) {
                x++;
                y++;
            }

            v[kIdx] = x;

            // Reached the end of both sequences
            if (x >= n && y >= m) {
                break outer;
            }
        }
    }

    // Backtrack through the trace to reconstruct the edit script
    const edits: Edit[] = [];
    let x = n;
    let y = m;

    for (let d = trace.length - 1; d >= 0; d--) {
        const prev = trace[d];
        const k = x - y;
        const kIdx = k + max;

        // Determine which diagonal we came from
        let prevK: number;
        if (k === -d || (k !== d && prev[kIdx - 1] < prev[kIdx + 1])) {
            prevK = k + 1; // came from above (insert)
        } else {
            prevK = k - 1; // came from left (delete)
        }

        const prevX = prev[prevK + max];
        const prevY = prevX - prevK;

        // Diagonal moves (matching lines) — emit keeps in reverse
        while (x > prevX && y > prevY) {
            x--;
            y--;
            edits.push({ type: 'keep', line: oldLines[x] });
        }

        if (d > 0) {
            if (x === prevX) {
                // Vertical move: insert from new
                y--;
                edits.push({ type: 'insert', line: newLines[y] });
            } else {
                // Horizontal move: delete from old
                x--;
                edits.push({ type: 'delete', line: oldLines[x] });
            }
        }
    }

    edits.reverse();
    return edits;
}

// ---------------------------------------------------------------------------
// Hunk building
// ---------------------------------------------------------------------------

/**
 * Group edit operations into unified diff hunks with context lines.
 *
 * Adjacent changes within (2 * contextLines) of each other are merged
 * into a single hunk, matching standard unified diff behavior.
 */
export function buildHunks(edits: Edit[], contextLines: number): Hunk[] {
    if (edits.length === 0) return [];

    // Find indices of all change operations (insert or delete)
    const changeIndices: number[] = [];
    for (let i = 0; i < edits.length; i++) {
        if (edits[i].type !== 'keep') {
            changeIndices.push(i);
        }
    }

    if (changeIndices.length === 0) return [];

    // Group changes that are close enough to share context
    const groups: { start: number; end: number }[] = [];
    let groupStart = changeIndices[0];
    let groupEnd = changeIndices[0];

    for (let i = 1; i < changeIndices.length; i++) {
        // If gap between changes is <= 2*contextLines, merge into same group
        if (changeIndices[i] - groupEnd <= 2 * contextLines) {
            groupEnd = changeIndices[i];
        } else {
            groups.push({ start: groupStart, end: groupEnd });
            groupStart = changeIndices[i];
            groupEnd = changeIndices[i];
        }
    }
    groups.push({ start: groupStart, end: groupEnd });

    // Convert groups into hunks
    const hunks: Hunk[] = [];

    for (const group of groups) {
        // Expand to include context lines
        const hunkStart = Math.max(0, group.start - contextLines);
        const hunkEnd = Math.min(edits.length - 1, group.end + contextLines);

        const lines: string[] = [];
        let oldCount = 0;
        let newCount = 0;

        // Compute 1-based starting line numbers
        let oldLine = 1;
        let newLine = 1;
        for (let i = 0; i < hunkStart; i++) {
            if (edits[i].type === 'keep' || edits[i].type === 'delete')
                oldLine++;
            if (edits[i].type === 'keep' || edits[i].type === 'insert')
                newLine++;
        }

        for (let i = hunkStart; i <= hunkEnd; i++) {
            const edit = edits[i];
            switch (edit.type) {
                case 'keep':
                    lines.push(` ${edit.line}`);
                    oldCount++;
                    newCount++;
                    break;
                case 'delete':
                    lines.push(`-${edit.line}`);
                    oldCount++;
                    break;
                case 'insert':
                    lines.push(`+${edit.line}`);
                    newCount++;
                    break;
            }
        }

        hunks.push({
            oldStart: oldLine,
            oldCount,
            newStart: newLine,
            newCount,
            lines,
        });
    }

    return hunks;
}

// ---------------------------------------------------------------------------
// Unified diff generation
// ---------------------------------------------------------------------------

/**
 * Generate a unified diff using the Myers diff algorithm.
 *
 * Produces output equivalent to `diff -u` / `git diff`.
 *
 * @param filePath - Relative file path (used in --- / +++ headers)
 * @param oldText - Original text
 * @param newText - Modified text
 * @param contextLines - Number of context lines around changes (default: 3)
 * @returns Unified diff string
 */
export function generateUnifiedDiff(
    filePath: string,
    oldText: string,
    newText: string,
    contextLines = 3,
): string {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const edits = myersDiff(oldLines, newLines);
    const hunks = buildHunks(edits, contextLines);

    const out: string[] = [];
    out.push(`--- a/${filePath}`);
    out.push(`+++ b/${filePath}`);

    for (const hunk of hunks) {
        out.push(
            `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
        );
        for (const line of hunk.lines) {
            out.push(line);
        }
    }

    return out.join('\n');
}

// ---------------------------------------------------------------------------
// Multi-edit application (M2 fix)
// ---------------------------------------------------------------------------

/**
 * A single edit operation as provided by the pi `edit` tool.
 */
export interface EditPatch {
    oldText: string;
    newText: string;
}

/**
 * Apply a list of edits sequentially to original content, producing the
 * patched content. Uses simple string replacement (first match) — the
 * same semantics as pi's built-in edit tool.
 *
 * If `edits` is empty, returns the original content unchanged.
 * If an edit's oldText is not found, it is skipped (the edit is a no-op),
 * matching pi's lenient edit behavior.
 *
 * @param originalContent - The full original file content
 * @param edits - Array of { oldText, newText } patches to apply in order
 * @returns The patched content after all edits are applied
 */
export function applyEdits(
    originalContent: string,
    edits: EditPatch[],
): string {
    let result = originalContent;
    for (const edit of edits) {
        if (edit.oldText.length === 0) continue;
        result = result.replace(edit.oldText, edit.newText);
    }
    return result;
}

/**
 * Extract old/new text from an edit tool input, supporting both the
 * modern `edits[]` array format and the legacy single `oldText`/`newText`
 * top-level fields.
 *
 * For multi-edit arrays, returns the concatenation of all patches (joined
 * with newlines) — used as a fallback when the actual file cannot be read.
 *
 * @returns { oldText, newText } or null if the input is malformed
 */
export function extractEditText(
    input: Record<string, unknown>,
): { oldText: string; newText: string } | null {
    const edits = input.edits as EditPatch[] | undefined;

    if (edits && Array.isArray(edits) && edits.length > 0) {
        return {
            oldText: edits.map((e) => e.oldText).join('\n'),
            newText: edits.map((e) => e.newText).join('\n'),
        };
    }

    // Legacy single oldText/newText
    const oldText = input.oldText as string | undefined;
    const newText = input.newText as string | undefined;
    if (oldText == null || newText == null) return null;
    return { oldText, newText };
}

/**
 * Extract the list of edit patches from an edit tool input.
 * Returns null if no valid edits are present.
 */
export function extractEditPatches(
    input: Record<string, unknown>,
): EditPatch[] | null {
    const edits = input.edits as EditPatch[] | undefined;
    if (edits && Array.isArray(edits) && edits.length > 0) {
        return edits;
    }
    // Legacy single edit
    const oldText = input.oldText as string | undefined;
    const newText = input.newText as string | undefined;
    if (oldText == null || newText == null) return null;
    return [{ oldText, newText }];
}

/**
 * Compute the auto-accept key for a tool call.
 *
 * - bash / safe_bash: the exact command string
 * - write / edit: the file path
 * - anything else: null (auto-accept not supported)
 *
 * Returns null when the identifying field is missing, so callers can treat
 * a null key as "do not auto-accept".
 */
export function autoAcceptKey(
    toolName: string,
    params: Record<string, unknown>,
): string | null {
    if (toolName === 'bash' || toolName === 'safe_bash') {
        const command = params.command;
        return typeof command === 'string' ? command : null;
    }
    if (toolName === 'write' || toolName === 'edit') {
        const path = params.path;
        return typeof path === 'string' ? path : null;
    }
    // Generic: serialize params as key so auto-accept works per-param-set
    return JSON.stringify(params);
}

// ---- Slow Mode Config ----

/** Map of tool name to whether slow mode should apply. */
export type SlowModeConfig = Record<string, boolean>;

/**
 * Result of validating a slow-mode config against active tools.
 */
export interface SlowModeConfigResult {
    /** Only tools that exist in the current active set. */
    tools: Map<string, boolean>;
    /** Human-readable warnings about non-existent tools in the config. */
    warnings: string[];
}

/**
 * Load slow-mode config from a JSON file.
 *
 * Expected format: `{ "toolName": true/false, ... }`
 *
 * Non-boolean values are silently filtered out. Malformed
 * or missing files return an empty object (no config = no slow mode).
 *
/**
 * Load slow-mode config.
 *
 * Reads the `slowMode` key from settings.json (global + project) via the
 * shared config-loader, with a cascade fallback to the legacy standalone
 * `slow-mode.json` file when the key is absent. Project settings override
 * global. Non-boolean values are silently filtered out.
 *
 * @param cwd - Working directory (defaults to process.cwd())
 * @param agentDir - Agent directory override (for testing)
 * @param _settingsManager - Injected SettingsManager (for testing)
 * @returns Parsed config (empty object on any error)
 */
/** Default slow-mode config: core editing + shell tools reviewed by default.
 *
 * Under the opt-in regime (config === true required for review), these defaults
 * preserve the historical UX where write/edit/bash are reviewed out of the box.
 * Both `bash` and `safe_bash` are included for robustness across safe-bash
 * `replace`/`coexist` modes — `validateSlowModeConfig` drops whichever is not
 * in the active tool set.
 */
export const DEFAULT_SLOW_MODE_CONFIG: SlowModeConfig = {
    write: true,
    edit: true,
    bash: true,
    safe_bash: true,
};

export function loadSlowModeConfig(
    cwd: string = process.cwd(),
    agentDir?: string,
    _settingsManager?: SettingsManager,
): SlowModeConfig {
    return loadExtensionConfig<SlowModeConfig>(cwd, {
        defaults: DEFAULT_SLOW_MODE_CONFIG,
        normalize: normalizeBooleanMap,
        sources: [
            {
                settingsKey: 'slowMode',
                legacyFilename: 'slow-mode.json',
                cumulative: true,
            },
        ],
        agentDir,
        _settingsManager,
    });
}

/**
 * Validate a slow-mode config against the current active tools.
 *
 * Returns only tools that exist in `activeTools`. Adds warnings for
 * any config entries that reference non-existent tools.
 *
 * @param config - The raw config from loadSlowModeConfig()
 * @param activeTools - Current active tool names from pi.getActiveTools()
 * @returns Filtered config and warnings
 */
export function validateSlowModeConfig(
    config: SlowModeConfig,
    activeTools: string[],
): SlowModeConfigResult {
    const activeSet = new Set(activeTools);
    const tools = new Map<string, boolean>();
    const warnings: string[] = [];

    for (const [toolName, enabled] of Object.entries(config)) {
        if (!activeSet.has(toolName)) {
            warnings.push(
                `Tool "${toolName}" in slow-mode config does not exist and will be ignored`,
            );
            continue;
        }
        tools.set(toolName, enabled);
    }

    return { tools, warnings };
}
