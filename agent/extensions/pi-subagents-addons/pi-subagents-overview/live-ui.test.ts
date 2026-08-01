import { describe, expect, it } from 'bun:test';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { LiveRunSnapshot } from './fleet-store.ts';
import { hasVisibleLiveRuns, renderLiveWidget } from './live-ui.ts';
import { SubagentsOverviewView } from './ui.ts';

const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    inverse: (text: string) => text,
    underline: (text: string) => text,
} as unknown as Theme;

const overviewData = {
    agents: [
        {
            name: 'worker',
            description: 'Implements focused tasks',
            tools: ['read', 'edit'],
            model: 'inherit',
            skills: [],
            source: 'builtin' as const,
            context: 'fork',
            overrideFields: [],
        },
        {
            name: 'reviewer',
            description: 'Reviews completed work',
            tools: ['read'],
            model: 'review-model',
            skills: ['caveman-review'],
            source: 'user' as const,
            context: null,
            overrideFields: [{ label: 'model', value: 'review-model' }],
        },
    ],
    overrides: [
        {
            agentName: 'reviewer',
            fields: [{ label: 'model', value: 'review-model' }],
        },
    ],
    stats: {
        builtinCount: 1,
        userCount: 1,
        safeBashAgents: ['worker'],
        plainBashAgents: [],
        skillCount: 1,
    },
};

describe('renderLiveWidget', () => {
    it('renders at most five fully closed rows and reports overflow', () => {
        const snapshot: LiveRunSnapshot = {
            fleetAvailable: true,
            totalActive: 6,
            omitted: 1,
            runs: Array.from({ length: 5 }, (_, index) => ({
                source: 'fleet' as const,
                key: `fleet-${index}`,
                agent: `worker-${index}`,
                goal: `Handle task ${index}`,
                startedAt: 1_000 + index,
                tokens: { input: 100, output: 20, total: 120 },
                state: 'active' as const,
                controllable: false as const,
            })),
        };

        const output = renderLiveWidget(snapshot, theme, 60, 5_000);

        expect(output).toHaveLength(5);
        expect(output.every((line) => visibleWidth(line) === 60)).toBe(true);
        expect(output[0]).toMatch(/^╭.*╮$/);
        expect(output.at(-1)).toMatch(/^╰.*\+3.*╯$/);
        expect(output.slice(1, -1).every((line) => /^│.*│$/.test(line))).toBe(
            true,
        );
    });

    it('keeps a completed run visible for exactly five seconds', () => {
        const snapshot: LiveRunSnapshot = {
            fleetAvailable: true,
            totalActive: 0,
            omitted: 0,
            runs: [
                {
                    source: 'async',
                    key: 'async:async-1',
                    id: 'async-1',
                    controlId: 'async-1',
                    asyncDir: '/tmp/async-1',
                    agent: 'worker',
                    startedAt: 1_000,
                    completedAt: 2_000,
                    tokens: { input: 1, output: 1, total: 2 },
                    state: 'complete',
                    controllable: false,
                },
            ],
        };

        expect(hasVisibleLiveRuns(snapshot, 7_000)).toBe(true);
        expect(hasVisibleLiveRuns(snapshot, 7_001)).toBe(false);
    });

    it('never renders wider than the available narrow widget width', () => {
        const snapshot: LiveRunSnapshot = {
            fleetAvailable: true,
            totalActive: 1,
            omitted: 0,
            runs: [
                {
                    source: 'fleet',
                    key: 'fleet-1',
                    agent: 'worker-with-a-long-name',
                    goal: 'A long goal that must be truncated',
                    startedAt: 1_000,
                    tokens: { input: 100, output: 20, total: 120 },
                    state: 'active',
                    controllable: false,
                },
            ],
        };

        const output = renderLiveWidget(snapshot, theme, 12, 5_000);

        expect(output.length).toBeGreaterThan(0);
        expect(output.every((line) => visibleWidth(line) === 12)).toBe(true);
    });
});

describe('SubagentsOverviewView live tab', () => {
    it('cycles focus through agents, details, and live while scrolling only the focused panel', () => {
        const view = new SubagentsOverviewView({
            theme,
            data: overviewData,
            done: () => {},
            getTerminalRows: () => 14,
            getLiveSnapshot: () => ({
                fleetAvailable: true,
                totalActive: 0,
                omitted: 0,
                runs: [],
            }),
        });

        expect(view.render(100).join('\n')).toContain('▸ AGENTS');

        view.handleInput('\t');
        const details = view.render(100).join('\n');
        expect(details).toContain('▸ DETAILS');
        expect(details).toContain('Implements focused tasks');

        view.handleInput('\x1b[B');
        expect(view.render(100).join('\n')).not.toBe(details);
        expect(view.render(100).join('\n')).toContain('▸ DETAILS');

        view.handleInput('\x1b[9u');
        expect(view.render(100).join('\n')).toContain('▸ LIVE');
        view.handleInput('\x1b[9u');
        expect(view.render(100).join('\n')).toContain('▸ AGENTS');

        view.handleInput('\x1b[C');
        expect(view.render(100).join('\n')).toContain('▸ DETAILS');
        view.handleInput('\x1b[57418u');
        expect(view.render(100).join('\n')).toContain('▸ LIVE');
        view.handleInput('\x1b[57417u');
        expect(view.render(100).join('\n')).toContain('▸ DETAILS');
        view.handleInput('\x1b[D');
        expect(view.render(100).join('\n')).toContain('▸ AGENTS');
    });

    it('renders a responsive catalog with fixed tabs and composed agent/detail panels', () => {
        const config = {
            theme,
            content: 'Legacy catalog',
            data: overviewData,
            done: () => {},
            getTerminalRows: () => 40,
        };
        const view = new SubagentsOverviewView(config);

        const initial = view.render(100).join('\n');
        expect(initial).toContain('▸ CATALOG');
        expect(initial).toContain('AGENTS');
        expect(initial).toContain('DETAILS');
        expect(initial).toContain('worker');
        expect(initial).toContain('Implements focused tasks');

        view.handleInput('\x1b[B');
        const selected = view.render(100).join('\n');
        expect(selected).toContain('reviewer');
        expect(selected).toContain('Reviews completed work');
        expect(selected).toContain('Override');

        view.handleInput('\x1b[57419u');
        expect(view.render(100).join('\n')).toContain('Implements focused tasks');
        view.handleInput('\x1b[57420u');
        expect(view.render(100).join('\n')).toContain('Reviews completed work');
    });

    it('uses a single catalog panel on narrow terminals and opens details explicitly', () => {
        const config = {
            theme,
            content: 'Legacy catalog',
            data: overviewData,
            done: () => {},
            getTerminalRows: () => 24,
        };
        const view = new SubagentsOverviewView(config);

        const roster = view.render(54).join('\n');
        expect(roster).toContain('AGENTS');
        expect(roster).not.toContain('Implements focused tasks');

        view.handleInput('\r');
        const detail = view.render(54).join('\n');
        expect(detail).toContain('DETAILS');
        expect(detail).toContain('Implements focused tasks');

        view.handleInput('\x1b[27u');
        expect(view.render(54).join('\n')).toContain('AGENTS');

        view.handleInput('\x1b[13u');
        expect(view.render(54).join('\n')).toContain('DETAILS');
        view.handleInput('\x1b');
        expect(view.render(54).join('\n')).toContain('AGENTS');
    });

    it('caps the overview height from the live terminal row count', () => {
        const config = {
            theme,
            content: Array.from({ length: 40 }, (_, index) => `Legacy row ${index}`).join(
                '\n',
            ),
            data: overviewData,
            done: () => {},
            getTerminalRows: () => 16,
        };
        const view = new SubagentsOverviewView(config);

        expect(view.render(100).length).toBeLessThanOrEqual(13);
    });

    it('falls back without exceeding an extremely short terminal', () => {
        const config = {
            theme,
            content: 'Legacy catalog',
            data: overviewData,
            done: () => {},
            getTerminalRows: () => 6,
        };
        const view = new SubagentsOverviewView(config);

        expect(view.render(100).length).toBeLessThanOrEqual(4);
    });

    it('keeps the narrow-width fallback inside shared closed chrome', () => {
        const view = new SubagentsOverviewView({
            theme,
            content: 'Legacy catalog',
            data: overviewData,
            done: () => {},
            getTerminalRows: () => 24,
        });

        const rendered = view.render(34);
        expect(rendered).toHaveLength(3);
        expect(rendered[0]).toStartWith('╭');
        expect(rendered.at(-1)).toStartWith('╰');
    });

    it('switches from Catalog to Live and explains the native sync fallback', () => {
        const snapshot: LiveRunSnapshot = {
            fleetAvailable: true,
            totalActive: 1,
            omitted: 0,
            runs: [
                {
                    source: 'fleet',
                    key: 'fleet-1',
                    agent: 'worker',
                    goal: 'Foreground task',
                    startedAt: 1_000,
                    tokens: { input: 10, output: 2, total: 12 },
                    state: 'active',
                    controllable: false,
                },
            ],
        };
        const view = new SubagentsOverviewView({
            theme,
            content: 'Catalog content',
            done: () => {},
            requestRender: () => {},
            getLiveSnapshot: () => snapshot,
            now: () => 5_000,
        });

        expect(view.render(80).join('\n')).toContain('[Catalog]  Live');
        view.handleInput('\t');
        const live = view.render(80).join('\n');

        expect(live).not.toContain('Catalog  [Live]');
        expect(live).toContain('worker');
        expect(live).toContain('Ctrl+Alt+F');
    });

    it('opens bounded async detail and gates controls to the trusted async row', () => {
        const actions: string[] = [];
        let snapshot: LiveRunSnapshot = {
            fleetAvailable: true,
            totalActive: 1,
            omitted: 0,
            runs: [
                {
                    source: 'async',
                    key: 'async:async-1',
                    id: 'async-1',
                    controlId: 'async-1',
                    asyncDir: '/tmp/async-1',
                    agent: 'worker',
                    goal: 'Implement safely',
                    startedAt: 1_000,
                    tokens: { input: 10, output: 2, total: 12 },
                    state: 'running',
                    controllable: true,
                    currentTool: 'bash',
                    transcript: 'bounded transcript',
                },
            ],
        };
        const view = new SubagentsOverviewView({
            theme,
            content: 'Catalog content',
            done: () => {},
            getLiveSnapshot: () => snapshot,
            onAction: (action) => {
                actions.push(action);
            },
        });
        view.handleInput('\t');
        for (const key of ['s', 'i', 'x']) view.handleInput(key);
        expect(actions).toEqual(['steer', 'interrupt', 'stop']);

        view.handleInput('\r');
        const detail = view.render(80).join('\n');
        expect(detail).toContain('Current tool: bash');
        expect(detail).toContain('bounded transcript');

        view.handleInput('\r');
        snapshot = {
            ...snapshot,
            runs: [
                {
                    source: 'fleet',
                    key: 'opaque-only',
                    agent: 'worker',
                    startedAt: 1_000,
                    tokens: { input: 10, output: 2, total: 12 },
                    state: 'active',
                    controllable: false,
                },
            ],
        };
        view.handleInput('s');
        expect(actions).toEqual(['steer', 'interrupt', 'stop']);
    });

    it('stops its live refresh timer when disposed', async () => {
        let refreshes = 0;
        const view = new SubagentsOverviewView({
            theme,
            content: 'Catalog content',
            done: () => {},
            getLiveSnapshot: () => ({
                fleetAvailable: false,
                totalActive: 0,
                omitted: 0,
                runs: [],
            }),
            onRefresh: () => {
                refreshes++;
            },
            refreshMs: 5,
        });

        await Bun.sleep(20);
        expect(refreshes).toBeGreaterThan(0);
        view.dispose();
        const afterDispose = refreshes;
        await Bun.sleep(20);
        expect(refreshes).toBe(afterDispose);
    });

    it('reports whether the Live tab, rather than the Catalog overlay, is open', () => {
        const liveVisibility: boolean[] = [];
        const view = new SubagentsOverviewView({
            theme,
            content: 'Catalog content',
            done: () => {},
            getLiveSnapshot: () => ({
                fleetAvailable: false,
                totalActive: 0,
                omitted: 0,
                runs: [],
            }),
            onLiveVisibilityChange: (visible) => liveVisibility.push(visible),
        });

        expect(liveVisibility).toEqual([false]);
        view.handleInput('\t');
        view.handleInput('\t');
        view.dispose();
        expect(liveVisibility).toEqual([false, true, false, false]);
    });
});
