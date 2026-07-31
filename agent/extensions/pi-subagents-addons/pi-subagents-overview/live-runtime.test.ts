import { describe, expect, it } from 'bun:test';
import {
    SUBAGENT_RPC_REPLY_EVENT_PREFIX,
    SUBAGENT_RPC_REQUEST_EVENT,
    type EventBusLike,
} from './rpc-client.ts';
import { SubagentsLiveRuntime } from './live-runtime.ts';

class RuntimeEventBus implements EventBusLike {
    private handlers = new Map<string, Set<(data: unknown) => void>>();
    activeSubscriptions = 0;
    requests: Array<{ method: string; params?: Record<string, unknown> }> = [];

    constructor(private readonly fleetStatusSupported = true) {}

    on(event: string, handler: (data: unknown) => void): () => void {
        const listeners = this.handlers.get(event) ?? new Set();
        listeners.add(handler);
        this.handlers.set(event, listeners);
        this.activeSubscriptions++;
        return () => {
            if (listeners.delete(handler)) this.activeSubscriptions--;
        };
    }

    emit(event: string, data: unknown): void {
        if (event === SUBAGENT_RPC_REQUEST_EVENT) {
            const request = data as {
                requestId: string;
                method: string;
                params?: Record<string, unknown>;
            };
            this.requests.push({ method: request.method, params: request.params });
            const responseData =
                request.method === 'ping'
                    ? {
                          capabilities: this.fleetStatusSupported
                              ? { fleetStatus: { version: 1 } }
                              : {},
                      }
                    : {
                          fleet: {
                              version: 1,
                              entries: [
                                  {
                                      key: 'fleet-1',
                                      agent: 'reviewer',
                                      startedAt: 1_000,
                                      tokens: { input: 2, output: 1, total: 3 },
                                  },
                              ],
                              totalActive: 1,
                              omitted: 0,
                          },
                      };
            queueMicrotask(() =>
                this.emit(`${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${request.requestId}`, {
                    version: 1,
                    requestId: request.requestId,
                    method: request.method,
                    success: true,
                    data: responseData,
                }),
            );
        }
        for (const handler of this.handlers.get(event) ?? []) handler(data);
    }
}

describe('SubagentsLiveRuntime', () => {
    it('negotiates fleetStatus, tracks async lifecycle events, and disposes listeners', async () => {
        const events = new RuntimeEventBus();
        const runtime = new SubagentsLiveRuntime(events);

        await runtime.beginSession('session-1');
        events.emit('subagent:async-started', {
            id: 'async-1',
            sessionId: 'session-1',
            asyncDir: '/tmp/missing-is-safe',
            agent: 'worker',
            goal: 'Implement feature',
            startedAt: 1_100,
        });

        const snapshot = runtime.store.snapshot();
        expect(snapshot.fleetAvailable).toBe(true);
        expect(snapshot.runs.map((run) => run.agent)).toEqual([
            'reviewer',
            'worker',
        ]);

        runtime.dispose();
        expect(events.activeSubscriptions).toBe(0);
    });

    it('rejects an empty steer message before emitting a control request', async () => {
        const events = new RuntimeEventBus();
        const runtime = new SubagentsLiveRuntime(events);
        await runtime.beginSession('session-1');
        events.emit('subagent:async-started', {
            id: 'async-1',
            sessionId: 'session-1',
            asyncDir: '/tmp/missing-is-safe',
            agent: 'worker',
        });
        const run = runtime.store
            .snapshot()
            .runs.find((candidate) => candidate.source === 'async');
        expect(run?.source).toBe('async');
        const requestCount = events.requests.length;

        await expect(
            runtime.control('steer', run!, '   '),
        ).rejects.toThrow('non-empty');
        expect(events.requests).toHaveLength(requestCount);
        runtime.dispose();
    });

    it('falls back to event-tracked async runs when fleetStatus is absent', async () => {
        const events = new RuntimeEventBus(false);
        const runtime = new SubagentsLiveRuntime(events);
        await runtime.beginSession('session-1');
        events.emit('subagent:async-started', {
            id: 'async-1',
            sessionId: 'session-1',
            asyncDir: '/tmp/missing-is-safe',
            agent: 'worker',
        });

        expect(runtime.store.snapshot()).toMatchObject({
            fleetAvailable: false,
            totalActive: 1,
        });
        expect(events.requests.map((request) => request.method)).toEqual(['ping']);
        runtime.dispose();
    });

    it('targets controls only with the trusted async lifecycle id', async () => {
        const events = new RuntimeEventBus();
        const runtime = new SubagentsLiveRuntime(events);
        await runtime.beginSession('session-1');
        events.emit('subagent:async-started', {
            id: 'async-1',
            sessionId: 'session-1',
            asyncDir: '/tmp/missing-is-safe',
            agent: 'worker',
        });
        const run = runtime.store
            .snapshot()
            .runs.find((candidate) => candidate.source === 'async');
        expect(run?.source).toBe('async');

        await runtime.control('steer', run!, 'Continue carefully');
        await runtime.control('interrupt', run!);
        await runtime.control('stop', run!);

        expect(
            events.requests
                .filter((request) =>
                    ['steer', 'interrupt', 'stop'].includes(request.method),
                )
                .map((request) => request.params),
        ).toEqual([
            { id: 'async-1', message: 'Continue carefully' },
            { id: 'async-1' },
            { id: 'async-1' },
        ]);
        runtime.dispose();
    });
});
