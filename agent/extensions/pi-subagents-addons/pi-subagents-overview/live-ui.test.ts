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
});

describe('SubagentsOverviewView live tab', () => {
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

        expect(live).toContain('Catalog  [Live]');
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
