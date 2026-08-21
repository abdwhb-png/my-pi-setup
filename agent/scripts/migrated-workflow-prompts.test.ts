import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const promptsDir = join(import.meta.dir, '..', 'prompts');

describe('migrated workflow prompt names', () => {
    it('uses task-oriented names that do not compete with /implement', () => {
        const expectedNames = [
            'plan-review',
            'build-review-fix',
            'review-change',
        ];
        const retiredNames = [
            'context-plan-review',
            'implement-and-review',
            'implementation-review',
        ];

        for (const name of expectedNames) {
            expect(existsSync(join(promptsDir, `${name}.md`))).toBe(true);
            expect(name.includes('implement')).toBe(false);
        }

        for (const name of retiredNames) {
            expect(existsSync(join(promptsDir, `${name}.md`))).toBe(false);
        }
    });
});
