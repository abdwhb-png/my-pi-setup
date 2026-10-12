import { afterAll, describe, expect, it, mock, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
    ExtensionAPI,
    ExtensionCommandContext,
    Theme,
} from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { resolveToolAliases } from '../../_shared/tool-groups/resolver';
import { fileURLToPath } from 'node:url';
import { AgentDetailView, SubagentsOverviewView } from './ui';

const realOs = { ...os };
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'subagents-overview-'));
afterAll(async () => {
    try {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await mock.module('node:os', () => realOs);
    } finally {
        fs.rmSync(fixtureHome, { recursive: true, force: true });
    }
});
await mock.module('node:os', () => ({ ...realOs, homedir: () => fixtureHome }));
const fixtureAgentDir = path.join(fixtureHome, '.pi', 'agent');
fs.mkdirSync(fixtureAgentDir, { recursive: true });
fs.writeFileSync(path.join(fixtureAgentDir, 'settings.json'), JSON.stringify({ packages: [path.dirname(fileURLToPath(import.meta.resolve('pi-subagents')))] }));
process.env.PI_CODING_AGENT_DIR = fixtureAgentDir;
const { default: registerSubagentsOverview } = await import('./index');
const userAgentsDir = path.join(fixtureHome, '.pi', 'agent', 'agents');
fs.mkdirSync(userAgentsDir, { recursive: true });
const EXAMPLE_SETTINGS_PATH = path.resolve(
    import.meta.dir,
    '../../../settings.example.json',
);

const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    inverse: (text: string) => text,
    underline: (text: string) => text,
} as unknown as Theme;

it("shows native discovery failures in the interactive catalog details", () => {
    const data = {
        agents: [{name:"broken", description:"Fixture", tools:[], model:"inherited", skills:[], source:"user" as const, context:null, overrideFields:[], discoveryError:"Fixture missing group"}],
        overrides: [],
        stats: {builtinCount:0, userCount:1, safeBashAgents:[], plainBashAgents:[], skillCount:0},
    };
    const view = new SubagentsOverviewView({theme, data, done:()=>{}, getTerminalRows:()=>40});
    const text = view.render(120).join("\n");
    expect(text).toContain("Fixture missing group");
    expect(text).toContain("Unavailable");
    expect(text).not.toContain("Tools: —");
});

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
        it('uses one composed framed-box title and keeps every overlay row aligned', async () => {
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

            let output: string[] = [];
            await handlers.get('subagents-overview')?.('', {
                cwd: fixtureHome, isProjectTrusted: () => false,
                mode: 'tui',
                hasUI: true,
                ui: {
                    custom: async (
                        factory: (
                            tui: { requestRender: () => void },
                            theme: Theme,
                            keybindings: unknown,
                            done: () => void,
                        ) => { render: (width: number) => string[] },
                    ) => {
                        const view = factory(
                            { requestRender: () => {} },
                            theme,
                            {},
                            () => {},
                        );
                        output = view.render(80);
                    },
                },
            } as unknown as ExtensionCommandContext);

            expect(
                output.filter((line) => line.includes('Subagents Overview')),
            ).toHaveLength(1);
            expect(output.every((line) => visibleWidth(line) === 76)).toBe(
                true,
            );
            expect(output.join('\n')).not.toContain('\x1b[');
        });

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
                    cwd: fixtureHome, isProjectTrusted: () => false,
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

    describe('keyboard input', () => {
        it.each([
            [
                'overview',
                (done: () => void) =>
                    new SubagentsOverviewView({
                        theme,
                        content: 'Overview',
                        done,
                    }),
            ],
            [
                'detail',
                (done: () => void) =>
                    new AgentDetailView({
                        theme,
                        content: 'Details',
                        agentName: 'worker',
                        done,
                    }),
            ],
        ])('closes the %s view on Kitty-protocol Escape', (_name, createView) => {
            let closed = false;
            const view = createView(() => {
                closed = true;
            });

            view.handleInput('\x1b[27u');

            expect(closed).toBe(true);
        });

        it.each([
            [
                'overview',
                (requestRender: () => void) =>
                    new SubagentsOverviewView({
                        theme,
                        content: Array.from(
                            { length: 40 },
                            (_, index) => `Overview row ${index}`,
                        ).join('\n'),
                        done: () => {},
                        requestRender,
                    }),
            ],
            [
                'detail',
                (requestRender: () => void) =>
                    new AgentDetailView({
                        theme,
                        content: Array.from(
                            { length: 40 },
                            (_, index) => `Detail row ${index}`,
                        ).join('\n'),
                        agentName: 'worker',
                        done: () => {},
                        requestRender,
                    }),
            ],
        ])(
            'scrolls the %s view with Kitty navigation keys and requests rendering',
            (_name, createView) => {
                let renderRequests = 0;
                const view = createView(() => {
                    renderRequests++;
                });

                expect(view.render(80).at(-1)).toContain('[0/');

                view.handleInput('\x1b[57420u');
                expect(view.render(80).at(-1)).toContain('[1/');

                view.handleInput('\x1b[57422u');
                expect(view.render(80).at(-1)).toContain('[11/');

                view.handleInput('\x1b[57419u');
                expect(view.render(80).at(-1)).toContain('[10/');

                view.handleInput('\x1b[57421u');
                expect(view.render(80).at(-1)).toContain('[0/');
                expect(renderRequests).toBe(4);
            },
        );
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

            const groupsPath = path.resolve(import.meta.dir, '../../../config/tool-groups.json');
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
            'worker',
            'reviewer',
            'oracle',
            'delegate',
        ];
        const BUILTIN_AGENTS_DIR = path.join(
            path.dirname(fileURLToPath(import.meta.resolve('pi-subagents'))),
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

    describe('personal agent discovery', () => {
        it('renders an empty agent directory and subsequent customized definitions', async () => {
            type CommandHandler = (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
            const handlers = new Map<string, CommandHandler>();
            const pi = {
                events: { on: () => {}, emit: () => {} },
                registerMessageRenderer: () => {},
                on: () => {},
                registerCommand: (name: string, command: { handler: CommandHandler }) => handlers.set(name, command.handler),
            } as unknown as ExtensionAPI;
            registerSubagentsOverview(pi);
            const handler = handlers.get('subagents-overview');
            if (!handler) throw new Error('Overview command missing');
            const ctx = { cwd: fixtureHome, isProjectTrusted: () => false, hasUI: false } as ExtensionCommandContext;
            const log = spyOn(console, 'log').mockImplementation(() => {});
            const filePath = path.join(userAgentsDir, 'custom-role.md');
            try {
                await handler('', ctx);
                expect(log.mock.calls.at(-1)?.[0]).toContain('No user agents configured.');
                for (const [name, description, tools, body] of [
                    ['custom-reviewer', 'Inspect my application', 'read, grep', 'My preferred review instructions.'],
                    ['custom-planner', 'Prepare a rollout', 'find, safe_bash', 'Entirely revised instructions from agent-sync.'],
                ]) {
                    fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\ntools: ${tools}\n---\n${body}\n`);
                    await handler('', ctx);
                    const output = String(log.mock.calls.at(-1)?.[0] ?? '');
                    expect(output).toContain(name);
                    expect(output).toContain(description);
                    expect(output).toContain(tools);
                    expect(output).not.toContain('No user agents configured.');
                }
                fs.unlinkSync(filePath);
                await handler('', ctx);
                expect(log.mock.calls.at(-1)?.[0]).toContain('No user agents configured.');
            } finally {
                log.mockRestore();
                fs.rmSync(filePath, { force: true });
            }
        });
    });
});
