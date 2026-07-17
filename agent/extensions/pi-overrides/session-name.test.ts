import { describe, expect, it } from 'bun:test';
import {
    compactSkillSessionName,
    compactPromptSessionName,
} from './session-name.ts';

describe('compactPromptSessionName', () => {
    it('transforms known prompt command with args', () => {
        const prompts = new Set(['debug-issue']);
        expect(
            compactPromptSessionName('/debug-issue sandbox colors', prompts),
        ).toBe('/prompt:debug-issue sandbox colors');
    });

    it('transforms known prompt command without args', () => {
        const prompts = new Set(['debug-issue']);
        expect(compactPromptSessionName('/debug-issue', prompts)).toBe(
            '/prompt:debug-issue',
        );
    });

    it.each([
        ['unknown command', '/unknown', new Set(['debug-issue'])],
        [
            'skill command not in promptNames',
            '/skill:diagnose',
            new Set(['debug-issue']),
        ],
        [
            'non-leading slash text',
            'hello /debug-issue',
            new Set(['debug-issue']),
        ],
        ['malformed slash-only input', '/', new Set(['debug-issue'])],
    ])('returns undefined for %s', (_case, input, prompts) => {
        expect(compactPromptSessionName(input, prompts)).toBeUndefined();
    });

    it('preserves exact argument remainder with quotes and repeated whitespace', () => {
        const prompts = new Set(['debug-issue']);
        expect(
            compactPromptSessionName(
                '/debug-issue   "quoted arg"    repeated  spaces',
                prompts,
            ),
        ).toBe('/prompt:debug-issue   "quoted arg"    repeated  spaces');
    });

    it('treats trailing whitespace without real args as no-args', () => {
        const prompts = new Set(['debug-issue']);
        expect(compactPromptSessionName('/debug-issue   ', prompts)).toBe(
            '/prompt:debug-issue',
        );
    });

    it('transforms any command explicitly present in promptNames', () => {
        const prompts = new Set(['debug-issue', 'skill:diagnose']);
        expect(compactPromptSessionName('/skill:diagnose', prompts)).toBe(
            '/prompt:skill:diagnose',
        );
    });
});

describe('compactSkillSessionName', () => {
    it('replaces a leading skill block with its compact command', () => {
        const message = `<skill name="diagnose" location="/skills/diagnose/SKILL.md">
Long skill instructions
</skill>

Investigate color`;

        expect(compactSkillSessionName(message)).toBe(
            '/skill:diagnose Investigate color',
        );
    });

    it('joins names from consecutive leading skill blocks', () => {
        const message = `<skill name="diagnose" location="/skills/diagnose/SKILL.md">
Diagnose instructions
</skill>

<skill name="tdd" location="/skills/tdd/SKILL.md">
TDD instructions
</skill>

Fix login`;

        expect(compactSkillSessionName(message)).toBe(
            '/skill:diagnose,tdd Fix login',
        );
    });

    it('returns only the compact command when no user message follows', () => {
        const message = `<skill name="diagnose" location="/skills/diagnose/SKILL.md">
Diagnose instructions
</skill>`;

        expect(compactSkillSessionName(message)).toBe('/skill:diagnose');
    });

    it('preserves multiline user text after the skill blocks', () => {
        const message = `<skill name="diagnose" location="/skills/diagnose/SKILL.md">
Diagnose instructions
</skill>

Investigate color
Then fix contrast`;

        expect(compactSkillSessionName(message)).toBe(
            '/skill:diagnose Investigate color\nThen fix contrast',
        );
    });

    it.each([
        ['ordinary text', 'Investigate color'],
        [
            'an unclosed skill block',
            '<skill name="diagnose" location="/skills/diagnose/SKILL.md">instructions',
        ],
        [
            'a non-leading skill-looking block',
            'Use this example: <skill name="diagnose">instructions</skill>',
        ],
    ])('ignores %s', (_case, message) => {
        expect(compactSkillSessionName(message)).toBeUndefined();
    });
});
