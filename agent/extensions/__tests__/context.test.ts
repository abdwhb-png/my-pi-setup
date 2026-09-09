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
    buildContextSendMessage,
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

describe('custom system prompt tool contract', () => {
    it('injects active tool descriptions and usage guidelines through context.ts', () => {
        const beforeAgentStartHandlers: Array<
            (event: any, context: any) => unknown
        > = [];
        const pi = {
            events: createEventBus(),
            on(event: string, handler: (event: any, context: any) => unknown) {
                if (event === 'before_agent_start') {
                    beforeAgentStartHandlers.push(handler);
                }
            },
            registerCommand: mock(() => {}),
            getAllTools: () => [
                {
                    name: 'think_execute',
                    description: 'Derive a bounded result without exposing raw source',
                    promptGuidelines: [
                        'Use think_execute only when a bounded derivation is needed.',
                        'Keep native tools when exact output must be observed.',
                    ],
                },
            ],
            getActiveTools: () => ['think_execute'],
        };

        contextExtension(pi as unknown as ExtensionAPI);

        expect(beforeAgentStartHandlers).toHaveLength(1);
        const result = beforeAgentStartHandlers[0](
            {
                systemPrompt: 'unchanged custom prompt',
                systemPromptOptions: { customPrompt: 'SYSTEM.md' },
            },
            {},
        ) as { systemPrompt: string };
        expect(result.systemPrompt).toContain('unchanged custom prompt');
        expect(result.systemPrompt).toContain(
            '- think_execute: Derive a bounded result without exposing raw source',
        );
        expect(result.systemPrompt).toContain(
            'Tool usage guidelines:\n- Use think_execute only when a bounded derivation is needed.\n- Keep native tools when exact output must be observed.',
        );
    });
});

describe('/context runtime tool reporting', () => {
    it('renders the active runtime schemas after a role switch', async () => {
        const commands = new Map<
            string,
            { handler: (args: string, context: any) => Promise<void> }
        >();
        const pi = {
            events: createEventBus(),
            on: () => undefined,
            appendEntry: () => undefined,
            registerCommand(
                name: string,
                command: {
                    handler: (args: string, context: any) => Promise<void>;
                },
            ) {
                commands.set(name, command);
            },
            getCommands: () => [],
            getActiveTools: () => ['edit', 'write', 'safe_bash'],
            getAllTools: () => [
                { name: 'edit', description: 'Edit files' },
                { name: 'write', description: 'Write files' },
                { name: 'safe_bash', description: 'Run sandboxed commands' },
            ],
            getThinkingLevel: () => 'high',
        };
        contextExtension(pi as unknown as ExtensionAPI);

        let rendered = '';
        const context = {
            cwd: tmpdir(),
            hasUI: true,
            model: null,
            getSystemPrompt: () => 'custom system prompt',
            getContextUsage: () => null,
            sessionManager: { getEntries: () => [] },
            ui: {
                async custom(
                    factory: (
                        tui: unknown,
                        theme: unknown,
                        keybindings: unknown,
                        done: () => void,
                    ) => ContextView,
                ) {
                    const view = factory(
                        {
                            terminal: { rows: 80 },
                            requestRender: () => undefined,
                        },
                        {
                            fg: (_color: string, text: string) => text,
                            bold: (text: string) => text,
                        },
                        undefined,
                        () => undefined,
                    );
                    rendered = view.render(120).join('\n');
                },
            },
        };

        await commands.get('context')?.handler('', context);

        expect(rendered).toContain('Tools (3): edit, safe_bash, write');
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
