import { describe, expect, it } from 'bun:test';
import {
    SUBAGENT_RPC_REPLY_EVENT_PREFIX,
    SUBAGENT_RPC_REQUEST_EVENT,
    SubagentRpcClient,
    parseFleetStatus,
    type EventBusLike,
} from './rpc-client.ts';

class FakeEventBus implements EventBusLike {
    private handlers = new Map<string, Set<(data: unknown) => void>>();
    activeSubscriptions = 0;

    constructor(
        private readonly response:
            | 'success'
            | 'malformed'
            | 'mismatched'
            | 'none' = 'success',
    ) {}

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
        if (this.response !== 'none' && event === SUBAGENT_RPC_REQUEST_EVENT) {
            const request = data as { requestId: string; method: string };
            queueMicrotask(() => {
                this.emit(
                    `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${request.requestId}`,
                    this.response === 'malformed'
                        ? { version: 2, requestId: request.requestId }
                        : {
                              version: 1,
                              requestId:
                                  this.response === 'mismatched'
                                      ? 'another-request'
                                      : request.requestId,
                              method: request.method,
                              success: true,
                              data: { version: 1, methods: ['ping'] },
                          },
                );
            });
        }
        for (const handler of this.handlers.get(event) ?? []) handler(data);
    }
}

describe('SubagentRpcClient', () => {
    it('correlates a successful ping and removes its reply listener', async () => {
        const events = new FakeEventBus();
        const client = new SubagentRpcClient(events, {
            requestId: () => 'request-1',
        });

        const reply = await client.request('ping');

        expect(reply).toEqual({ version: 1, methods: ['ping'] });
        expect(events.activeSubscriptions).toBe(0);
    });

    it('rejects pending calls and removes listeners when disposed', async () => {
        const events = new FakeEventBus('none');
        const client = new SubagentRpcClient(events, {
            requestId: () => 'pending-request',
            timeoutMs: 60_000,
        });

        const pending = client.request('status');
        client.dispose();

        await expect(pending).rejects.toMatchObject({ code: 'disposed' });
        expect(events.activeSubscriptions).toBe(0);
    });

    it('times out without leaking a reply listener', async () => {
        const events = new FakeEventBus('none');
        const client = new SubagentRpcClient(events, {
            requestId: () => 'timeout-request',
            timeoutMs: 5,
        });

        await expect(client.request('status')).rejects.toMatchObject({
            code: 'timeout',
        });
        expect(events.activeSubscriptions).toBe(0);
    });

    it('rejects a malformed reply and removes its listener', async () => {
        const events = new FakeEventBus('malformed');
        const client = new SubagentRpcClient(events, {
            requestId: () => 'malformed-request',
        });

        await expect(client.request('ping')).rejects.toThrow(
            'Mismatched RPC reply',
        );
        expect(events.activeSubscriptions).toBe(0);
    });

    it('rejects a reply whose correlation id does not match', async () => {
        const events = new FakeEventBus('mismatched');
        const client = new SubagentRpcClient(events, {
            requestId: () => 'expected-request',
        });

        await expect(client.request('ping')).rejects.toThrow(
            'Mismatched RPC reply',
        );
        expect(events.activeSubscriptions).toBe(0);
    });

    it('accepts the public fleetStatus v1 DTO without exposing control ids', () => {
        const fleet = parseFleetStatus({
            version: 1,
            entries: [
                {
                    key: 'fleet-1',
                    agent: 'worker',
                    role: 'implementation',
                    model: 'provider/model',
                    effort: 'high',
                    goal: 'Implement the feature',
                    startedAt: 1_000,
                    tokens: { input: 120, output: 30, total: 150 },
                    runId: 'must-not-leak',
                },
            ],
            totalActive: 3,
            omitted: 2,
        });

        expect(fleet?.entries[0]).toEqual({
            key: 'fleet-1',
            agent: 'worker',
            role: 'implementation',
            model: 'provider/model',
            effort: 'high',
            goal: 'Implement the feature',
            startedAt: 1_000,
            tokens: { input: 120, output: 30, total: 150 },
        });
        expect(fleet?.omitted).toBe(2);
        expect(fleet?.entries[0]).not.toHaveProperty('runId');
    });
});
