import { describe, expect, test } from 'bun:test';
import { HEADROOM_MODEL_ALIASES, mapHeadroomModel } from './headroom-models';

describe('Headroom model mapping', () => {
    test('maps aliases documented by the Headroom registry', () => {
        expect(mapHeadroomModel('gpt-4o-mini-2024-07-18')).toBe('gpt-4o-mini');
        expect(mapHeadroomModel('claude-3-5-sonnet-latest')).toBe('claude-3-5-sonnet-20241022');
        expect(HEADROOM_MODEL_ALIASES['claude-sonnet-4-20250514']).toBe('claude-3-5-sonnet-20241022');
    });

    test('passes unknown model IDs through without inventing an alias', () => {
        expect(mapHeadroomModel('ocg/go-unknown-model')).toBe('ocg/go-unknown-model');
    });
});