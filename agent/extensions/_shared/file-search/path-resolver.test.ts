import { afterAll, beforeAll, describe, it, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    clearPathResolverCache,
    getSearchDirectories,
} from './path-resolver.ts';

let configuredProject: string;

beforeAll(() => {
    configuredProject = mkdtempSync(join(tmpdir(), 'pi-path-config-'));
    mkdirSync(join(configuredProject, '.pi'));
    writeFileSync(
        join(configuredProject, '.pi', 'settings.json'),
        JSON.stringify({
            fileResolver: { additionalDirectories: ['/extra/root'] },
        }),
    );
    clearPathResolverCache();
});

afterAll(() => {
    clearPathResolverCache();
    rmSync(configuredProject, { recursive: true, force: true });
});

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
        const result = getSearchDirectories('my-dir', {
            cwd: configuredProject,
        });
        expect(result.dirs).toContain(configuredProject);
        expect(result.dirs).toContain('/extra/root');
        expect(result.query).toBe('my-dir');
    });

    it('always includes CWD for relative prefixes', () => {
        const result = getSearchDirectories('bare', { cwd: '/cwd' });
        expect(result.dirs).toContain('/cwd');
        expect(result.query).toBe('bare');
    });

    it('returns matchingRoots when query matches search root basename', () => {
        const result = getSearchDirectories('root', {
            cwd: configuredProject,
        });
        expect(result.matchingRoots).toContain('/extra/root');
    });

    it('matchingRoots is empty when query does not match any root', () => {
        const result = getSearchDirectories('zzz', { cwd: '/projects' });
        expect(result.matchingRoots).toEqual([]);
    });

    it('matchingRoots is empty for absolute paths', () => {
        const dir = tempDir();
        try {
            const result = getSearchDirectories(dir + '/sub', { cwd: '/cwd' });
            expect(result.matchingRoots).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
