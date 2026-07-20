import { describe, expect, it } from 'bun:test';
import {
    appendWorkingDirectoryPrompt,
    buildWorkingDirectoryPrompt,
    WORKING_DIRECTORY_HEADING,
} from './working-directory-prompt.ts';

describe('working directory prompt', () => {
    it('names the resolved cwd and forbids redundant cd prefixes', () => {
        const prompt = buildWorkingDirectoryPrompt('/workspace/project');
        expect(prompt).toContain(WORKING_DIRECTORY_HEADING);
        expect(prompt).toContain('cd /workspace/project &&');
        expect(prompt).toContain('cd $(pwd) &&');
    });

    it('appends the instruction block only once', () => {
        const once = appendWorkingDirectoryPrompt('base prompt', '/workspace');
        expect(appendWorkingDirectoryPrompt(once, '/workspace')).toBe(once);
    });
});
