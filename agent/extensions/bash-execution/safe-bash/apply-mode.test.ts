import { describe, expect, it } from 'bun:test';
import { shouldBlockBashCall } from './apply-mode.ts';

describe('shouldBlockBashCall', () => {
    it('blocks bash in replace mode', () => {
        expect(shouldBlockBashCall('bash', 'replace')).toBe(true);
    });

    it('does not block bash in coexist mode', () => {
        expect(shouldBlockBashCall('bash', 'coexist')).toBe(false);
    });

    it('never blocks safe_bash (even in replace mode)', () => {
        expect(shouldBlockBashCall('safe_bash', 'replace')).toBe(false);
        expect(shouldBlockBashCall('safe_bash', 'coexist')).toBe(false);
    });

    it('never blocks other tools', () => {
        expect(shouldBlockBashCall('read', 'replace')).toBe(false);
        expect(shouldBlockBashCall('edit', 'replace')).toBe(false);
        expect(shouldBlockBashCall('grep', 'replace')).toBe(false);
        expect(shouldBlockBashCall('', 'replace')).toBe(false);
    });
});
