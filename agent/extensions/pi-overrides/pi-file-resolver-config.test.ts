import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
    loadFileResolverConfig,
    normalizeFileResolverConfig,
    mergeFileResolverConfig,
} = await import('./pi-file-resolver-config.ts');
const { DEFAULT_CONFIG } = await import('./pi-file-resolver-config.ts');

function makeAgentDir(): string {
    return mkdtempSync(join(tmpdir(), 'pi-file-resolver-test-'));
}

function writeGlobal(agentDir: string, data: unknown): void {
    writeFileSync(
        join(agentDir, 'pi-file-resolver.json'),
        JSON.stringify(data),
    );
}

function writeProject(cwd: string, data: unknown): void {
    const piDir = join(cwd, '.pi');
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'pi-file-resolver.json'), JSON.stringify(data));
}

function cleanup(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
}

describe('DEFAULT_CONFIG', () => {
    it('has respectGitignore: true', () => {
        expect(DEFAULT_CONFIG.fd.respectGitignore).toBe(true);
    });

    it('has followSymlinks: true', () => {
        expect(DEFAULT_CONFIG.fd.followSymlinks).toBe(true);
    });

    it('has includeHidden: true', () => {
        expect(DEFAULT_CONFIG.fd.includeHidden).toBe(true);
    });

    it('excludes .git and node_modules by default', () => {
        expect(DEFAULT_CONFIG.fd.excludePatterns).toContain('.git');
        expect(DEFAULT_CONFIG.fd.excludePatterns).toContain('node_modules');
    });

    it('has types: ["f"]', () => {
        expect(DEFAULT_CONFIG.fd.types).toEqual(['f']);
    });
});

describe('normalizeFileResolverConfig', () => {
    it('returns empty for null', () => {
        expect(normalizeFileResolverConfig(null)).toEqual({});
    });

    it('returns empty for non-object', () => {
        expect(normalizeFileResolverConfig('string')).toEqual({});
    });

    it('returns empty for array', () => {
        expect(normalizeFileResolverConfig([1, 2, 3])).toEqual({});
    });

    it('normalizes fd.respectGitignore as boolean', () => {
        const result = normalizeFileResolverConfig({
            fd: { respectGitignore: false },
        });
        expect(result.fd?.respectGitignore).toBe(false);
    });

    it('ignores non-boolean respectGitignore', () => {
        const result = normalizeFileResolverConfig({
            fd: { respectGitignore: 'no' },
        });
        expect(result.fd?.respectGitignore).toBeUndefined();
    });

    it('normalizes fd.followSymlinks as boolean', () => {
        const result = normalizeFileResolverConfig({
            fd: { followSymlinks: false },
        });
        expect(result.fd?.followSymlinks).toBe(false);
    });

    it('ignores non-boolean followSymlinks', () => {
        const result = normalizeFileResolverConfig({
            fd: { followSymlinks: 'off' },
        });
        expect(result.fd?.followSymlinks).toBeUndefined();
    });

    it('normalizes fd.includeHidden as boolean', () => {
        const result = normalizeFileResolverConfig({
            fd: { includeHidden: false },
        });
        expect(result.fd?.includeHidden).toBe(false);
    });

    it('ignores non-boolean includeHidden', () => {
        const result = normalizeFileResolverConfig({
            fd: { includeHidden: 0 },
        });
        expect(result.fd?.includeHidden).toBeUndefined();
    });

    it('normalizes fd.excludePatterns as string array', () => {
        const result = normalizeFileResolverConfig({
            fd: { excludePatterns: ['.cache', 'dist'] },
        });
        expect(result.fd?.excludePatterns).toEqual(['.cache', 'dist']);
    });

    it('filters non-string values from excludePatterns', () => {
        const result = normalizeFileResolverConfig({
            fd: { excludePatterns: ['.cache', 123, true, 'dist'] },
        });
        expect(result.fd?.excludePatterns).toEqual(['.cache', 'dist']);
    });

    it('returns empty excludePatterns for non-array', () => {
        const result = normalizeFileResolverConfig({
            fd: { excludePatterns: 'single' },
        });
        expect(result.fd?.excludePatterns).toBeUndefined();
    });

    it('normalizes fd.types as string array', () => {
        const result = normalizeFileResolverConfig({
            fd: { types: ['f', 'd'] },
        });
        expect(result.fd?.types).toEqual(['f', 'd']);
    });

    it('filters non-string values from types', () => {
        const result = normalizeFileResolverConfig({
            fd: { types: ['f', 42, 'd'] },
        });
        expect(result.fd?.types).toEqual(['f', 'd']);
    });

    it('ignores fd if it is not an object', () => {
        const result = normalizeFileResolverConfig({ fd: 'not-an-object' });
        expect(result.fd).toBeUndefined();
    });

    it('ignores unknown top-level keys', () => {
        const result = normalizeFileResolverConfig({ unknownKey: 'value' });
        expect(result).toEqual({});
    });
});

describe('mergeFileResolverConfig', () => {
    it('uses overlay scalar over base (respectGitignore false over true)', () => {
        const merged = mergeFileResolverConfig(DEFAULT_CONFIG, {
            fd: { respectGitignore: false },
        });
        expect(merged.fd.respectGitignore).toBe(false);
    });

    it('keeps base scalar when overlay omits it', () => {
        const merged = mergeFileResolverConfig(DEFAULT_CONFIG, {
            fd: { respectGitignore: false },
        });
        expect(merged.fd.followSymlinks).toBe(true);
        expect(merged.fd.includeHidden).toBe(true);
    });

    it('merges excludePatterns as union (base + overlay)', () => {
        const merged = mergeFileResolverConfig(
            {
                fd: {
                    ...DEFAULT_CONFIG.fd,
                    excludePatterns: ['.git', 'node_modules'],
                },
            },
            { fd: { excludePatterns: ['.cache', 'dist'] } },
        );
        expect(merged.fd.excludePatterns).toEqual([
            '.git',
            'node_modules',
            '.cache',
            'dist',
        ]);
    });

    it('overlays types (replaces, not merges)', () => {
        const merged = mergeFileResolverConfig(
            { fd: { ...DEFAULT_CONFIG.fd, types: ['f'] } },
            { fd: { types: ['f', 'd'] } },
        );
        expect(merged.fd.types).toEqual(['f', 'd']);
    });

    it('keeps base excludePatterns when overlay omits fd', () => {
        const merged = mergeFileResolverConfig(DEFAULT_CONFIG, {});
        expect(merged.fd.excludePatterns).toEqual(
            DEFAULT_CONFIG.fd.excludePatterns,
        );
    });

    it('keeps all base defaults when overlay is empty', () => {
        const merged = mergeFileResolverConfig(DEFAULT_CONFIG, {});
        expect(merged).toEqual(DEFAULT_CONFIG);
    });
});

describe('loadFileResolverConfig', () => {
    it('returns DEFAULT_CONFIG when no config file exists', () => {
        const agentDir = makeAgentDir();
        try {
            const cfg = loadFileResolverConfig(agentDir, agentDir);
            expect(cfg).toEqual(DEFAULT_CONFIG);
        } finally {
            cleanup(agentDir);
        }
    });

    it('loads fd flags from legacy global file', () => {
        const agentDir = makeAgentDir();
        try {
            writeGlobal(agentDir, {
                fd: {
                    respectGitignore: false,
                    includeHidden: false,
                    excludePatterns: ['.cache', 'dist'],
                },
            });
            const cfg = loadFileResolverConfig(agentDir, agentDir);
            expect(cfg.fd.respectGitignore).toBe(false);
            expect(cfg.fd.includeHidden).toBe(false);
            expect(cfg.fd.followSymlinks).toBe(true); // not overridden
            expect(cfg.fd.excludePatterns).toEqual([
                '.git',
                'node_modules',
                '.cache',
                'dist',
            ]);
        } finally {
            cleanup(agentDir);
        }
    });

    it('deep-merges project-local over global (excludePatterns union)', () => {
        const agentDir = makeAgentDir();
        try {
            writeGlobal(agentDir, {
                fd: { respectGitignore: false, followSymlinks: false },
            });
            writeProject(agentDir, {
                fd: { followSymlinks: true, includeHidden: false },
            });
            const cfg = loadFileResolverConfig(agentDir, agentDir);
            expect(cfg.fd.respectGitignore).toBe(false); // from global
            expect(cfg.fd.followSymlinks).toBe(true); // project overrides
            expect(cfg.fd.includeHidden).toBe(false); // from project
        } finally {
            cleanup(agentDir);
        }
    });

    it('returns defaults for malformed JSON', () => {
        const agentDir = makeAgentDir();
        try {
            writeFileSync(
                join(agentDir, 'pi-file-resolver.json'),
                'not json {{{',
            );
            const cfg = loadFileResolverConfig(agentDir, agentDir);
            expect(cfg).toEqual(DEFAULT_CONFIG);
        } finally {
            cleanup(agentDir);
        }
    });
});
