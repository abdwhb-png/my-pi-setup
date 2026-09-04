import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
    createEventBus,
    type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    isMarkdownLinkTransformRequest,
    MARKDOWN_LINKS_TRANSFORM_EVENT,
} from '../_shared/markdown-links.ts';
import contextExtension, {
    appendToolsListPrompt,
    buildContextSendMessage,
    buildToolsListSnippet,
    calculateExtensionFiles,
    ContextView,
    getSkillPathFromCommand,
} from '../context.ts';

describe('ContextView', () => {
    it('scrolls overflowing context with legacy and Kitty navigation keys', () => {
        let renderRequests = 0;
        const tui = {
            terminal: { rows: 10 },
            requestRender: () => {
                renderRequests++;
            },
        };
        const theme = {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
        };
        const view = new ContextView(
            tui as never,
            theme as never,
            {
                usage: null,
                model: null,
                agentFiles: [],
                extensions: Array.from(
                    { length: 20 },
                    (_, index) => `extension-${index + 1}`,
                ),
                tools: Array.from(
                    { length: 20 },
                    (_, index) => `tool-${index + 1}`,
                ),
                skills: Array.from(
                    { length: 20 },
                    (_, index) => `skill-${index + 1}`,
                ),
                loadedSkills: [],
                session: { totalTokens: 0, totalCost: 0 },
            },
            () => {},
        );

        const initial = view.render(48).join('\n');
        expect(initial).toContain('Window:');
        expect(initial).not.toContain('skill-20');

        view.handleInput('\x1b[6~');
        const paged = view.render(48).join('\n');
        expect(paged).not.toBe(initial);
        expect(renderRequests).toBe(1);

        view.handleInput('\x1b[57424u');
        const atEnd = view.render(48).join('\n');
        expect(atEnd).toContain('skill-20');
        expect(renderRequests).toBe(2);

        view.handleInput('\x1b[57424u');
        expect(renderRequests).toBe(2);
    });
});

describe('calculateExtensionFiles', () => {
    it('should correctly identify extension files from commands', () => {
        const mockCommands = [
            {
                name: 'cmd1',
                source: 'extension',
                sourceInfo: { path: '/home/user/.pi/agent/extensions/ext1.ts' },
            },
            {
                name: 'cmd2',
                source: 'extension',
                sourceInfo: { path: '/home/user/.pi/agent/extensions/ext1.ts' },
            },
            {
                name: 'cmd3',
                source: 'extension',
                sourceInfo: { path: '/home/user/.pi/agent/extensions/ext2.ts' },
            },
            {
                name: 'cmd4',
                source: 'skill',
                sourceInfo: { path: '/home/user/.pi/agent/skills/skill1.ts' },
            },
        ];

        const result = calculateExtensionFiles(mockCommands);
        expect(result).toEqual(['ext1.ts', 'ext2.ts']);
    });

    it('should return <unknown> when path is missing', () => {
        const mockCommands = [
            {
                name: 'cmd1',
                source: 'extension',
                // sourceInfo missing or path missing
            },
        ];

        const result = calculateExtensionFiles(mockCommands);
        expect(result).toEqual(['<unknown>']);
    });

    it('should disambiguate duplicate basenames with parent directory', () => {
        const mockCommands = [
            {
                name: 'cmd1',
                source: 'extension',
                sourceInfo: { path: '/extensions/foo/index.ts' },
            },
            {
                name: 'cmd2',
                source: 'extension',
                sourceInfo: { path: '/extensions/bar/index.ts' },
            },
            {
                name: 'cmd3',
                source: 'extension',
                sourceInfo: { path: '/extensions/baz/index.ts' },
            },
        ];

        const result = calculateExtensionFiles(mockCommands);
        expect(result).toEqual([
            'bar/index.ts',
            'baz/index.ts',
            'foo/index.ts',
        ]);
    });

    it('should keep unique basenames as-is', () => {
        const mockCommands = [
            {
                name: 'cmd1',
                source: 'extension',
                sourceInfo: { path: '/extensions/context.ts' },
            },
            {
                name: 'cmd2',
                source: 'extension',
                sourceInfo: { path: '/extensions/cron.ts' },
            },
        ];

        const result = calculateExtensionFiles(mockCommands);
        expect(result).toEqual(['context.ts', 'cron.ts']);
    });

    it('should disambiguate only duplicates in mixed set', () => {
        const mockCommands = [
            {
                name: 'cmd1',
                source: 'extension',
                sourceInfo: { path: '/extensions/context.ts' },
            },
            {
                name: 'cmd2',
                source: 'extension',
                sourceInfo: { path: '/extensions/foo/index.ts' },
            },
            {
                name: 'cmd3',
                source: 'extension',
                sourceInfo: { path: '/extensions/bar/index.ts' },
            },
            {
                name: 'cmd4',
                source: 'extension',
                sourceInfo: { path: '/extensions/cron.ts' },
            },
        ];

        const result = calculateExtensionFiles(mockCommands);
        expect(result).toEqual([
            'bar/index.ts',
            'context.ts',
            'cron.ts',
            'foo/index.ts',
        ]);
    });

    it('should walk up until unique for deep duplicate paths', () => {
        const mockCommands = [
            {
                name: 'cmd1',
                source: 'extension',
                sourceInfo: { path: '/extensions/pi-hypa/dist/src/index.ts' },
            },
            {
                name: 'cmd2',
                source: 'extension',
                sourceInfo: { path: '/extensions/pi-roles/dist/src/index.ts' },
            },
            {
                name: 'cmd3',
                source: 'extension',
                sourceInfo: { path: '/extensions/context-mode/build/index.ts' },
            },
            {
                name: 'cmd4',
                source: 'extension',
                sourceInfo: { path: '/extensions/context.ts' },
            },
        ];

        const result = calculateExtensionFiles(mockCommands);
        expect(result).toEqual([
            'build/index.ts',
            'context.ts',
            'pi-hypa/dist/src/index.ts',
            'pi-roles/dist/src/index.ts',
        ]);
    });
});

describe('buildToolsListSnippet', () => {
    it('should render one line per tool with description', () => {
        const tools = [
            { name: 'read', description: 'Read files from disk' },
            { name: 'bash', description: 'Run shell commands' },
        ];
        const result = buildToolsListSnippet(tools);
        expect(result).toBe(
            'Available tools:\n- read: Read files from disk\n- bash: Run shell commands',
        );
    });

    it('should skip tools without a description', () => {
        const tools = [
            { name: 'read', description: 'Read files from disk' },
            { name: 'secret-tool' },
        ];
        const result = buildToolsListSnippet(tools);
        expect(result).toBe('Available tools:\n- read: Read files from disk');
    });

    it('should render (none) when no tools have descriptions', () => {
        const result = buildToolsListSnippet([]);
        expect(result).toBe('Available tools:\n(none)');
    });

    it('should collapse multi-line descriptions to first line', () => {
        const tools = [
            { name: 'bash', description: 'Run commands\nsecond line' },
        ];
        const result = buildToolsListSnippet(tools);
        expect(result).toBe('Available tools:\n- bash: Run commands');
    });
});

describe('appendToolsListPrompt', () => {
    it('should append the tools block to a prompt', () => {
        const result = appendToolsListPrompt(
            'base prompt',
            [{ name: 'read', description: 'Read files' }],
        );
        expect(result).toBe(
            'base prompt\n\nAvailable tools:\n- read: Read files',
        );
    });

    it('should be idempotent and not double-append when heading already present', () => {
        const once = appendToolsListPrompt(
            'base prompt',
            [{ name: 'read', description: 'Read files' }],
        );
        expect(appendToolsListPrompt(once, [{ name: 'bash', description: 'Run commands' }])).toBe(once);
    });

    it('should append nothing for tools without descriptions', () => {
        const result = appendToolsListPrompt('base prompt', [{ name: 'x' }]);
        expect(result).toBe('base prompt\n\nAvailable tools:\n(none)');
    });

    it('should skip when the default-branch tools heading is already present', () => {
        const defaultPrompt =
            'header\nAvailable tools:\n- read: Read files\nGuidelines:';
        const result = appendToolsListPrompt(
            defaultPrompt,
            [{ name: 'bash', description: 'Run commands' }],
        );
        expect(result).toBe(defaultPrompt);
    });
});

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe('context-send command', () => {
    it('requests source-aware Markdown rewriting before sending files', async () => {
        const root = mkdtempSync(join(tmpdir(), 'context-send-markdown-'));
        temporaryDirectories.push(root);
        const nested = join(root, 'nested');
        mkdirSync(nested);
        const agentsPath = join(root, 'AGENTS.md');
        writeFileSync(agentsPath, 'Read [guide](guide.md)');
        writeFileSync(join(root, 'guide.md'), 'guide');
        const commands = new Map<string, (args: string, context: any) => unknown>();
        const sentMessages: Array<{ content: string }> = [];
        const events = createEventBus();
        const pi = {
            events,
            on: mock(() => {}),
            registerCommand(
                name: string,
                command: { handler: (args: string, context: any) => unknown },
            ) {
                commands.set(name, command.handler);
            },
            sendMessage(message: { content: string }) {
                sentMessages.push(message);
            },
        };
        events.on(MARKDOWN_LINKS_TRANSFORM_EVENT, (value) => {
            if (!isMarkdownLinkTransformRequest(value)) return;
            if (value.sourcePath !== agentsPath) return;
            expect(value.sourceKind).toBe('context-send-command');
            value.result = `Read [guide](${join(root, 'guide.md')})`;
        });
        contextExtension(pi as unknown as ExtensionAPI);

        await commands.get('context-send')?.('', { cwd: nested });

        expect(sentMessages.at(-1)?.content).toContain(
            `Read [guide](${join(root, 'guide.md')})`,
        );
    });
});

describe('buildContextSendMessage', () => {
    it('should render a directive plus one fenced block per file', () => {
        const files = [
            {
                path: '/home/user/.pi/agent/AGENTS.md',
                content: '# Rules\n- be concise',
            },
            {
                path: '/home/user/.pi/proj/AGENTS.md',
                content: '# Proj\n- use bun',
            },
        ];
        const result = buildContextSendMessage(files);
        expect(result).toContain('Read and follow');
        expect(result).toBe(
            'Read and follow these project instruction files. They take precedence for this repository.\n\n<project_instructions path="/home/user/.pi/agent/AGENTS.md">\n# Rules\n- be concise\n</project_instructions>\n\n<project_instructions path="/home/user/.pi/proj/AGENTS.md">\n# Proj\n- use bun\n</project_instructions>\n',
        );
    });

    it('should return empty string when no files', () => {
        expect(buildContextSendMessage([])).toBe('');
    });

    it('should preserve file order', () => {
        const files = [
            {
                path: '/a/AGENTS.md',
                content: 'first',
            },
            {
                path: '/b/AGENTS.md',
                content: 'second',
            },
        ];
        const result = buildContextSendMessage(files);
        const firstIdx = result.indexOf('first');
        const secondIdx = result.indexOf('second');
        expect(firstIdx).toBeGreaterThan(-1);
        expect(secondIdx).toBeGreaterThan(firstIdx);
    });
});

describe('getSkillPathFromCommand', () => {
    it('should return the sourceInfo.path for a skill command', () => {
        const cmd = {
            name: 'skill:my-skill',
            source: 'skill',
            sourceInfo: {
                path: '/home/user/.pi/agent/skills/my-skill/SKILL.md',
            },
        };
        expect(getSkillPathFromCommand(cmd)).toBe(
            '/home/user/.pi/agent/skills/my-skill/SKILL.md',
        );
    });

    it('should return empty string when sourceInfo is missing', () => {
        const cmd = {
            name: 'skill:my-skill',
            source: 'skill',
            // no sourceInfo
        };
        expect(getSkillPathFromCommand(cmd)).toBe('');
    });

    it('should return empty string when sourceInfo.path is missing', () => {
        const cmd = {
            name: 'skill:my-skill',
            source: 'skill',
            sourceInfo: {},
        };
        expect(getSkillPathFromCommand(cmd)).toBe('');
    });

    it('should return empty string for non-skill commands', () => {
        const cmd = {
            name: 'cmd1',
            source: 'extension',
            sourceInfo: { path: '/some/path.ts' },
        };
        expect(getSkillPathFromCommand(cmd)).toBe('');
    });
});
