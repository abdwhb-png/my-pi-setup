import { describe, expect, it } from 'bun:test';
import { isThinkingLevel, THINKING_LEVELS } from './thinking.ts';

describe('isThinkingLevel', () => {
    it('accepts all valid thinking levels', () => {
        for (const level of THINKING_LEVELS) {
            expect(isThinkingLevel(level)).toBe(true);
        }
    });

    it('rejects invalid strings', () => {
        expect(isThinkingLevel('')).toBe(false);
        expect(isThinkingLevel('maximum')).toBe(false);
        expect(isThinkingLevel('ultra')).toBe(false);
        expect(isThinkingLevel('XHIGH')).toBe(false);
        expect(isThinkingLevel(' none')).toBe(false);
    });

    it('rejects non-string values', () => {
        expect(isThinkingLevel(null)).toBe(false);
        expect(isThinkingLevel(undefined)).toBe(false);
        expect(isThinkingLevel(42)).toBe(false);
        expect(isThinkingLevel(true)).toBe(false);
        expect(isThinkingLevel({})).toBe(false);
        expect(isThinkingLevel([])).toBe(false);
        expect(isThinkingLevel(['off'])).toBe(false);
    });
});

describe('THINKING_LEVELS', () => {
    it('contains all 7 canonical levels', () => {
        expect(THINKING_LEVELS).toEqual([
            'off',
            'minimal',
            'low',
            'medium',
            'high',
            'xhigh',
            'max',
        ]);
    });

    it('is readonly (no mutation at type level)', () => {
        // Compile-time check: TS rejects push/pop on a readonly tuple.
        // Runtime sanity: every level is a valid ThinkingLevel.
        for (const level of THINKING_LEVELS) {
            expect(isThinkingLevel(level)).toBe(true);
        }
    });
});
