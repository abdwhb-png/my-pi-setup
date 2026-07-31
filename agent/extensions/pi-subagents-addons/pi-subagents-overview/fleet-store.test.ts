import { describe, expect, it } from 'bun:test';
import { LiveRunStore } from './fleet-store.ts';

describe('LiveRunStore', () => {
    it('reconciles a known async run without using the opaque fleet key for control', () => {
        const store = new LiveRunStore({ now: () => 2_000 });
        store.ingestAsyncStarted({
            id: 'async-1',
            asyncDir: '/tmp/subagent-async-1',
            agent: 'worker',
            goal: 'Implement the feature',
        });
        store.setFleetStatus({
            version: 1,
            entries: [
                {
                    key: 'fleet-opaque-1',
                    agent: 'worker',
                    goal: 'Implement the feature',
                    startedAt: 2_000,
                    tokens: { input: 10, output: 5, total: 15 },
                },
                {
                    key: 'fleet-opaque-2',
                    agent: 'reviewer',
                    goal: 'Review another change',
                    startedAt: 2_100,
                    tokens: { input: 3, output: 1, total: 4 },
                },
            ],
            totalActive: 2,
            omitted: 0,
        });

        const snapshot = store.snapshot();
        expect(snapshot.runs).toHaveLength(2);
        expect(snapshot.runs[0]).toMatchObject({
            source: 'async',
            id: 'async-1',
            controlId: 'async-1',
            controllable: true,
            tokens: { input: 10, output: 5, total: 15 },
        });
        expect(snapshot.runs[1]).toMatchObject({
            source: 'fleet',
            key: 'fleet-opaque-2',
            controllable: false,
        });
        expect(snapshot.runs[1]).not.toHaveProperty('controlId');
    });

    it('keeps an opaque fleet row when matching it to an async run would be ambiguous', () => {
        const store = new LiveRunStore({ now: () => 2_000 });
        for (const id of ['async-1', 'async-2']) {
            store.ingestAsyncStarted({
                id,
                asyncDir: `/tmp/${id}`,
                agent: 'worker',
                goal: 'Same goal',
            });
        }
        store.setFleetStatus({
            version: 1,
            entries: [
                {
                    key: 'fleet-opaque',
                    agent: 'worker',
                    goal: 'Same goal',
                    startedAt: 2_000,
                    tokens: { input: 0, output: 0, total: 0 },
                },
            ],
            totalActive: 1,
            omitted: 0,
        });

        const snapshot = store.snapshot();
        expect(snapshot.runs).toHaveLength(3);
        expect(snapshot.runs.filter((run) => run.source === 'async')).toHaveLength(2);
        expect(snapshot.runs.find((run) => run.source === 'fleet')).toMatchObject({
            key: 'fleet-opaque',
            controllable: false,
        });
    });

    it('keeps a completed async run in session history and disables controls', () => {
        const store = new LiveRunStore({ now: () => 2_000 });
        store.ingestAsyncStarted({
            id: 'async-1',
            asyncDir: '/tmp/subagent-async-1',
            agent: 'worker',
            goal: 'Implement the feature',
        });

        store.ingestAsyncComplete({
            runId: 'async-1',
            success: true,
            summary: 'Implementation complete',
            timestamp: 2_500,
        });

        expect(store.snapshot().runs[0]).toMatchObject({
            source: 'async',
            id: 'async-1',
            state: 'complete',
            controllable: false,
            completedAt: 2_500,
            summary: 'Implementation complete',
        });
    });

    it('clears session history and notifies subscribers on reset', () => {
        const store = new LiveRunStore();
        let updates = 0;
        const unsubscribe = store.subscribe(() => updates++);
        store.ingestAsyncStarted({
            id: 'async-1',
            asyncDir: '/tmp/subagent-async-1',
            agent: 'worker',
        });

        store.reset();
        unsubscribe();

        expect(store.snapshot()).toMatchObject({
            runs: [],
            fleetAvailable: false,
            totalActive: 0,
            omitted: 0,
        });
        expect(updates).toBe(2);
    });

    it('projects trusted artifact progress into a known async run', () => {
        const store = new LiveRunStore();
        store.ingestAsyncStarted({
            id: 'async-1',
            asyncDir: '/tmp/subagent-async-1',
            agent: 'worker',
        });

        store.updateAsyncArtifacts('async-1', {
            state: 'running',
            currentTool: 'bash',
            activity: 'Running tests',
            model: 'provider/model',
            effort: 'high',
            tokens: { input: 40, output: 10, total: 50 },
            transcript: 'latest output',
        });

        expect(store.snapshot().runs[0]).toMatchObject({
            source: 'async',
            currentTool: 'bash',
            activity: 'Running tests',
            model: 'provider/model',
            effort: 'high',
            tokens: { input: 40, output: 10, total: 50 },
            transcript: 'latest output',
        });
    });
});
