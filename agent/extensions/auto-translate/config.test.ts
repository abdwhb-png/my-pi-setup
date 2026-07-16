import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { loadTranslateConfig, normalizeTranslateConfig, mergeTranslateConfig } =
    await import('./config.ts');
const { DEFAULT_CONFIG } = await import('./types.ts');

function makeAgentDir(): string {
    return mkdtempSync(join(tmpdir(), 'auto-translate-test-'));
}

function writeGlobal(agentDir: string, data: unknown): void {
    writeFileSync(join(agentDir, 'translate.json'), JSON.stringify(data));
}

function writeProject(cwd: string, data: unknown): void {
    const piDir = join(cwd, '.pi');
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'translate.json'), JSON.stringify(data));
}

function cleanup(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
}

describe('loadTranslateConfig', () => {
    it('returns DEFAULT_CONFIG when no config file exists', () => {
        const agentDir = makeAgentDir();
        try {
            const cfg = loadTranslateConfig(agentDir, agentDir);
            expect(cfg).toEqual(DEFAULT_CONFIG);
        } finally {
            cleanup(agentDir);
        }
    });

    it('loads model + defaultTargetLanguage + languages from legacy global file', () => {
        const agentDir = makeAgentDir();
        try {
            writeGlobal(agentDir, {
                model: 'openai/gpt-5-nano',
                defaultTargetLanguage: 'fr',
                languages: { en: 'English', fr: 'French' },
            });
            const cfg = loadTranslateConfig(agentDir, agentDir);
            expect(cfg.model).toBe('openai/gpt-5-nano');
            expect(cfg.defaultTargetLanguage).toBe('fr');
            expect(cfg.languages).toEqual({ en: 'English', fr: 'French' });
        } finally {
            cleanup(agentDir);
        }
    });

    it('deep-merges languages (project union wins on conflict)', () => {
        const agentDir = makeAgentDir();
        try {
            writeGlobal(agentDir, {
                languages: { en: 'English', fr: 'French' },
            });
            writeProject(agentDir, {
                languages: { fr: 'Français', ar: 'Arabic' },
                defaultTargetLanguage: 'ar',
            });
            const cfg = loadTranslateConfig(agentDir, agentDir);
            expect(cfg.languages).toEqual({
                en: 'English',
                fr: 'Français',
                ar: 'Arabic',
            });
            expect(cfg.defaultTargetLanguage).toBe('ar');
        } finally {
            cleanup(agentDir);
        }
    });

    it('normalize filters invalid language values', () => {
        const normalized = normalizeTranslateConfig({
            languages: { en: 'English', bad: 42, fr: 'French' },
            model: 123,
            defaultTargetLanguage: 'en',
        });
        expect(normalized.languages).toEqual({ en: 'English', fr: 'French' });
        expect(normalized.model).toBeUndefined();
    });

    it('merge falls back to base languages when overlay omits them', () => {
        const merged = mergeTranslateConfig(
            { ...DEFAULT_CONFIG, languages: { en: 'English', fr: 'French' } },
            { defaultTargetLanguage: 'fr' },
        );
        expect(merged.languages).toEqual({ en: 'English', fr: 'French' });
        expect(merged.defaultTargetLanguage).toBe('fr');
    });
});
