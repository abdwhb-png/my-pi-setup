import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    getActiveRole,
    getDefaultRole,
    parseCommaList,
    readFrontmatter,
} from './pi-roles.ts';

let tempDir: string;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pi-roles-shared-'));
});

afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
});

describe('readFrontmatter', () => {
    it('returns parsed frontmatter for valid file', () => {
        const path = join(tempDir, 'valid.md');
        writeFileSync(
            path,
            `---
name: test
thinking: high
---
This is the body.`,
            'utf-8',
        );

        const result = readFrontmatter<{ name?: string; thinking?: string }>(
            path,
        );
        expect(result).not.toBeNull();
        expect(result!.name).toBe('test');
        expect(result!.thinking).toBe('high');
    });

    it('returns null for missing file', () => {
        const result = readFrontmatter(join(tempDir, 'nonexistent.md'));
        expect(result).toBeNull();
    });

    it('returns empty object for file without frontmatter (body only)', () => {
        const path = join(tempDir, 'no-frontmatter.md');
        writeFileSync(path, 'Just body, no frontmatter.', 'utf-8');

        const result = readFrontmatter(path);
        expect(result).toEqual({});
    });

    it('returns null for malformed frontmatter', () => {
        const path = join(tempDir, 'malformed.md');
        writeFileSync(
            path,
            `---
broken: ::: invalid yaml
---
body`,
            'utf-8',
        );

        const result = readFrontmatter(path);
        expect(result).toBeNull();
    });
});

describe('parseCommaList', () => {
    it('splits "a, b, c" into ["a", "b", "c"]', () => {
        expect(parseCommaList('a, b, c')).toEqual(['a', 'b', 'c']);
    });

    it('handles undefined → []', () => {
        expect(parseCommaList(undefined)).toEqual([]);
    });

    it('handles empty string → []', () => {
        expect(parseCommaList('')).toEqual([]);
    });

    it('handles whitespace-only → []', () => {
        expect(parseCommaList('   ')).toEqual([]);
    });

    it('handles "single" → ["single"]', () => {
        expect(parseCommaList('single')).toEqual(['single']);
    });

    it('trims extra whitespace and filters empty slots', () => {
        expect(parseCommaList('  worker ,  , scout , reviewer  ')).toEqual([
            'worker',
            'scout',
            'reviewer',
        ]);
    });
});

describe('getActiveRole', () => {
    it('returns null for empty entries', () => {
        expect(getActiveRole([])).toBeNull();
    });

    it('returns null when no active role entry exists', () => {
        const entries = [
            { type: 'message', data: {} },
            { type: 'custom', customType: 'something-else', data: {} },
        ];
        expect(getActiveRole(entries)).toBeNull();
    });

    it('returns the latest active role state', () => {
        const roleState = {
            name: 'test-role',
            source: 'user',
            path: '/home/user/.pi/agent/roles/test-role.md',
            appliedAt: 1234567890,
        };

        const entries = [
            { type: 'message', data: {} },
            {
                type: 'custom',
                customType: 'pi-roles:active-role',
                data: roleState,
            },
        ];

        const result = getActiveRole(entries);
        expect(result).not.toBeNull();
        expect(result!.name).toBe('test-role');
        expect(result!.source).toBe('user');
        expect(result!.path).toBe('/home/user/.pi/agent/roles/test-role.md');
        expect(result!.appliedAt).toBe(1234567890);
    });

    it('returns the newest active role when multiple exist', () => {
        const olderRole = {
            name: 'older-role',
            source: 'user',
            path: '/home/user/.pi/agent/roles/older.md',
            appliedAt: 1000,
        };
        const newerRole = {
            name: 'newer-role',
            source: 'user',
            path: '/home/user/.pi/agent/roles/newer.md',
            appliedAt: 2000,
        };

        const entries = [
            {
                type: 'custom',
                customType: 'pi-roles:active-role',
                data: olderRole,
            },
            {
                type: 'custom',
                customType: 'pi-roles:active-role',
                data: newerRole,
            },
        ];

        const result = getActiveRole(entries);
        expect(result!.name).toBe('newer-role');
    });
});

describe('getDefaultRole', () => {
    it('reads the configured default role through the shared bridge', () => {
        const settingsPath = join(tempDir, 'settings.json');
        writeFileSync(
            settingsPath,
            JSON.stringify({ 'pi-roles': { defaultRole: 'architect' } }),
        );

        expect(getDefaultRole({ path: settingsPath })).toBe('architect');
    });
});
