import { describe, expect, it } from 'bun:test';
import { resolveToolAliases } from './resolver.ts';

const GROUPS: Record<string, string[]> = {
    read: ['write', 'edit'],
    dev: ['read', 'grep', 'find'],
    tools: ['write', 'read', 'edit', 'find'],
    nested: ['@read', '@dev'],
    deep: ['@nested', 'grep'],
    self: ['@self'],
    a_b: ['@read', 'write'],
    pat: ['write', 'd?l?te', 'g*'],
};

const AVAILABLE = ['write', 'edit', 'grep', 'find', 'delete', 'move', 'list'];

describe('resolveToolAliases', () => {
    it('returns empty result for empty activeNames', () => {
        const r = resolveToolAliases([], AVAILABLE, GROUPS);
        expect(r.names).toEqual([]);
        expect(r.expandedAliases).toEqual([]);
        expect(r.diagnostics).toEqual([]);
    });

    it('passes through exact tool names unchanged', () => {
        const r = resolveToolAliases(['write', 'grep'], AVAILABLE, GROUPS);
        expect(r.names).toEqual(['write', 'grep']);
        expect(r.expandedAliases).toEqual([]);
        expect(r.diagnostics).toEqual([]);
    });

    it('expands @group alias to its member tools', () => {
        const r = resolveToolAliases(['@read'], AVAILABLE, GROUPS);
        expect(r.names).toEqual(['write', 'edit']);
        expect(r.expandedAliases).toEqual(['@read']);
        expect(r.diagnostics).toEqual([]);
    });

    it('expands nested @group references depth-first, emits unknown-tool for unavailable members', () => {
        const r = resolveToolAliases(['@nested'], AVAILABLE, GROUPS);
        // @nested → @read + @dev
        // @read → write, edit ✓
        // @dev  → read (NOT available → unknown-tool), grep ✓, find ✓
        expect(r.names).toEqual(['write', 'edit', 'grep', 'find']);
        expect(r.expandedAliases).toEqual(['@nested', '@read', '@dev']);
        expect(r.diagnostics).toHaveLength(1);
        expect(r.diagnostics[0]).toEqual({
            code: 'unknown-tool',
            group: 'dev',
            member: 'read',
            message: 'Unknown tool: read',
        });
    });

    it('handles triple nesting', () => {
        const r = resolveToolAliases(['@deep'], AVAILABLE, GROUPS);
        expect(r.names).toEqual(['write', 'edit', 'grep', 'find']);
        expect(r.expandedAliases).toEqual([
            '@deep',
            '@nested',
            '@read',
            '@dev',
        ]);
        // unknown-tool for 'read' from @dev
        expect(r.diagnostics).toHaveLength(1);
    });

    it('detects cycles and reports chain', () => {
        const r = resolveToolAliases(['@self'], AVAILABLE, GROUPS);
        expect(r.names).toEqual([]);
        expect(r.expandedAliases).toEqual(['@self']);
        expect(r.diagnostics).toHaveLength(1);
        expect(r.diagnostics[0].code).toBe('cycle');
        expect(r.diagnostics[0].member).toBe('@self');
        expect(r.diagnostics[0].group).toBe('self');
        expect(r.diagnostics[0].message).toContain('self');
    });

    it('emits missing-group diagnostic for unknown @group', () => {
        const r = resolveToolAliases(['@nonexistent'], AVAILABLE, GROUPS);
        expect(r.names).toEqual([]);
        expect(r.expandedAliases).toEqual(['@nonexistent']);
        expect(r.diagnostics).toHaveLength(1);
        expect(r.diagnostics[0]).toEqual({
            code: 'missing-group',
            group: 'nonexistent',
            member: '@nonexistent',
            message: 'Group not found: @nonexistent',
        });
    });

    it('emits unknown-tool diagnostic for bare name not in available', () => {
        const r = resolveToolAliases(
            ['write', 'unknown_tool', 'grep'],
            AVAILABLE,
            GROUPS,
        );
        expect(r.names).toEqual(['write', 'grep']);
        expect(r.expandedAliases).toEqual([]);
        expect(r.diagnostics).toHaveLength(1);
        expect(r.diagnostics[0]).toEqual({
            code: 'unknown-tool',
            group: '<active>',
            member: 'unknown_tool',
            message: 'Unknown tool: unknown_tool',
        });
    });

    it('expands * glob against available names', () => {
        const r = resolveToolAliases(['*'], ['write', 'edit', 'grep'], GROUPS);
        expect(r.names).toEqual(['write', 'edit', 'grep']);
        expect(r.expandedAliases).toEqual([]);
        expect(r.diagnostics).toEqual([]);
    });

    it('expands ? glob pattern', () => {
        const r = resolveToolAliases(
            ['???'],
            ['cat', 'dog', 'write', 'abc'],
            GROUPS,
        );
        expect(r.names).toEqual(['cat', 'dog', 'abc']);
        expect(r.expandedAliases).toEqual([]);
    });

    it('emits unmatched-pattern when glob matches nothing', () => {
        const r = resolveToolAliases(['zzz_*'], AVAILABLE, GROUPS);
        expect(r.names).toEqual([]);
        expect(r.expandedAliases).toEqual([]);
        expect(r.diagnostics).toHaveLength(1);
        expect(r.diagnostics[0]).toEqual({
            code: 'unmatched-pattern',
            group: '<active>',
            member: 'zzz_*',
            message: 'No tools match pattern: zzz_*',
        });
    });

    it('excludes @-prefixed names from glob expansion candidates', () => {
        const available = ['write', 'edit', '@read', '@dev'];
        const r = resolveToolAliases(['*'], available, GROUPS);
        expect(r.names).toEqual(['write', 'edit']);
    });

    it('dedupes tools preserving first occurrence order', () => {
        const r = resolveToolAliases(['@tools', 'write'], AVAILABLE, GROUPS);
        // @tools → write, read, edit, find ; read unavailable → unknown-tool
        // Expected: write, edit, find (read skipped, write deduped)
        expect(r.names).toEqual(['write', 'edit', 'find']);
    });

    it('invalid @group member does not emit tool name', () => {
        const groupsWithBad: Record<string, string[]> = {
            ...GROUPS,
            badref: ['@nonexist'],
        };
        const r = resolveToolAliases(['@badref'], AVAILABLE, groupsWithBad);
        expect(r.names).toEqual([]);
        expect(r.diagnostics).toHaveLength(1);
    });

    it('mix of bare names, @groups, and globs in same activeNames', () => {
        const r = resolveToolAliases(
            ['write', '@read', 'd?l?te', 'find'],
            AVAILABLE,
            GROUPS,
        );
        expect(r.names).toEqual(['write', 'edit', 'delete', 'find']);
        expect(r.expandedAliases).toEqual(['@read']);
    });

    it('cycle detection with multi-hop chain message', () => {
        const cyclic: Record<string, string[]> = {
            a: ['@b'],
            b: ['@c'],
            c: ['@a'],
        };
        const r = resolveToolAliases(['@a'], ['write'], cyclic);
        expect(r.names).toEqual([]);
        expect(r.expandedAliases).toEqual(['@a', '@b', '@c']);
        expect(r.diagnostics).toHaveLength(1);
        expect(r.diagnostics[0].code).toBe('cycle');
        expect(r.diagnostics[0].group).toBe('a');
        expect(r.diagnostics[0].message).toContain('a');
        expect(r.diagnostics[0].message).toContain('b');
        expect(r.diagnostics[0].message).toContain('c');
        expect(r.diagnostics[0].message).toContain('a');
    });

    it('expands glob patterns within group members', () => {
        const r = resolveToolAliases(['@pat'], AVAILABLE, GROUPS);
        // @pat → write, d?l?te (matches delete), g* (matches grep)
        expect(r.names).toEqual(['write', 'delete', 'grep']);
        expect(r.expandedAliases).toEqual(['@pat']);
        expect(r.diagnostics).toEqual([]);
    });

    it('deduplicates diagnostics by code/group/member', () => {
        // Same group listing duplicate member → should only emit one diagnostic
        const dedupGroups: Record<string, string[]> = {
            a: ['missing_tool', 'missing_tool'],
        };
        const r = resolveToolAliases(['@a'], ['write'], dedupGroups);
        expect(r.diagnostics).toHaveLength(1);
        expect(r.diagnostics[0]).toEqual({
            code: 'unknown-tool',
            group: 'a',
            member: 'missing_tool',
            message: 'Unknown tool: missing_tool',
        });
    });
});
