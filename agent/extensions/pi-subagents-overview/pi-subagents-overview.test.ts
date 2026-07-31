import { describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type {
    ExtensionAPI,
    ExtensionCommandContext,
    Theme,
} from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { resolveToolAliases } from '../_shared/tool-groups/resolver';
import registerSubagentsOverview from './index';
import { AgentDetailView, icon, SubagentsOverviewView } from './ui';

const HOME = homedir();
const EXAMPLE_SETTINGS_PATH = path.resolve(
    import.meta.dir,
    '../../settings.example.json',
);

const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    inverse: (text: string) => text,
    underline: (text: string) => text,
} as unknown as Theme;

function parseFrontmatterSimple(raw: string): Record<string, string> | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
    if (!match) return null;
    const yaml = match[1];
    const result: Record<string, string> = {};
    for (const line of yaml.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim();
        const val = line.slice(colonIdx + 1).trim();
        result[key] = val;
    }
    return result;
}

// Render function for testing truncation - at module scope to avoid unicorn warning
function renderLine(line: string, width: number): string {
    if (line.length <= width) return line;
    return line.substring(0, width - 1) + '…';
}

describe('pi-subagents-overview', () => {
    describe('overview rendering', () => {
        it('keeps every row of the inner banner at the same width', async () => {
            type CommandHandler = (
                args: string,
                ctx: ExtensionCommandContext,
            ) => void | Promise<void>;
            const handlers = new Map<string, CommandHandler>();
            const pi = {
                events: { on: () => {}, emit: () => {} },
                registerMessageRenderer: () => {},
                on: () => {},
                registerCommand: (
                    name: string,
                    command: { handler: CommandHandler },
                ) => handlers.set(name, command.handler),
            } as unknown as ExtensionAPI;
            registerSubagentsOverview(pi);

            const handler = handlers.get('subagents-overview');
            expect(handler).toBeDefined();

            const log = spyOn(console, 'log').mockImplementation(() => {});
            let overview = '';
            try {
                await handler?.('', {
                    hasUI: false,
                } as unknown as ExtensionCommandContext);
                overview = String(log.mock.calls[0]?.[0] ?? '');
            } finally {
                log.mockRestore();
            }

            const bannerRows = overview.split('\n').slice(0, 3);

            expect(bannerRows.map(visibleWidth)).toEqual([60, 60, 60]);
        });

        it.each([
            [
                'overview',
                () =>
                    new SubagentsOverviewView({
                        theme,
                        content: Array.from(
                            { length: 30 },
                            (_, index) => `Agent row ${index}`,
                        ).join('\n'),
                        done: () => {},
                    }),
            ],
            [
                'detail',
                () =>
                    new AgentDetailView({
                        theme,
                        content: Array.from(
                            { length: 25 },
                            (_, index) => `Detail row ${index}`,
                        ).join('\n'),
                        agentName: 'worker',
                        done: () => {},
                    }),
            ],
        ])('renders one scroll counter in the %s footer', (_name, createView) => {
            const output = createView().render(80);
            const footer = output.at(-1) ?? '';
            const scrollCounters = footer.match(/\[\d+\/\d+↑↓\]/g) ?? [];

            expect(scrollCounters).toHaveLength(1);
            expect(output.every((line) => visibleWidth(line) === 76)).toBe(
                true,
            );
        });
    });

    describe('readOverrides', () => {
        it('finds agents with overrides in settings.json', () => {
            const raw = fs.readFileSync(EXAMPLE_SETTINGS_PATH, 'utf-8');
            const parsed = JSON.parse(raw);
            const overrides = parsed?.subagents?.agentOverrides ?? {};
            const agentNames = Object.keys(overrides);
            expect(agentNames.length).toBeGreaterThan(0);
        });

        it('worker override resolves to safe_bash without raw bash', () => {
            const raw = fs.readFileSync(EXAMPLE_SETTINGS_PATH, 'utf-8');
            const parsed = JSON.parse(raw);
            const overrides = parsed?.subagents?.agentOverrides ?? {};
            const workerTools = overrides.worker?.tools;
            expect(Array.isArray(workerTools)).toBe(true);
            expect(workerTools).not.toContain('bash');

            const groupsPath = path.join(HOME, '.pi', 'agent', 'tool-groups.json');
            const groups = JSON.parse(fs.readFileSync(groupsPath, 'utf8')).groups;
            const available = [
                ...new Set(
                    [...Object.values(groups).flat(), ...workerTools].filter(
                        (tool): tool is string =>
                            typeof tool === 'string' && !tool.startsWith('@'),
                    ),
                ),
            ];
            const result = resolveToolAliases(workerTools, available, groups);
            expect(result.diagnostics).toEqual([]);
            expect(result.names).toContain('safe_bash');
        });

        it('scout override tools are valid', () => {
            const raw = fs.readFileSync(EXAMPLE_SETTINGS_PATH, 'utf-8');
            const parsed = JSON.parse(raw);
            const overrides = parsed?.subagents?.agentOverrides ?? {};
            const scoutTools = overrides.scout?.tools;
            expect(Array.isArray(scoutTools)).toBe(true);
            expect(scoutTools).not.toContain('bash');
        });

        it('all override tools are arrays', () => {
            const raw = fs.readFileSync(EXAMPLE_SETTINGS_PATH, 'utf-8');
            const parsed = JSON.parse(raw);
            const overrides = parsed?.subagents?.agentOverrides ?? {};
            for (const [name, ov] of Object.entries(overrides)) {
                const agent = ov as { tools?: string[] | false } | undefined;
                if (agent?.tools !== undefined && agent.tools !== false) {
                    expect(
                        Array.isArray(agent.tools),
                        `${name}.tools should be array`,
                    ).toBe(true);
                }
            }
        });
    });

    describe('parseBuiltinAgents', () => {
        const builtinNames = [
            'scout',
            'researcher',
            'planner',
            'worker',
            'reviewer',
            'context-builder',
            'oracle',
            'delegate',
        ];
        const BUILTIN_AGENTS_DIR = path.join(
            HOME,
            '.pi',
            'agent',
            'npm',
            'node_modules',
            'pi-subagents',
            'agents',
        );

        it.each(builtinNames)('parses %s.md with frontmatter', (agentName) => {
            const filePath = path.join(BUILTIN_AGENTS_DIR, `${agentName}.md`);
            expect(fs.existsSync(filePath)).toBe(true);
            const raw = fs.readFileSync(filePath, 'utf-8');
            const fm = parseFrontmatterSimple(raw);
            expect(fm).not.toBeNull();
            expect(fm!.name).toBe(agentName);
            expect(fm!.description).toBeTruthy();
            expect(fm!.tools).toBeTruthy();
        });
    });

    describe('renderer truncation', () => {
        it('truncates long lines to width', () => {
            const longLine = 'a'.repeat(100);
            const truncated = renderLine(longLine, 70);
            expect(truncated.length).toBeLessThanOrEqual(70);
        });

        it('leaves short lines unchanged', () => {
            const shortLine = 'short line';
            const unchanged = renderLine(shortLine, 70);
            expect(unchanged).toBe(shortLine);
        });
    });

    describe('videographer agent', () => {
        const filePath = path.join(
            HOME,
            '.pi',
            'agent',
            'agents',
            'videographer.md',
        );

        it('videographer.md file exists', () => {
            expect(fs.existsSync(filePath)).toBe(true);
        });

        it('videographer.md has valid frontmatter', () => {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const fm = parseFrontmatterSimple(raw);
            expect(fm).not.toBeNull();
            expect(fm!.name).toBe('videographer');
            expect(fm!.description).toBeTruthy();
            expect(fm!.tools).toBeTruthy();
        });
    });

    describe('widget line formatting', () => {
        it('widget line does not exceed reasonable length', () => {
            const raw = fs.readFileSync(EXAMPLE_SETTINGS_PATH, 'utf-8');
            const parsed = JSON.parse(raw);
            const overrides = parsed?.subagents?.agentOverrides ?? {};
            const overrideCount = Object.keys(overrides).length;

            const BUILTIN_AGENTS_DIR = path.join(
                HOME,
                '.pi',
                'agent',
                'npm',
                'node_modules',
                'pi-subagents',
                'agents',
            );
            const builtinCount = fs
                .readdirSync(BUILTIN_AGENTS_DIR)
                .filter((f) => f.endsWith('.md')).length;
            const userAgentsDir = path.join(HOME, '.pi', 'agent', 'agents');
            const userCount = fs.existsSync(userAgentsDir)
                ? fs.readdirSync(userAgentsDir).filter((f) => f.endsWith('.md'))
                      .length
                : 0;

            const parts: string[] = [];
            parts.push(`${icon} Subagents: ${builtinCount}B/${userCount}U`);
            if (overrideCount > 0) parts.push(`${overrideCount} ovr`);
            parts.push(`total ${builtinCount + userCount}`);

            const widgetLine = parts.join(' · ');
            expect(widgetLine.length).toBeLessThan(120);
        });
    });
});
