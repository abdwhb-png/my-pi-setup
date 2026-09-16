import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
    createEventBus,
    type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
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
} from './index.ts';

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
            italic: (text: string) => text,
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
        expect(atEnd).toContain('tool-20');
        expect(renderRequests).toBe(2);

        view.handleInput('\x1b[57424u');
        expect(renderRequests).toBe(2);

        const narrowMax = Number(atEnd.match(/\[\d+\/(\d+)↑↓\]/)?.[1]);
        expect(Number.isFinite(narrowMax)).toBe(true);

        const wideAtEnd = view.render(120).join('\n');
        const wideMax = Number(wideAtEnd.match(/\[\d+\/(\d+)↑↓\]/)?.[1]);
        expect(wideMax).toBeLessThan(narrowMax);
        expect(wideAtEnd).toContain(`[${wideMax}/${wideMax}↑↓]`);

        const narrowAgain = view.render(48).join('\n');
        expect(narrowAgain).toContain(`[${wideMax}/${narrowMax}↑↓]`);

        view.handleInput('\x1b[57424u');
        expect(renderRequests).toBe(3);
        expect(view.render(48).join('\n')).toContain(
            `[${narrowMax}/${narrowMax}↑↓]`,
        );
    });

    it('renders framed sections with visually distinct active tools', () => {
        const colorCalls: Array<{ color: string; text: string }> = [];
        const tui = {
            terminal: { rows: 32 },
            requestRender: () => undefined,
        };
        const theme = {
            fg: (color: string, text: string) => {
                colorCalls.push({ color, text });
                return ['primary', 'text', 'warning'].includes(color)
                    ? `\u001b[36m${text}\u001b[0m`
                    : text;
            },
            bold: (text: string) => text,
            italic: (text: string) => text,
        };
        const view = new ContextView(
            tui as never,
            theme as never,
            {
                usage: null,
                model: {
                    id: 'gpt-test',
                    provider: 'openai',
                    thinkingLevel: 'high',
                },
                agentFiles: ['AGENTS.md'],
                extensions: ['context.ts'],
                tools: ['edit', '工具😀工具😀工具😀', 'write'],
                toolCatalogStatus: [
                    { label: 'Tool catalog', value: 'runtime schemas' },
                ],
                skills: ['tdd'],
                loadedSkills: [],
                session: { totalTokens: 42, totalCost: 0.01 },
            },
            () => {},
        );

        const rendered = view.render(80);
        const output = rendered.join('\n');

        expect(rendered[0]).toMatch(/^╭/);
        expect(rendered.at(-1)).toMatch(/^╰/);
        expect(rendered.length).toBeLessThanOrEqual(tui.terminal.rows);
        expect(rendered.every((line) => visibleWidth(line) <= 76)).toBe(true);

        const contextIndex = output.indexOf('CONTEXT WINDOW');
        const sessionIndex = output.indexOf('SESSION');
        const sourcesIndex = output.indexOf('SOURCES');
        const toolsIndex = output.indexOf('TOOLS');
        expect(contextIndex).toBeGreaterThan(-1);
        expect(sessionIndex).toBeGreaterThan(contextIndex);
        expect(sourcesIndex).toBeGreaterThan(sessionIndex);
        expect(toolsIndex).toBeGreaterThan(sourcesIndex);
        expect(output.indexOf('Tool catalog:')).toBeGreaterThan(toolsIndex);
        expect(output.indexOf('runtime schemas')).toBeGreaterThan(toolsIndex);
        expect(output).toContain('Active (3, alphabetical):');
        expect(output).toContain('工具😀');
        expect(colorCalls).toContainEqual({ color: 'accent', text: 'TOOLS' });
        expect(colorCalls).toContainEqual({ color: 'text', text: 'tdd' });

        tui.terminal.rows = 8;
        const compact = view.render(80);
        expect(compact.length).toBeLessThanOrEqual(tui.terminal.rows);
        expect(compact[0]).toMatch(/^╭/);
        expect(compact.at(-1)).toMatch(/^╰/);
        expect(compact.some((line) => line.includes('CONTEXT WINDOW'))).toBe(
            true,
        );
    });

    it('toggles tool ordering between alphabetical and runtime order', () => {
        let renderRequests = 0;
        const tui = {
            terminal: { rows: 32 },
            requestRender: () => {
                renderRequests++;
            },
        };
        const theme = {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
            italic: (text: string) => text,
        };
        const view = new ContextView(
            tui as never,
            theme as never,
            {
                usage: null,
                model: null,
                agentFiles: [],
                extensions: [],
                tools: ['alpha', 'mango', 'zebra'],
                runtimeTools: ['zebra', 'alpha', 'mango'],
                toolCatalogStatus: [],
                skills: [],
                loadedSkills: [],
                session: { totalTokens: 0, totalCost: 0 },
            },
            () => {},
        );

        const alphabetical = view.render(100).join('\n');
        expect(alphabetical).toContain(
            'Active (3, alphabetical): alpha, mango, zebra',
        );
        expect(alphabetical).toContain('o: runtime order');

        view.handleInput('o');
        expect(renderRequests).toBe(1);
        const runtime = view.render(100).join('\n');
        expect(runtime).toContain('Active (3, runtime): zebra, alpha, mango');
        expect(runtime).toContain('o: alphabetical order');

        view.handleInput('o');
        expect(renderRequests).toBe(2);
        expect(view.render(100).join('\n')).toContain(
            'Active (3, alphabetical): alpha, mango, zebra',
        );
    });

    it('clamps stale scroll after terminal resize', () => {
        let renderRequests = 0;
        const tui = {
            terminal: { rows: 8 },
            requestRender: () => {
                renderRequests++;
            },
        };
        const theme = {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
            italic: (text: string) => text,
        };
        const view = new ContextView(
            tui as never,
            theme as never,
            {
                usage: null,
                model: null,
                agentFiles: ['配置😀'.repeat(10)],
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

        const compact = view.render(48);
        expect(compact[0]).toMatch(/^╭/);
        expect(compact.at(-1)).toMatch(/^╰/);
        expect(compact.every((line) => visibleWidth(line) <= 44)).toBe(true);

        view.handleInput('\x1b[57424u');
        expect(renderRequests).toBe(1);

        tui.terminal.rows = 500;
        const expanded = view.render(48);
        expect(expanded[0]).toMatch(/^╭/);
        expect(expanded.at(-1)).toMatch(/^╰/);
        expect(expanded.some((line) => line.includes('SESSION'))).toBe(true);

        view.handleInput('\x1b[57424u');
        expect(renderRequests).toBe(1);
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
    it('leaves provider prompt mutation to the finalizer', () => {
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

        expect(beforeAgentStartHandlers).toHaveLength(0);
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
                            italic: (text: string) => text,
                        },
                        undefined,
                        () => undefined,
                    );
                    rendered = view.render(120).join('\n');
                },
            },
        };

        await commands.get('context')?.handler('', context);

        expect(rendered).toContain('TOOLS');
        expect(rendered).toContain(
            'Active (3, alphabetical): edit, safe_bash, write',
        );
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
