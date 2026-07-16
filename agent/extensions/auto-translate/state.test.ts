import { describe, it, expect } from 'bun:test';
import { icon } from './state.ts';
import { defaultRuntimeState } from './types.ts';

const { createState, buildStatusText, toggleSend } = await import('./state.ts');

const CFG = {
    model: undefined,
    defaultTargetLanguage: 'en',
    languages: { en: 'English', fr: 'French', ar: 'Arabic' },
};

describe('state', () => {
    it('createState initializes from config defaults with enabled=false, sendEnabled=true', () => {
        const s = createState(CFG);
        expect(s).toEqual({ enabled: false, sendEnabled: true, target: 'en' });
    });

    it("createState falls back to 'en' when defaultTargetLanguage unknown", () => {
        const s = createState({ ...CFG, defaultTargetLanguage: 'xx' });
        expect(s.target).toBe('en');
    });

    it('toggleSend flips sendEnabled', () => {
        const s = createState(CFG);
        expect(s.sendEnabled).toBe(true);
        toggleSend(s);
        expect(s.sendEnabled).toBe(false);
        toggleSend(s);
        expect(s.sendEnabled).toBe(true);
    });

    it('buildStatusText shows off when disabled', () => {
        const s = createState(CFG);
        expect(buildStatusText(s, CFG)).toBe(`${icon}translate off`);
    });

    it('buildStatusText shows target + mode when enabled', () => {
        const s = createState(CFG);
        s.enabled = true;
        expect(buildStatusText(s, CFG)).toBe(
            `${icon}translate → English | send`,
        );
        s.sendEnabled = false;
        expect(buildStatusText(s, CFG)).toBe(
            `${icon}translate → English | display`,
        );
    });

    it('buildStatusText uses raw code when language name missing', () => {
        const s = createState(CFG);
        s.enabled = true;
        s.target = 'zz';
        expect(buildStatusText(s, CFG)).toBe(`${icon}translate → zz | send`);
    });
});
