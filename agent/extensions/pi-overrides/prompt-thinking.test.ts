import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
    ExtensionAPI,
    SlashCommandInfo,
} from '@earendil-works/pi-coding-agent';
import { registerPromptThinking } from './prompt-thinking.ts';

let tempDir: string;

function createPromptFile(
    dir: string,
    filename: string,
    frontmatter: Record<string, string>,
    body: string,
): string {
    const filePath = join(dir, filename);
    const frontmatterLines = Object.entries(frontmatter)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
    const content = `---\n${frontmatterLines}\n---\n\n${body}`;
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
}

interface TestCommands {
    setThinkingLevel: ReturnType<typeof mock>;
    handler: (event: { text: string }) => Promise<{ action: string }>;
}

function createMockAPI(promptCommands: SlashCommandInfo[]): {
    pi: ExtensionAPI;
    commands: TestCommands;
} {
    let thinkingLevel = 'off';
    const handlers = new Map<string, (event: object) => Promise<object>>();
    const setThinkingLevel = mock((level: string) => {
        thinkingLevel = level;
    });

    const pi = {
        on: (event: string, handler: (event: object) => Promise<object>) => {
            handlers.set(event, handler);
        },
        getCommands: () => promptCommands,
        setThinkingLevel,
        getThinkingLevel: () => thinkingLevel,
    } as unknown as ExtensionAPI;

    return {
        pi,
        commands: {
            setThinkingLevel,
            handler: async (event: { text: string }) => {
                const h = handlers.get('input');
                if (!h) throw new Error('input handler not registered');
                const result = await h(event);
                return result as { action: string };
            },
        },
    };
}

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pi-prompt-thinking-'));
});

afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
});

describe('registerPromptThinking', () => {
    it('sets thinking level from prompt frontmatter', async () => {
        const promptPath = createPromptFile(
            tempDir,
            'debug-issue.md',
            { description: 'debug issue', thinking: 'xhigh' },
            'Debug issue: $ARGUMENTS',
        );

        const promptCommands: SlashCommandInfo[] = [
            {
                name: 'debug-issue',
                description: 'Debug an issue',
                source: 'prompt',
                sourceInfo: {
                    path: promptPath,
                    source: 'prompt',
                    scope: 'user',
                    origin: 'package',
                },
            },
        ];

        const { pi, commands } = createMockAPI(promptCommands);
        registerPromptThinking(pi);

        const result = await commands.handler({
            text: '/debug-issue some bug',
        });

        expect(result.action).toBe('continue');
        expect(commands.setThinkingLevel).toHaveBeenCalledWith('xhigh');
    });

    it('does not set thinking when frontmatter has no thinking field', async () => {
        const promptPath = createPromptFile(
            tempDir,
            'plain-prompt.md',
            { description: 'a plain prompt' },
            'Just do the thing: $ARGUMENTS',
        );

        const promptCommands: SlashCommandInfo[] = [
            {
                name: 'plain-prompt',
                description: 'Plain prompt',
                source: 'prompt',
                sourceInfo: {
                    path: promptPath,
                    source: 'prompt',
                    scope: 'user',
                    origin: 'package',
                },
            },
        ];

        const { pi, commands } = createMockAPI(promptCommands);
        registerPromptThinking(pi);

        await commands.handler({ text: '/plain-prompt do it' });

        expect(commands.setThinkingLevel).not.toHaveBeenCalled();
    });

    it('does not set thinking when frontmatter thinking is invalid', async () => {
        const promptPath = createPromptFile(
            tempDir,
            'bad-prompt.md',
            { thinking: 'not-a-valid-level' },
            'Bad prompt: $ARGUMENTS',
        );

        const promptCommands: SlashCommandInfo[] = [
            {
                name: 'bad-prompt',
                source: 'prompt',
                sourceInfo: {
                    path: promptPath,
                    source: 'prompt',
                    scope: 'user',
                    origin: 'package',
                },
            },
        ];

        const { pi, commands } = createMockAPI(promptCommands);
        registerPromptThinking(pi);

        await commands.handler({ text: '/bad-prompt' });

        expect(commands.setThinkingLevel).not.toHaveBeenCalled();
    });

    it('ignores non-prompt commands (skills)', async () => {
        const { pi, commands } = createMockAPI([
            {
                name: 'diagnose',
                source: 'skill',
                sourceInfo: {
                    path: '/skills/diagnose/SKILL.md',
                    source: 'skill',
                    scope: 'user',
                    origin: 'package',
                },
            },
        ]);
        registerPromptThinking(pi);

        await commands.handler({ text: '/diagnose investigate' });

        expect(commands.setThinkingLevel).not.toHaveBeenCalled();
    });

    it('ignores non-prompt commands (extension)', async () => {
        const { pi, commands } = createMockAPI([
            {
                name: 'tool-summary',
                source: 'extension',
                sourceInfo: {
                    path: '/extensions/tool-summary/index.ts',
                    source: 'extension',
                    scope: 'user',
                    origin: 'package',
                },
            },
        ]);
        registerPromptThinking(pi);

        await commands.handler({ text: '/tool-summary' });

        expect(commands.setThinkingLevel).not.toHaveBeenCalled();
    });

    it('ignores non-slash input (plain text)', async () => {
        const { pi, commands } = createMockAPI([]);
        registerPromptThinking(pi);

        await commands.handler({ text: 'just some text, no command' });

        expect(commands.setThinkingLevel).not.toHaveBeenCalled();
    });

    it('ignores unknown command names', async () => {
        const { pi, commands } = createMockAPI([]);
        registerPromptThinking(pi);

        await commands.handler({ text: '/nonexistent arg' });

        expect(commands.setThinkingLevel).not.toHaveBeenCalled();
    });

    it('handles prompt file that does not exist gracefully', async () => {
        const promptCommands: SlashCommandInfo[] = [
            {
                name: 'missing-prompt',
                source: 'prompt',
                sourceInfo: {
                    path: join(tempDir, 'does-not-exist.md'),
                    source: 'prompt',
                    scope: 'user',
                    origin: 'package',
                },
            },
        ];

        const { pi, commands } = createMockAPI(promptCommands);
        registerPromptThinking(pi);

        // Should not throw — silently ignores
        await commands.handler({ text: '/missing-prompt' });

        expect(commands.setThinkingLevel).not.toHaveBeenCalled();
    });

    it('allows all valid thinking levels', async () => {
        const validLevels = [
            'off',
            'minimal',
            'low',
            'medium',
            'high',
            'xhigh',
        ];

        for (const level of validLevels) {
            mock.restore();

            const promptPath = createPromptFile(
                tempDir,
                `thinking-${level}.md`,
                { thinking: level },
                'Test prompt: $ARGUMENTS',
            );

            const promptCommands: SlashCommandInfo[] = [
                {
                    name: `thinking-${level}`,
                    source: 'prompt',
                    sourceInfo: {
                        path: promptPath,
                        source: 'prompt',
                        scope: 'user',
                        origin: 'package',
                    },
                },
            ];

            const { pi, commands } = createMockAPI(promptCommands);
            registerPromptThinking(pi);

            await commands.handler({ text: `/${`thinking-${level}`}` });

            expect(commands.setThinkingLevel).toHaveBeenCalledWith(level);
        }
    });

    it('command without arguments still applies thinking', async () => {
        const promptPath = createPromptFile(
            tempDir,
            'no-args.md',
            { thinking: 'low' },
            'Prompt without args',
        );

        const promptCommands: SlashCommandInfo[] = [
            {
                name: 'no-args',
                source: 'prompt',
                sourceInfo: {
                    path: promptPath,
                    source: 'prompt',
                    scope: 'user',
                    origin: 'package',
                },
            },
        ];

        const { pi, commands } = createMockAPI(promptCommands);
        registerPromptThinking(pi);

        await commands.handler({ text: '/no-args' });

        expect(commands.setThinkingLevel).toHaveBeenCalledWith('low');
    });

    it('command name with trailing slash is not matched', async () => {
        const { pi, commands } = createMockAPI([]);
        registerPromptThinking(pi);

        await commands.handler({ text: '/' });

        expect(commands.setThinkingLevel).not.toHaveBeenCalled();
    });

    it('slash with only whitespace is not treated as command', async () => {
        const { pi, commands } = createMockAPI([]);
        registerPromptThinking(pi);

        await commands.handler({ text: '/ ' });

        expect(commands.setThinkingLevel).not.toHaveBeenCalled();
    });
});
