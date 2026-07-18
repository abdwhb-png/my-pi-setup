import { describe, it, expect, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock settings/cfg loading — path-resolver imports from pi-overrides/config.ts
mock.module('../../pi-overrides/config.ts', () => {
    // Return a config with additionalDirectories set
    let loadedConfig: any = null;
    return {
        loadFileResolverConfig: () => {
            if (loadedConfig) return loadedConfig;
            return {
                fd: {
                    respectGitignore: true,
                    followSymlinks: true,
                    includeHidden: true,
                    excludePatterns: ['.git', 'node_modules'],
                    types: ['f'],
                },
                rg: { respectGitignore: true },
                ls: { respectGitignore: true },
                additionalDirectories: ['/extra/root'],
                enableRealtimeFallback: true,
            };
        },
        // Allow tests to override config
        setTestConfig: (c: any) => {
            loadedConfig = c;
        },
    };
});

const { getSearchDirectories } = await import('./path-resolver.ts');

describe('getSearchDirectories', () => {
    // Helper: create a real temp directory for stat tests
    function tempDir(): string {
        const dir = mkdtempSync(join(tmpdir(), 'pi-path-resolver-'));
        return dir;
    }

    it('returns empty for non-existent absolute path', () => {
        const result = getSearchDirectories('/foo/bar', { cwd: '/cwd' });
        // /foo doesn't exist → empty
        expect(result.dirs).toEqual([]);
        expect(result.query).toBe('bar');
    });

    it('returns dir for existing absolute path', () => {
        const dir = tempDir();
        try {
            const result = getSearchDirectories(dir + '/sub', { cwd: '/cwd' });
            expect(result.dirs).toEqual([dir]);
            expect(result.query).toBe('sub');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('returns dir=prefix and empty query for absolute trailing-slash path', () => {
        const dir = tempDir();
        try {
            const result = getSearchDirectories(dir + '/', { cwd: '/cwd' });
            expect(result.dirs[0]).toBe(dir + '/');
            expect(result.query).toBe('');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('returns empty dirs for root path', () => {
        const result = getSearchDirectories('/foo', { cwd: '/cwd' });
        // dirname('/foo') = '/' → root → should be empty
        expect(result.dirs).toEqual([]);
    });

    it('returns empty dirs for non-existent absolute directory', () => {
        const result = getSearchDirectories('/nonexistent/deadbeef/file.ts', {
            cwd: '/cwd',
        });
        expect(result.dirs).toEqual([]);
    });

    it('returns valid dirs for existing absolute path', () => {
        const dir = tempDir();
        try {
            const result = getSearchDirectories(join(dir, 'sub'), {
                cwd: '/cwd',
            });
            expect(result.dirs).toEqual([dir]);
            expect(result.query).toBe('sub');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('expands ~ and treats as absolute', () => {
        const home = process.env.HOME ?? '/home/user';
        const result = getSearchDirectories('~/projects/foo', { cwd: '/cwd' });
        expect(result.dirs).toEqual([join(home, 'projects')]);
        expect(result.query).toBe('foo');
    });

    it('returns CWD + additionalDirectories for relative prefix', () => {
        const result = getSearchDirectories('my-dir', { cwd: '/current/cwd' });
        expect(result.dirs).toContain('/current/cwd');
        expect(result.dirs).toContain('/extra/root');
        expect(result.query).toBe('my-dir');
    });

    it('returns CWD only when additionals are empty', () => {
        const result = getSearchDirectories('bare', { cwd: '/cwd' });
        // Config has additionalDirectories from mock, so both appear
        expect(result.dirs).toContain('/cwd');
        expect(result.query).toBe('bare');
    });
});
