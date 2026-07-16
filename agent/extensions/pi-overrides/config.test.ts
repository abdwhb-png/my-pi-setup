import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
    loadFileResolverConfig,
    normalizeFileResolverConfig,
    mergeFileResolverConfig,
    getFileResolverConfig,
    setFileResolverConfig,
} = await import('./config.ts');
const { DEFAULT_CONFIG } = await import('./config.ts');

function makeAgentDir(): string {
    return mkdtempSync(join(tmpdir(), 'pi-fr-config-test-'));
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
    // fd
    it('fd.respectGitignore defaults to true', () => {
        expect(DEFAULT_CONFIG.fd.respectGitignore).toBe(true);
    });
    it('fd.followSymlinks defaults to true', () => {
        expect(DEFAULT_CONFIG.fd.followSymlinks).toBe(true);
    });
    it('fd.includeHidden defaults to true', () => {
        expect(DEFAULT_CONFIG.fd.includeHidden).toBe(true);
    });
    it('fd.excludePatterns excludes .git and node_modules', () => {
        expect(DEFAULT_CONFIG.fd.excludePatterns).toContain('.git');
        expect(DEFAULT_CONFIG.fd.excludePatterns).toContain('node_modules');
    });
    it('fd.types is ["f"]', () => {
        expect(DEFAULT_CONFIG.fd.types).toEqual(['f']);
    });

    // rg
    it('rg.respectGitignore defaults to true', () => {
        expect(DEFAULT_CONFIG.rg.respectGitignore).toBe(true);
    });

    // ls
    it('ls.respectGitignore defaults to true', () => {
        expect(DEFAULT_CONFIG.ls.respectGitignore).toBe(true);
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

    // fd normalization
    it('normalizes fd.respectGitignore as boolean', () => {
        const result = normalizeFileResolverConfig({
            fd: { respectGitignore: false },
        });
        expect(result.fd?.respectGitignore).toBe(false);
    });
    it('ignores non-boolean fd.respectGitignore', () => {
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
    it('ignores non-boolean fd.followSymlinks', () => {
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
    it('ignores non-boolean fd.includeHidden', () => {
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
    it('filters non-string values from fd.excludePatterns', () => {
        const result = normalizeFileResolverConfig({
            fd: { excludePatterns: ['.cache', 123, true, 'dist'] },
        });
        expect(result.fd?.excludePatterns).toEqual(['.cache', 'dist']);
    });
    it('returns undefined for non-array fd.excludePatterns', () => {
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
    it('filters non-string values from fd.types', () => {
        const result = normalizeFileResolverConfig({
            fd: { types: ['f', 42, 'd'] },
        });
        expect(result.fd?.types).toEqual(['f', 'd']);
    });
    it('ignores fd if it is not an object', () => {
        const result = normalizeFileResolverConfig({ fd: 'not-an-object' });
        expect(result.fd).toBeUndefined();
    });

    // rg normalization
    it('normalizes rg.respectGitignore as boolean', () => {
        const result = normalizeFileResolverConfig({
            rg: { respectGitignore: false },
        });
        expect(result.rg?.respectGitignore).toBe(false);
    });
    it('ignores non-boolean rg.respectGitignore', () => {
        const result = normalizeFileResolverConfig({
            rg: { respectGitignore: 'yes' },
        });
        expect(result.rg?.respectGitignore).toBeUndefined();
    });
    it('ignores rg if it is not an object', () => {
        const result = normalizeFileResolverConfig({ rg: 'bad' });
        expect(result.rg).toBeUndefined();
    });

    // ls normalization
    it('normalizes ls.respectGitignore as boolean', () => {
        const result = normalizeFileResolverConfig({
            ls: { respectGitignore: false },
        });
        expect(result.ls?.respectGitignore).toBe(false);
    });
    it('ignores non-boolean ls.respectGitignore', () => {
        const result = normalizeFileResolverConfig({
            ls: { respectGitignore: 1 },
        });
        expect(result.ls?.respectGitignore).toBeUndefined();
    });
    it('ignores ls if it is not an object', () => {
        const result = normalizeFileResolverConfig({ ls: 'nope' });
        expect(result.ls).toBeUndefined();
    });

    it('ignores unknown top-level keys', () => {
        const result = normalizeFileResolverConfig({ unknownKey: 'value' });
        expect(result).toEqual({});
    });
});

describe('mergeFileResolverConfig', () => {
    // fd merge
    it('uses overlay scalar over base (fd.respectGitignore false over true)', () => {
        const merged = mergeFileResolverConfig(DEFAULT_CONFIG, {
            fd: { respectGitignore: false },
        });
        expect(merged.fd.respectGitignore).toBe(false);
    });
    it('keeps base scalar when overlay omits fd', () => {
        const merged = mergeFileResolverConfig(DEFAULT_CONFIG, {
            fd: { respectGitignore: false },
        });
        expect(merged.fd.followSymlinks).toBe(true);
        expect(merged.fd.includeHidden).toBe(true);
    });
    it('merges fd.excludePatterns as union', () => {
        const merged = mergeFileResolverConfig(
            {
                ...DEFAULT_CONFIG,
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
    it('overlays fd.types (replaces)', () => {
        const merged = mergeFileResolverConfig(
            { ...DEFAULT_CONFIG, fd: { ...DEFAULT_CONFIG.fd, types: ['f'] } },
            { fd: { types: ['f', 'd'] } },
        );
        expect(merged.fd.types).toEqual(['f', 'd']);
    });

    // rg merge
    it('uses overlay rg.respectGitignore over base', () => {
        const merged = mergeFileResolverConfig(DEFAULT_CONFIG, {
            rg: { respectGitignore: false },
        });
        expect(merged.rg.respectGitignore).toBe(false);
    });
    it('keeps base rg when overlay omits rg', () => {
        const merged = mergeFileResolverConfig(DEFAULT_CONFIG, {});
        expect(merged.rg.respectGitignore).toBe(true);
    });

    // ls merge
    it('uses overlay ls.respectGitignore over base', () => {
        const merged = mergeFileResolverConfig(DEFAULT_CONFIG, {
            ls: { respectGitignore: false },
        });
        expect(merged.ls.respectGitignore).toBe(false);
    });
    it('keeps base ls when overlay omits ls', () => {
        const merged = mergeFileResolverConfig(DEFAULT_CONFIG, {});
        expect(merged.ls.respectGitignore).toBe(true);
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
            expect(cfg.fd.followSymlinks).toBe(true);
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

    it('loads rg flags from legacy global file', () => {
        const agentDir = makeAgentDir();
        try {
            writeGlobal(agentDir, {
                rg: { respectGitignore: false },
            });
            const cfg = loadFileResolverConfig(agentDir, agentDir);
            expect(cfg.rg.respectGitignore).toBe(false);
            expect(cfg.fd.respectGitignore).toBe(true); // fd untouched
        } finally {
            cleanup(agentDir);
        }
    });

    it('loads ls flags from legacy global file', () => {
        const agentDir = makeAgentDir();
        try {
            writeGlobal(agentDir, {
                ls: { respectGitignore: false },
            });
            const cfg = loadFileResolverConfig(agentDir, agentDir);
            expect(cfg.ls.respectGitignore).toBe(false);
            expect(cfg.rg.respectGitignore).toBe(true); // rg untouched
        } finally {
            cleanup(agentDir);
        }
    });

    it('deep-merges project-local over global', () => {
        const agentDir = makeAgentDir();
        try {
            writeGlobal(agentDir, {
                fd: { respectGitignore: false, followSymlinks: false },
            });
            writeProject(agentDir, {
                fd: { followSymlinks: true, includeHidden: false },
            });
            const cfg = loadFileResolverConfig(agentDir, agentDir);
            expect(cfg.fd.respectGitignore).toBe(false);
            expect(cfg.fd.followSymlinks).toBe(true);
            expect(cfg.fd.includeHidden).toBe(false);
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

describe('getFileResolverConfig / setFileResolverConfig', () => {
    it('returns DEFAULT_CONFIG before any session', () => {
        // After import, runtime config is still default
        expect(getFileResolverConfig()).toEqual(DEFAULT_CONFIG);
    });

    it('returns updated config after setFileResolverConfig', () => {
        const custom = {
            ...DEFAULT_CONFIG,
            fd: { ...DEFAULT_CONFIG.fd, respectGitignore: false },
        };
        setFileResolverConfig(custom);
        expect(getFileResolverConfig().fd.respectGitignore).toBe(false);
        // Reset back
        setFileResolverConfig(DEFAULT_CONFIG);
        expect(getFileResolverConfig().fd.respectGitignore).toBe(true);
    });
});
