import {
    TOOL_GROUP_PREFIX,
    fromToolGroupAlias,
    type ToolGroupDiagnostic,
    type ToolGroupDiagnosticCode,
    type ResolveToolAliasesResult,
} from './types.ts';

/**
 * Expand `*` / `?` glob pattern against a set of candidate names.
 * Skips names starting with `@` (group aliases).
 * Uses simple wildcard match: `*` matches any sequence, `?` matches any single char.
 */
function globMatch(pattern: string, candidates: string[]): string[] {
    const regexStr =
        '^' +
        pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.') +
        '$';
    const re = new RegExp(regexStr);
    return candidates.filter(
        (c) => !c.startsWith(TOOL_GROUP_PREFIX) && re.test(c),
    );
}

/** Check if a string is a glob pattern (contains * or ?). */
function isGlob(value: string): boolean {
    return value.includes('*') || value.includes('?');
}

/**
 * Resolve a list of active names (tool names, @group aliases, glob patterns)
 * against available tool names and group definitions.
 *
 * - Exact tool names pass through as-is.
 * - `@group` references expand to their member lists (depth-first).
 * - `*` / `?` globs match against `availableNames` (excluding @-prefixed aliases).
 * - Group members follow the same dispatch: @group, globs, or exact name validation.
 *
 * Resolution preserves first-occurrence order and deduplicates.
 * Invalid references and cycles emit diagnostics and are excluded from output.
 * Diagnostics are deduplicated by (code, group, member).
 */
export function resolveToolAliases(
    activeNames: string[],
    availableNames: string[],
    groups: Record<string, string[]>,
): ResolveToolAliasesResult {
    const names: string[] = [];
    const seen = new Set<string>();
    const expandedAliases: string[] = [];
    const seenAlias = new Set<string>();
    const diagnostics: ToolGroupDiagnostic[] = [];
    const seenDiag = new Set<string>();

    // Tracks names actively being resolved to detect cycles
    const visiting = new Set<string>();

    function emitDiag(
        code: ToolGroupDiagnosticCode,
        member: string,
        group: string,
        extra?: string,
    ): void {
        const key = `${code}|${group}|${member}`;
        if (seenDiag.has(key)) return;
        seenDiag.add(key);

        const messages: Record<ToolGroupDiagnosticCode, string> = {
            cycle: `Cycle detected: ${extra ?? member}`,
            'missing-group': `Group not found: ${member}`,
            'unknown-tool': `Unknown tool: ${member}`,
            'unmatched-pattern': `No tools match pattern: ${member}`,
        };
        diagnostics.push({ code, group, member, message: messages[code] });
    }

    function recordAlias(alias: string): void {
        if (!seenAlias.has(alias)) {
            seenAlias.add(alias);
            expandedAliases.push(alias);
        }
    }

    function addName(name: string): void {
        if (seen.has(name)) return;
        seen.add(name);
        names.push(name);
    }

    /** Dispatch a single member value within a group context. */
    function dispatchMember(
        member: string,
        originGroup: string,
        chain: string[],
    ): void {
        if (member.startsWith(TOOL_GROUP_PREFIX)) {
            expandGroup(member, chain);
        } else if (isGlob(member)) {
            expandGlobInGroup(member, originGroup);
        } else {
            // Exact name — validate against available names
            if (!availableNames.includes(member)) {
                emitDiag('unknown-tool', member, originGroup);
                return;
            }
            addName(member);
        }
    }

    function expandGroup(alias: string, chain: string[]): void {
        const bare = fromToolGroupAlias(alias);
        if (!bare) return;

        if (visiting.has(bare)) {
            // Cycle detected
            const cycleStart = chain.indexOf(bare);
            const cycleChain =
                cycleStart >= 0
                    ? [...chain.slice(cycleStart), bare].join(' -> ')
                    : [...chain, bare].join(' -> ');
            emitDiag('cycle', alias, bare, cycleChain);
            return;
        }

        recordAlias(alias);

        const groupMembers = groups[bare];
        if (!groupMembers) {
            emitDiag('missing-group', alias, bare);
            return;
        }

        visiting.add(bare);
        const subChain = [...chain, bare];
        for (const member of groupMembers) {
            dispatchMember(member, bare, subChain);
        }
        visiting.delete(bare);
    }

    function expandGlobInGroup(pattern: string, originGroup: string): void {
        const matched = globMatch(pattern, availableNames);
        if (matched.length === 0) {
            emitDiag('unmatched-pattern', pattern, originGroup);
            return;
        }
        for (const m of matched) {
            addName(m);
        }
    }

    // ── Main loop over activeNames ────────────────────
    for (const item of activeNames) {
        if (item.startsWith(TOOL_GROUP_PREFIX)) {
            expandGroup(item, []);
        } else if (isGlob(item)) {
            expandGlobInGroup(item, '<active>');
        } else {
            if (!availableNames.includes(item)) {
                emitDiag('unknown-tool', item, '<active>');
                continue;
            }
            addName(item);
        }
    }

    return { names, expandedAliases, diagnostics };
}
