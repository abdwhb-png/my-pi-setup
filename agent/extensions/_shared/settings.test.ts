import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getSettingsValue, normalizeBooleanMap } from './settings';

describe('getSettingsValue', () => {
    let tempDir: string;
    let settingsPath: string;

    beforeAll(() => {
        tempDir = mkdtempSync('/tmp/settings-test-');
        settingsPath = join(tempDir, 'settings.json');
    });

    afterAll(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    it('returns nested value for valid key path', () => {
        writeFileSync(
            settingsPath,
            JSON.stringify({ 'pi-roles': { defaultRole: 'pi-caveman' } }),
        );
        const result = getSettingsValue('pi-roles.defaultRole', 'pi-agent', {
            path: settingsPath,
        });
        expect(result).toBe('pi-caveman');
    });

    it('returns default value for missing nested key', () => {
        writeFileSync(
            settingsPath,
            JSON.stringify({ 'pi-roles': { otherKey: 'value' } }),
        );
        const result = getSettingsValue('pi-roles.defaultRole', 'pi-agent', {
            path: settingsPath,
        });
        expect(result).toBe('pi-agent');
    });

    it('returns default value when file does not exist', () => {
        const result = getSettingsValue('pi-roles.defaultRole', 'pi-agent', {
            path: '/nonexistent/settings.json',
        });
        expect(result).toBe('pi-agent');
    });

    it('returns default value for malformed JSON', () => {
        writeFileSync(settingsPath, 'not valid json {');
        const result = getSettingsValue('some.key', 'default', {
            path: settingsPath,
        });
        expect(result).toBe('default');
    });

    it('handles top-level setting', () => {
        writeFileSync(
            settingsPath,
            JSON.stringify({ defaultModel: 'test-model' }),
        );
        const result = getSettingsValue('defaultModel', 'fallback', {
            path: settingsPath,
        });
        expect(result).toBe('test-model');
    });

    it('handles deeply nested path', () => {
        writeFileSync(
            settingsPath,
            JSON.stringify({
                a: {
                    b: {
                        c: {
                            d: 'deep-value',
                        },
                    },
                },
            }),
        );
        const result = getSettingsValue('a.b.c.d', 'fallback', {
            path: settingsPath,
        });
        expect(result).toBe('deep-value');
    });

    it('returns default for missing mid-path key', () => {
        writeFileSync(settingsPath, JSON.stringify({ a: { x: 1 } }));
        const result = getSettingsValue('a.missing.key', 'fallback', {
            path: settingsPath,
        });
        expect(result).toBe('fallback');
    });

    it('handles array value', () => {
        writeFileSync(
            settingsPath,
            JSON.stringify({ items: ['one', 'two', 'three'] }),
        );
        const result = getSettingsValue<string[]>('items', [], {
            path: settingsPath,
        });
        expect(result).toEqual(['one', 'two', 'three']);
    });

    it('handles null value', () => {
        writeFileSync(settingsPath, JSON.stringify({ nullVal: null }));
        const result = getSettingsValue('nullVal', 'default', {
            path: settingsPath,
        });
        expect(result).toBe('default');
    });
});

describe('normalizeBooleanMap', () => {
    it('returns the object unchanged when all values are booleans', () => {
        const result = normalizeBooleanMap({
            write: true,
            edit: false,
            grep: true,
        });
        expect(result).toEqual({ write: true, edit: false, grep: true });
    });

    it('filters out non-boolean values', () => {
        const result = normalizeBooleanMap({
            write: true,
            grep: 'yes',
            read: 1,
            find: false,
            nested: { a: true },
        });
        expect(result).toEqual({ write: true, find: false });
    });

    it('returns empty object for null', () => {
        expect(normalizeBooleanMap(null)).toEqual({});
    });

    it('returns empty object for undefined', () => {
        expect(normalizeBooleanMap(undefined)).toEqual({});
    });

    it('returns empty object for an array', () => {
        expect(normalizeBooleanMap([1, 2, 3])).toEqual({});
    });

    it('returns empty object for a primitive (string)', () => {
        expect(normalizeBooleanMap('hello')).toEqual({});
    });

    it('returns empty object for a primitive (number)', () => {
        expect(normalizeBooleanMap(42)).toEqual({});
    });

    it('returns empty object for an empty object', () => {
        expect(normalizeBooleanMap({})).toEqual({});
    });
});
