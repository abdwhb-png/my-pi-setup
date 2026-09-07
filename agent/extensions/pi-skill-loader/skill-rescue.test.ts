import { describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    discoverSkillFallbacks,
    formatRescuedSkillBlock,
} from './skill-rescue.ts';

describe('discoverSkillFallbacks', () => {
    it('rescues a BOM-prefixed skill with valid frontmatter', async () => {
        const root = await mkdtemp(join(tmpdir(), 'pi-skill-rescue-'));
        try {
            const skillDir = join(root, 'bom-skill');
            const skillPath = join(skillDir, 'SKILL.md');
            await mkdir(skillDir);
            await writeFile(
                skillPath,
                '\uFEFF---\nname: bom-skill\ndescription: Rescued skill\n---\n\n# Instructions\n',
            );

            const result = await discoverSkillFallbacks([root]);

            expect(result.skills).toEqual([
                {
                    name: 'bom-skill',
                    description: 'Rescued skill',
                    path: skillPath,
                    baseDir: skillDir,
                    content: '---\nname: bom-skill\ndescription: Rescued skill\n---\n\n# Instructions\n',
                },
            ]);
            expect(result.diagnostics).toEqual([
                {
                    type: 'bom',
                    path: skillPath,
                    message: 'UTF-8 BOM normalized in memory.',
                },
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('formats a rescued skill exactly like Pi core expands a slash command', () => {
        const text = formatRescuedSkillBlock(
            {
                name: 'bom-skill',
                description: 'Rescued skill',
                path: '/tmp/bom-skill/SKILL.md',
                baseDir: '/tmp/bom-skill',
                content: '---\nname: bom-skill\ndescription: Rescued skill\n---\n\n# Instructions\n',
            },
            'Apply it now',
        );

        expect(text).toBe(
            '<skill name="bom-skill" location="/tmp/bom-skill/SKILL.md">\nReferences are relative to /tmp/bom-skill.\n\n# Instructions\n</skill>\n\nApply it now',
        );
    });

    it('reports BOM skills without usable frontmatter but does not rescue them', async () => {
        const root = await mkdtemp(join(tmpdir(), 'pi-skill-rescue-'));
        try {
            const skillDir = join(root, 'invalid-skill');
            const skillPath = join(skillDir, 'SKILL.md');
            await mkdir(skillDir);
            await writeFile(skillPath, '\uFEFF---\nname: invalid-skill\n---\n\n# Missing description\n');

            const result = await discoverSkillFallbacks([root]);

            expect(result.skills).toEqual([]);
            expect(result.diagnostics).toEqual([
                {
                    type: 'invalid-frontmatter',
                    path: skillPath,
                    message: 'Missing non-empty skill description.',
                },
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
