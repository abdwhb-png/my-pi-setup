import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
    SUBAGENT_DELEGATION_CANCEL_EVENT,
    SUBAGENT_DELEGATION_REQUEST_EVENT,
    SUBAGENT_DELEGATION_RESPONSE_EVENT,
    SUBAGENT_DELEGATION_STARTED_EVENT,
    SUBAGENT_DELEGATION_UPDATE_EVENT,
    type SubagentDelegationRequest,
    type SubagentDelegationResponse,
} from 'pi-subagents/delegation';
import {
    DelegationClient,
    DelegationDeadlineError,
    DelegationDisposedError,
    type EventBus,
} from './delegation-client.ts';

class FakeEventBus implements EventBus {
    readonly emitted: Array<{ channel: string; data: unknown }> = [];

    private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

    on(channel: string, handler: (data: unknown) => void): () => void {
        const handlers = this.handlers.get(channel) ?? new Set();
        handlers.add(handler);
        this.handlers.set(channel, handlers);
        return () => handlers.delete(handler);
    }

    emit(channel: string, data: unknown): void {
        this.emitted.push({ channel, data });
        for (const handler of this.handlers.get(channel) ?? []) handler(data);
    }

    listenerCount(channel: string): number {
        return this.handlers.get(channel)?.size ?? 0;
    }
}

function request(requestId: string): SubagentDelegationRequest {
    return {
        version: 1,
        requestId,
        agent: 'worker',
        task: `Implement ${requestId}`,
        context: 'fresh',
        cwd: '/workspace',
    };
}

function response(
    requestId: string,
    status: SubagentDelegationResponse['status'] = 'completed',
): SubagentDelegationResponse {
    return { version: 1, requestId, status };
}

test('emits a request and resolves only its correlated response', async () => {
    const events = new FakeEventBus();
    const client = new DelegationClient(events);
    let settled = false;
    const pending = client.run(request('req-1')).finally(() => {
        settled = true;
    });

    expect(events.emitted[0]).toEqual({
        channel: SUBAGENT_DELEGATION_REQUEST_EVENT,
        data: request('req-1'),
    });

    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, response('req-2'));
    await Promise.resolve();
    expect(settled).toBe(false);

    const completed = response('req-1');
    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, completed);
    await expect(pending).resolves.toEqual(completed);
});

test('rejects a duplicate active request id without replacing the first run', async () => {
    const events = new FakeEventBus();
    const client = new DelegationClient(events);
    const first = client.run(request('req-1'));

    await expect(client.run(request('req-1'))).rejects.toThrow(
        'Delegation request req-1 is already active.',
    );
    expect(
        events.emitted.filter(
            ({ channel }) => channel === SUBAGENT_DELEGATION_REQUEST_EVENT,
        ),
    ).toHaveLength(1);

    const completed = response('req-1');
    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, completed);
    await expect(first).resolves.toEqual(completed);
});

test('rejects invalid request ids without emitting or registering work', async () => {
    const invalidRequestIds = ['', '   ', 'x'.repeat(257), 'req\n1', 'req\r1'];

    for (const requestId of invalidRequestIds) {
        const events = new FakeEventBus();
        const client = new DelegationClient(events);
        const result = client.run(request(requestId));

        expect(events.emitted).toHaveLength(0);
        await expect(result).rejects.toThrow(
            'Delegation requestId must be a non-empty string of at most 256 characters without newlines.',
        );
    }
});

test('emits cancellation once and waits for a terminal response', async () => {
    const events = new FakeEventBus();
    const client = new DelegationClient(events);
    let settled = false;
    const pending = client.run(request('req-1')).finally(() => {
        settled = true;
    });

    client.cancel('req-1');
    client.cancel('req-1');

    expect(
        events.emitted.filter(
            ({ channel }) => channel === SUBAGENT_DELEGATION_CANCEL_EVENT,
        ),
    ).toEqual([
        {
            channel: SUBAGENT_DELEGATION_CANCEL_EVENT,
            data: { version: 1, requestId: 'req-1' },
        },
    ]);
    await Promise.resolve();
    expect(settled).toBe(false);

    const cancelled = response('req-1', 'cancelled');
    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, cancelled);
    await expect(pending).resolves.toEqual(cancelled);
});

test('cancels before requesting an already-aborted run', async () => {
    const events = new FakeEventBus();
    const client = new DelegationClient(events);
    const controller = new AbortController();
    controller.abort();
    let settled = false;

    const pending = client
        .run(request('req-1'), { signal: controller.signal })
        .finally(() => {
            settled = true;
        });

    expect(events.emitted.slice(0, 2)).toEqual([
        {
            channel: SUBAGENT_DELEGATION_CANCEL_EVENT,
            data: { version: 1, requestId: 'req-1' },
        },
        {
            channel: SUBAGENT_DELEGATION_REQUEST_EVENT,
            data: request('req-1'),
        },
    ]);
    await Promise.resolve();
    expect(settled).toBe(false);

    const interrupted = response('req-1', 'interrupted');
    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, interrupted);
    await expect(pending).resolves.toEqual(interrupted);
});

test('settles every terminal status and ignores malformed terminal payloads', async () => {
    const statuses = [
        'completed',
        'failed',
        'timed_out',
        'cancelled',
        'interrupted',
        'turn_budget_exhausted',
        'tool_budget_exhausted',
        'structured_output_failed',
        'acceptance_failed',
        'invalid_request',
        'unavailable_context',
    ] as const satisfies ReadonlyArray<SubagentDelegationResponse['status']>;

    for (const [index, status] of statuses.entries()) {
        const events = new FakeEventBus();
        const client = new DelegationClient(events);
        const requestId = `req-${index}`;
        const pending = client.run(request(requestId));
        const terminal = response(requestId, status);

        events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, terminal);
        await expect(pending).resolves.toEqual(terminal);
    }

    const events = new FakeEventBus();
    const client = new DelegationClient(events);
    let settled = false;
    const pending = client.run(request('req-malformed')).finally(() => {
        settled = true;
    });
    const malformed = [
        { version: 1, requestId: 'req-malformed', status: 'running' },
        { version: 2, requestId: 'req-malformed', status: 'completed' },
        { version: 1, requestId: 'req-malformed' },
    ];

    for (const payload of malformed) {
        events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, payload);
        await Promise.resolve();
        expect(settled).toBe(false);
    }

    const completed = response('req-malformed');
    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, completed);
    await expect(pending).resolves.toEqual(completed);
});

test('ignores malformed response optionals and sanitizes a valid response', async () => {
    const events = new FakeEventBus();
    const client = new DelegationClient(events);
    let settled = false;
    const pending = client.run(request('req-1')).finally(() => {
        settled = true;
    });
    const base = {
        version: 1,
        requestId: 'req-1',
        status: 'completed',
    } as const;
    const malformed = [
        { ...base, error: 1 },
        { ...base, runId: 1 },
        { ...base, childIndex: '0' },
        { ...base, agent: 1 },
        { ...base, model: 1 },
        { ...base, exitCode: '0' },
        { ...base, output: 1 },
        { ...base, outputPath: 1 },
        { ...base, sessionFile: 1 },
        { ...base, acceptance: null },
        { ...base, acceptance: { status: 'unknown', explicit: true } },
        { ...base, acceptance: { status: 'verified', explicit: 'yes' } },
        { ...base, turns: '1' },
        { ...base, toolCount: '1' },
        { ...base, durationMs: '1' },
        { ...base, tokens: '1' },
        { ...base, warnings: ['ok', 1] },
    ];

    for (const payload of malformed) {
        events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, payload);
        await Promise.resolve();
        expect(settled).toBe(false);
    }

    const valid = {
        ...base,
        error: 'none',
        runId: 'run-1',
        childIndex: 0,
        agent: 'worker',
        model: 'model-1',
        exitCode: 0,
        output: 'done',
        outputPath: '/tmp/output',
        sessionFile: '/tmp/session.jsonl',
        acceptance: {
            status: 'verified',
            evidenceStatus: 'verified',
            explicit: true,
        },
        turns: 1,
        toolCount: 2,
        durationMs: 3,
        tokens: 4,
        warnings: ['warning'],
        extra: true,
    } satisfies SubagentDelegationResponse & { extra: boolean };
    const { extra: _, ...sanitized } = valid;

    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, valid);
    await expect(pending).resolves.toEqual(sanitized);
});

test('accepts the public review-required acceptance status', async () => {
    const events = new FakeEventBus();
    const client = new DelegationClient(events);
    const pending = client.run(request('req-review'));
    const terminal = {
        version: 1,
        requestId: 'req-review',
        status: 'completed',
        acceptance: {
            status: 'review-required',
            evidenceStatus: 'verified',
            explicit: true,
        },
    } as const;

    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, terminal);
    await expect(pending).resolves.toEqual(terminal);
});

test('rejects at its hard deadline and ignores a late response', async () => {
    const events = new FakeEventBus();
    const client = new DelegationClient(events);
    const pending = client.run(request('req-1'), { deadlineMs: 5 });

    await expect(pending).rejects.toBeInstanceOf(DelegationDeadlineError);
    expect(
        events.emitted.filter(
            ({ channel }) => channel === SUBAGENT_DELEGATION_CANCEL_EVENT,
        ),
    ).toEqual([
        {
            channel: SUBAGENT_DELEGATION_CANCEL_EVENT,
            data: { version: 1, requestId: 'req-1' },
        },
    ]);

    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, response('req-1'));
    await Promise.resolve();
});

test('dispose unregisters listeners, cleans runs, and rejects future work', async () => {
    const events = new FakeEventBus();
    const client = new DelegationClient(events);
    const first = client.run(request('req-1')).catch((error: Error) => error);
    const second = client
        .run(request('req-2'), { deadlineMs: 10 })
        .catch((error: Error) => error);

    expect([
        events.listenerCount(SUBAGENT_DELEGATION_STARTED_EVENT),
        events.listenerCount(SUBAGENT_DELEGATION_UPDATE_EVENT),
        events.listenerCount(SUBAGENT_DELEGATION_RESPONSE_EVENT),
    ]).toEqual([1, 1, 1]);

    client.dispose();
    client.dispose();

    expect(await first).toBeInstanceOf(DelegationDisposedError);
    expect(await second).toBeInstanceOf(DelegationDisposedError);
    expect([
        events.listenerCount(SUBAGENT_DELEGATION_STARTED_EVENT),
        events.listenerCount(SUBAGENT_DELEGATION_UPDATE_EVENT),
        events.listenerCount(SUBAGENT_DELEGATION_RESPONSE_EVENT),
    ]).toEqual([0, 0, 0]);
    await expect(client.run(request('req-3'))).rejects.toBeInstanceOf(
        DelegationDisposedError,
    );

    await Bun.sleep(15);
    expect(
        events.emitted.filter(
            ({ channel }) => channel === SUBAGENT_DELEGATION_CANCEL_EVENT,
        ),
    ).toHaveLength(0);
});

test('correlates started and update callbacks to the active request', async () => {
    const events = new FakeEventBus();
    const client = new DelegationClient(events);
    const started: string[] = [];
    const updates: string[] = [];
    const pending = client.run(request('req-1'), {
        onStarted: (event) => started.push(event.requestId),
        onUpdate: (event) => updates.push(event.recentOutput ?? ''),
    });

    events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
        version: 1,
        requestId: 'req-2',
    });
    events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
        version: 1,
        requestId: 'req-2',
        recentOutput: 'wrong',
    });
    events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
        version: 1,
        requestId: 'req-1',
    });
    events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
        version: 1,
        requestId: 'req-1',
        recentOutput: 'working',
    });

    expect(started).toEqual(['req-1']);
    expect(updates).toEqual(['working']);

    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, response('req-1'));
    await pending;
    events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
        version: 1,
        requestId: 'req-1',
        recentOutput: 'late',
    });
    expect(updates).toEqual(['working']);
});

test('ignores malformed started and update payloads and sanitizes valid updates', async () => {
    const events = new FakeEventBus();
    const client = new DelegationClient(events);
    const started: unknown[] = [];
    const updates: unknown[] = [];
    const pending = client.run(request('req-1'), {
        onStarted: (event) => started.push(event),
        onUpdate: (event) => updates.push(event),
    });
    const base = { version: 1, requestId: 'req-1' };

    for (const payload of [
        null,
        { ...base, version: 2 },
        { version: 1, requestId: '   ' },
    ]) {
        events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, payload);
    }
    for (const payload of [
        null,
        { ...base, currentTool: 1 },
        { ...base, currentToolArgs: 1 },
        { ...base, recentOutput: 1 },
        { ...base, recentOutputLines: ['ok', 1] },
        { ...base, recentTools: [{ tool: 'read', args: 1 }] },
        { ...base, model: 1 },
        { ...base, toolCount: '1' },
        { ...base, durationMs: '1' },
        { ...base, tokens: '1' },
    ]) {
        events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, payload);
    }

    expect(started).toEqual([]);
    expect(updates).toEqual([]);

    events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, { ...base, extra: true });
    events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
        ...base,
        currentTool: 'read',
        currentToolArgs: '{"path":"a"}',
        recentOutput: 'working',
        recentOutputLines: ['one', 'two'],
        recentTools: [{ tool: 'read', args: 'a' }],
        model: 'model-1',
        toolCount: 1,
        durationMs: 2,
        tokens: 3,
        extra: true,
    });

    expect(started).toEqual([base]);
    expect(updates).toEqual([
        {
            ...base,
            currentTool: 'read',
            currentToolArgs: '{"path":"a"}',
            recentOutput: 'working',
            recentOutputLines: ['one', 'two'],
            recentTools: [{ tool: 'read', args: 'a' }],
            model: 'model-1',
            toolCount: 1,
            durationMs: 2,
            tokens: 3,
        },
    ]);

    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, response('req-1'));
    await pending;
});

test('an active abort cancels once and terminal cleanup removes local handlers', async () => {
    const events = new FakeEventBus();
    const client = new DelegationClient(events);
    const controller = new AbortController();
    let settled = false;
    const pending = client
        .run(request('req-1'), { signal: controller.signal })
        .finally(() => {
            settled = true;
        });

    controller.abort();
    client.cancel('req-1');
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(
        events.emitted.filter(
            ({ channel }) => channel === SUBAGENT_DELEGATION_CANCEL_EVENT,
        ),
    ).toHaveLength(1);

    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, response('req-1', 'failed'));
    await expect(pending).resolves.toEqual(response('req-1', 'failed'));
    client.cancel('req-1');
    expect(
        events.emitted.filter(
            ({ channel }) => channel === SUBAGENT_DELEGATION_CANCEL_EVENT,
        ),
    ).toHaveLength(1);
});

test('a terminal response clears its hard deadline', async () => {
    const events = new FakeEventBus();
    const client = new DelegationClient(events);
    const pending = client.run(request('req-1'), { deadlineMs: 5 });

    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, response('req-1'));
    await expect(pending).resolves.toEqual(response('req-1'));
    await Bun.sleep(10);

    expect(
        events.emitted.filter(
            ({ channel }) => channel === SUBAGENT_DELEGATION_CANCEL_EVENT,
        ),
    ).toHaveLength(0);
});

test('uses only the public pi-subagents delegation boundary', () => {
    const source = readFileSync(new URL('./delegation-client.ts', import.meta.url), 'utf8');

    expect(source).toMatch(/from ["']pi-subagents\/delegation["']/);
    expect(source).not.toContain('/src/');
    expect(source).not.toContain('subagents:rpc');
    expect(source).not.toContain('child_process');
    expect(source).not.toMatch(/\b(?:callTool|invokeTool|registerTool)\b/);
});
