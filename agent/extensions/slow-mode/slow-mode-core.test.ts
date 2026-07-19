/**
 * Tests for the slow-mode pure helpers.
 *
 * All tests are self-contained — no filesystem, no pi API, no shells.
 */

import {
    describe,
    it,
    expect,
    beforeEach,
    afterEach,
    afterAll,
} from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import {
    resolvePath,
    myersDiff,
    buildHunks,
    generateUnifiedDiff,
    applyEdits,
    extractEditText,
    extractEditPatches,
    autoAcceptKey,
    loadSlowModeConfig,
    validateSlowModeConfig,
    DEFAULT_SLOW_MODE_CONFIG,
    type Edit,
    type EditPatch,
    type SlowModeConfig,
} from './slow-mode-core.ts';

// ===========================================================================
// resolvePath
// ===========================================================================
describe('resolvePath', () => {
    it('resolves relative path against cwd', () => {
        expect(resolvePath('/root', 'src/file.ts')).toBe('src/file.ts');
    });

    it('normalizes absolute path inside cwd', () => {
        expect(resolvePath('/root', '/root/src/file.ts')).toBe('src/file.ts');
    });

    it('returns ../ relative path when outside cwd', () => {
        // path.relative returns ../ for paths outside cwd — this is the
        // original slow-mode behavior preserved during extraction
        expect(resolvePath('/root', '/other/src/file.ts')).toBe(
            '../other/src/file.ts',
        );
    });

    it('normalizes redundant separators', () => {
        expect(resolvePath('/root', '/root//src/./file.ts')).toBe(
            'src/file.ts',
        );
    });
});

// ===========================================================================
// myersDiff
// ===========================================================================
describe('myersDiff', () => {
    it('returns all keeps for identical content', () => {
        const edits = myersDiff(['a', 'b', 'c'], ['a', 'b', 'c']);
        expect(edits).toEqual([
            { type: 'keep', line: 'a' },
            { type: 'keep', line: 'b' },
            { type: 'keep', line: 'c' },
        ]);
    });

    it('returns empty array for two empty inputs', () => {
        expect(myersDiff([], [])).toEqual([]);
    });

    it('returns all inserts when old is empty', () => {
        const edits = myersDiff([], ['x', 'y']);
        expect(edits).toEqual([
            { type: 'insert', line: 'x' },
            { type: 'insert', line: 'y' },
        ]);
    });

    it('returns all deletes when new is empty', () => {
        const edits = myersDiff(['x', 'y'], []);
        expect(edits).toEqual([
            { type: 'delete', line: 'x' },
            { type: 'delete', line: 'y' },
        ]);
    });

    it('detects a single line insertion', () => {
        const edits = myersDiff(['a', 'b'], ['a', 'x', 'b']);
        expect(edits).toContainEqual({ type: 'insert', line: 'x' });
        expect(edits).toContainEqual({ type: 'keep', line: 'a' });
        expect(edits).toContainEqual({ type: 'keep', line: 'b' });
    });

    it('detects a single line deletion', () => {
        const edits = myersDiff(['a', 'x', 'b'], ['a', 'b']);
        expect(edits).toContainEqual({ type: 'delete', line: 'x' });
        expect(edits).toContainEqual({ type: 'keep', line: 'a' });
        expect(edits).toContainEqual({ type: 'keep', line: 'b' });
    });

    it('detects a line modification (delete + insert)', () => {
        const edits = myersDiff(['a', 'old', 'c'], ['a', 'new', 'c']);
        expect(edits).toContainEqual({ type: 'delete', line: 'old' });
        expect(edits).toContainEqual({ type: 'insert', line: 'new' });
        expect(edits).toContainEqual({ type: 'keep', line: 'a' });
        expect(edits).toContainEqual({ type: 'keep', line: 'c' });
    });

    it('round-trips: applying edits reproduces new from old', () => {
        const oldLines = ['foo', 'bar', 'baz', 'qux', 'quux'];
        const newLines = ['foo', 'bar', 'corge', 'qux', 'quux', 'garply'];
        const edits = myersDiff(oldLines, newLines);

        // Reconstruct new from old + edits
        const reconstructed: string[] = [];
        for (const edit of edits) {
            if (edit.type === 'keep') reconstructed.push(edit.line);
            else if (edit.type === 'insert') reconstructed.push(edit.line);
            // delete: skip (was in old, not in new)
        }
        expect(reconstructed).toEqual(newLines);
    });
});

// ===========================================================================
// buildHunks
// ===========================================================================
describe('buildHunks', () => {
    it('returns empty array for no edits', () => {
        expect(buildHunks([], 3)).toEqual([]);
    });

    it('returns empty array for all-keep edits', () => {
        const edits: Edit[] = [
            { type: 'keep', line: 'a' },
            { type: 'keep', line: 'b' },
        ];
        expect(buildHunks(edits, 3)).toEqual([]);
    });

    it('builds a single hunk for one change with context', () => {
        const edits: Edit[] = [
            { type: 'keep', line: 'ctx1' },
            { type: 'keep', line: 'ctx2' },
            { type: 'keep', line: 'ctx3' },
            { type: 'delete', line: 'old' },
            { type: 'insert', line: 'new' },
            { type: 'keep', line: 'ctx4' },
            { type: 'keep', line: 'ctx5' },
            { type: 'keep', line: 'ctx6' },
        ];
        const hunks = buildHunks(edits, 3);
        expect(hunks).toHaveLength(1);
        const hunk = hunks[0];
        // oldStart is 1-based; context starts at index 0
        expect(hunk.oldStart).toBe(1);
        expect(hunk.newStart).toBe(1);
        expect(hunk.lines).toContain('-old');
        expect(hunk.lines).toContain('+new');
        expect(hunk.lines).toContain(' ctx1');
        expect(hunk.lines).toContain(' ctx6');
    });

    it('merges adjacent changes into one hunk', () => {
        const edits: Edit[] = [
            { type: 'keep', line: 'a' },
            { type: 'delete', line: 'b' },
            { type: 'insert', line: 'B' },
            { type: 'delete', line: 'c' },
            { type: 'insert', line: 'C' },
            { type: 'keep', line: 'd' },
        ];
        const hunks = buildHunks(edits, 3);
        expect(hunks).toHaveLength(1);
    });

    it('splits distant changes into separate hunks', () => {
        const ctx: Edit[] = Array.from({ length: 10 }, (_, i) => ({
            type: 'keep' as const,
            line: `line${i}`,
        }));
        const edits: Edit[] = [
            ctx[0]!,
            { type: 'delete', line: 'x1' },
            { type: 'insert', line: 'y1' },
            ...ctx.slice(1, 9), // 8 context lines — gap > 2*3=6
            { type: 'delete', line: 'x2' },
            { type: 'insert', line: 'y2' },
            ctx[9]!,
        ];
        const hunks = buildHunks(edits, 3);
        expect(hunks).toHaveLength(2);
    });

    it('computes correct old/new counts', () => {
        const edits: Edit[] = [
            { type: 'keep', line: 'a' },
            { type: 'delete', line: 'b' },
            { type: 'insert', line: 'B1' },
            { type: 'insert', line: 'B2' },
            { type: 'keep', line: 'c' },
        ];
        const hunks = buildHunks(edits, 3);
        expect(hunks).toHaveLength(1);
        // old: a(keep), b(del), c(keep) = 3 old lines
        // new: a(keep), B1,B2(ins), c(keep) = 4 new lines
        expect(hunks[0].oldCount).toBe(3);
        expect(hunks[0].newCount).toBe(4);
    });
});

// ===========================================================================
// generateUnifiedDiff
// ===========================================================================
describe('generateUnifiedDiff', () => {
    it('produces file headers', () => {
        const diff = generateUnifiedDiff('src/foo.ts', 'a', 'b');
        expect(diff).toContain('--- a/src/foo.ts');
        expect(diff).toContain('+++ b/src/foo.ts');
    });

    it('produces hunk headers with line counts', () => {
        const diff = generateUnifiedDiff(
            'f.ts',
            'line1\nline2',
            'line1\nLINE2',
        );
        expect(diff).toMatch(/@@ -1,2 \+1,2 @@/);
    });

    it('marks added lines with +', () => {
        const diff = generateUnifiedDiff('f.ts', 'a', 'a\nb');
        expect(diff).toContain('+b');
    });

    it('marks removed lines with -', () => {
        const diff = generateUnifiedDiff('f.ts', 'a\nb', 'a');
        expect(diff).toContain('-b');
    });

    it('includes context lines with a space prefix', () => {
        const diff = generateUnifiedDiff(
            'f.ts',
            'ctx\nold\nctx2',
            'ctx\nnew\nctx2',
        );
        expect(diff).toContain(' ctx');
        expect(diff).toContain(' ctx2');
    });

    it('returns just headers for identical content', () => {
        const diff = generateUnifiedDiff('f.ts', 'same', 'same');
        expect(diff).toBe('--- a/f.ts\n+++ b/f.ts');
    });
});

// ===========================================================================
// applyEdits (M2 fix)
// ===========================================================================
describe('applyEdits', () => {
    it('returns original content for empty edits array', () => {
        expect(applyEdits('hello world', [])).toBe('hello world');
    });

    it('applies a single edit', () => {
        const result = applyEdits('foo bar baz', [
            { oldText: 'bar', newText: 'qux' },
        ]);
        expect(result).toBe('foo qux baz');
    });

    it('applies multiple edits sequentially', () => {
        const result = applyEdits('a b c d', [
            { oldText: 'b', newText: 'B' },
            { oldText: 'd', newText: 'D' },
        ]);
        expect(result).toBe('a B c D');
    });

    it('uses first match for replacement', () => {
        const result = applyEdits('x x x', [{ oldText: 'x', newText: 'y' }]);
        expect(result).toBe('y x x');
    });

    it('skips edits with empty oldText', () => {
        const result = applyEdits('hello', [
            { oldText: '', newText: 'nope' },
            { oldText: 'hello', newText: 'world' },
        ]);
        expect(result).toBe('world');
    });

    it('skips edits where oldText is not found', () => {
        const result = applyEdits('hello', [
            { oldText: 'missing', newText: 'found' },
            { oldText: 'hello', newText: 'world' },
        ]);
        expect(result).toBe('world');
    });

    it('handles multi-line oldText/newText', () => {
        const original = 'function foo() {\n  return 1;\n}\n';
        const result = applyEdits(original, [
            { oldText: '  return 1;', newText: '  return 2;' },
        ]);
        expect(result).toBe('function foo() {\n  return 2;\n}\n');
    });

    it('applies edits in order, each seeing previous result', () => {
        const result = applyEdits('a b c', [
            { oldText: 'a b', newText: 'X' },
            { oldText: 'c', newText: 'Y' },
        ]);
        expect(result).toBe('X Y');
    });
});

// ===========================================================================
// extractEditText
// ===========================================================================
describe('extractEditText', () => {
    it('extracts from modern edits[] array', () => {
        const input = {
            edits: [
                { oldText: 'a', newText: 'b' },
                { oldText: 'c', newText: 'd' },
            ],
        };
        const result = extractEditText(input);
        expect(result).toEqual({ oldText: 'a\nc', newText: 'b\nd' });
    });

    it('extracts from legacy single oldText/newText', () => {
        const input = { oldText: 'old', newText: 'new' };
        const result = extractEditText(input);
        expect(result).toEqual({ oldText: 'old', newText: 'new' });
    });

    it('returns null for malformed input (no edits, no oldText)', () => {
        expect(
            extractEditText({ foo: 'bar' } as Record<string, unknown>),
        ).toBeNull();
    });

    it('returns null for empty edits array', () => {
        expect(extractEditText({ edits: [] })).toBeNull();
    });

    it('returns null when only oldText is present', () => {
        expect(extractEditText({ oldText: 'x' })).toBeNull();
    });
});

// ===========================================================================
// extractEditPatches
// ===========================================================================
describe('autoAcceptKey', () => {
    it('returns the command for bash', () => {
        expect(autoAcceptKey('bash', { command: 'ls -la' })).toBe('ls -la');
    });

    it('returns the command for safe_bash', () => {
        expect(autoAcceptKey('safe_bash', { command: 'rm -rf /tmp/x' })).toBe(
            'rm -rf /tmp/x',
        );
    });

    it('returns the path for write', () => {
        expect(autoAcceptKey('write', { path: '/a/b.ts', content: 'x' })).toBe(
            '/a/b.ts',
        );
    });

    it('returns the path for edit', () => {
        expect(autoAcceptKey('edit', { path: '/a/b.ts', edits: [] })).toBe(
            '/a/b.ts',
        );
    });

    it('returns serialized params for unknown tool', () => {
        const params = { path: '/a/b.ts', offset: 5 };
        const key = autoAcceptKey('read', params);
        expect(key).toBe(JSON.stringify(params));
    });

    it('returns null when command missing', () => {
        expect(autoAcceptKey('bash', {})).toBeNull();
    });

    it('returns null when path missing', () => {
        expect(autoAcceptKey('write', { content: 'x' })).toBeNull();
    });
});

describe('extractEditPatches', () => {
    it('returns patches array from modern edits[]', () => {
        const patches: EditPatch[] = [
            { oldText: 'a', newText: 'b' },
            { oldText: 'c', newText: 'd' },
        ];
        const result = extractEditPatches({ edits: patches });
        expect(result).toEqual(patches);
    });

    it('wraps legacy single edit as a one-element array', () => {
        const result = extractEditPatches({ oldText: 'old', newText: 'new' });
        expect(result).toEqual([{ oldText: 'old', newText: 'new' }]);
    });

    it('returns null for malformed input', () => {
        expect(
            extractEditPatches({ foo: 'bar' } as Record<string, unknown>),
        ).toBeNull();
    });

    it('returns null for empty edits array', () => {
        expect(extractEditPatches({ edits: [] })).toBeNull();
    });
});

describe('loadSlowModeConfig', () => {
    let agentDir: string;
    let cwd: string;

    const makeTempDir = () =>
        join(
            tmpdir(),
            `pi-slow-config-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );

    const writeSlowModeJson = (dir: string, content: unknown) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'slow-mode.json'), JSON.stringify(content));
    };

    const writeRawSlowModeJson = (dir: string, content: string) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'slow-mode.json'), content);
    };

    const cleanup = () => {
        try {
            rmSync(cwd, { recursive: true });
        } catch {
            /* best-effort temp-dir cleanup */
        }
        try {
            rmSync(agentDir, { recursive: true });
        } catch {
            /* best-effort temp-dir cleanup */
        }
    };

    afterAll(cleanup);

    beforeEach(() => {
        agentDir = makeTempDir();
        cwd = makeTempDir();
    });

    afterEach(cleanup);

    it('returns defaults when no config sources present', () => {
        const result = loadSlowModeConfig(cwd, agentDir);
        expect(result).toEqual({
            write: true,
            edit: true,
            bash: true,
            safe_bash: true,
        });
    });

    it('loads valid config from agent dir', () => {
        writeSlowModeJson(agentDir, { write: true, edit: false, grep: true });
        const result = loadSlowModeConfig(cwd, agentDir);
        expect(result).toEqual({ ...DEFAULT_SLOW_MODE_CONFIG, write: true, edit: false, grep: true });
    });

    it('returns defaults for malformed JSON', () => {
        writeRawSlowModeJson(agentDir, '{ not valid json }');
        const result = loadSlowModeConfig(cwd, agentDir);
        expect(result).toEqual(DEFAULT_SLOW_MODE_CONFIG);
    });

    it('filters out non-boolean values', () => {
        writeSlowModeJson(agentDir, {
            write: true,
            grep: 'yes',
            read: 1,
            find: false,
        });
        const result = loadSlowModeConfig(cwd, agentDir);
        expect(result).toEqual({ ...DEFAULT_SLOW_MODE_CONFIG, write: true, find: false });
    });

    it('returns defaults when file contains a JSON array', () => {
        writeRawSlowModeJson(agentDir, '[1, 2, 3]');
        const result = loadSlowModeConfig(cwd, agentDir);
        expect(result).toEqual(DEFAULT_SLOW_MODE_CONFIG);
    });

    it('merges project-local config over global', () => {
        writeSlowModeJson(agentDir, { write: true, edit: false });
        mkdirSync(join(cwd, '.pi'), { recursive: true });
        writeFileSync(
            join(cwd, '.pi', 'slow-mode.json'),
            JSON.stringify({ edit: true, grep: true }),
        );
        const result = loadSlowModeConfig(cwd, agentDir);
        expect(result).toEqual({ ...DEFAULT_SLOW_MODE_CONFIG, write: true, edit: true, grep: true });
    });

    it('loads from settings.json slowMode key via injected SettingsManager', () => {
        const sm = SettingsManager.inMemory({
            slowMode: { write: true, grep: true },
        } as any);
        const result = loadSlowModeConfig(cwd, agentDir, sm);
        expect(result).toEqual({ ...DEFAULT_SLOW_MODE_CONFIG, write: true, grep: true });
    });

    it('settings.json key filters out non-boolean values', () => {
        const sm = SettingsManager.inMemory({
            slowMode: { write: true, grep: 'yes', find: false, read: 1 },
        } as any);
        const result = loadSlowModeConfig(cwd, agentDir, sm);
        expect(result).toEqual({ ...DEFAULT_SLOW_MODE_CONFIG, write: true, find: false });
    });

    it('cumulative: legacy + settings merge, settings wins on shared keys', () => {
        writeSlowModeJson(agentDir, { write: true, edit: true, bash: true });
        const sm = SettingsManager.inMemory({
            slowMode: { edit: false, grep: true },
        } as any);
        const result = loadSlowModeConfig(cwd, agentDir, sm);
        // legacy provides write/bash (unchanged), settings provides grep (new),
        // settings edit:false overrides legacy edit:true (settings wins by default).
        // safe_bash comes from defaults (not in legacy/settings).
        expect(result).toEqual({ ...DEFAULT_SLOW_MODE_CONFIG, write: true, edit: false, bash: true, grep: true });
    });

    it('cascades: legacy file used when settings key is absent', () => {
        writeSlowModeJson(agentDir, { write: true, grep: true });
        const sm = SettingsManager.inMemory({} as any);
        const result = loadSlowModeConfig(cwd, agentDir, sm);
        expect(result).toEqual({ ...DEFAULT_SLOW_MODE_CONFIG, write: true, grep: true });
    });
});

describe('validateSlowModeConfig', () => {
    const activeTools = ['write', 'edit', 'read', 'bash', 'grep', 'find', 'ls'];

    it('returns empty warnings when all tools exist', () => {
        const config: SlowModeConfig = { write: true, edit: true, grep: true };
        const result = validateSlowModeConfig(config, activeTools);
        expect(result.tools).toEqual(
            new Map([
                ['write', true],
                ['edit', true],
                ['grep', true],
            ]),
        );
        expect(result.warnings).toEqual([]);
    });

    it('warns about non-existent tools', () => {
        const config: SlowModeConfig = {
            write: true,
            nonexistent: true,
            fake_tool: false,
        };
        const result = validateSlowModeConfig(config, activeTools);
        expect(result.tools.get('write')).toBe(true);
        expect(result.tools.has('nonexistent')).toBe(false);
        expect(result.tools.has('fake_tool')).toBe(false);
        expect(result.warnings).toContain(
            'Tool "nonexistent" in slow-mode config does not exist and will be ignored',
        );
        expect(result.warnings).toContain(
            'Tool "fake_tool" in slow-mode config does not exist and will be ignored',
        );
    });

    it('handles empty config', () => {
        const result = validateSlowModeConfig({}, activeTools);
        expect(result.tools.size).toBe(0);
        expect(result.warnings).toEqual([]);
    });

    it('handles empty active tools list', () => {
        const config: SlowModeConfig = { write: true };
        const result = validateSlowModeConfig(config, []);
        expect(result.tools.size).toBe(0);
        expect(result.warnings).toContain(
            'Tool "write" in slow-mode config does not exist and will be ignored',
        );
    });
});
