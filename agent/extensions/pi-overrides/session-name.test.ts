import { describe, expect, it } from 'bun:test';
import { compactSkillSessionName } from './session-name.ts';

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
