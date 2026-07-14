import { describe, it, expect } from 'bun:test';

describe('extension entry point', () => {
    it('exports a default function', async () => {
        const mod = await import('./index.ts');
        expect(typeof mod.default).toBe('function');
    });
});
