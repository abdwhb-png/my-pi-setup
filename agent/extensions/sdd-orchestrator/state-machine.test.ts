import { expect, test } from 'bun:test';
import {
    recoveryAttestationDigest,
    transition,
    type RunSnapshot,
    type RunState,
    type TaskState,
} from './state-machine.ts';

function snapshot(
    taskState: TaskState = 'pending',
    runState: RunSnapshot['state'] = 'draft',
): RunSnapshot {
    return {
        runId: 'run-1',
        revision: 0,
        state: runState,
        tasks: {
            'task-1': {
                id: 'task-1',
                state: taskState,
                launches: 0,
                maxLaunches: 2,
            },
        },
        consumedIdempotencyKeys: [],
        plannedDelegations: {},
    };
}

test('applies legal run and task transitions and increments revisions', () => {
    const assessed = transition(snapshot(), {
        type: 'run-transition',
        expectedRevision: 0,
        to: 'assessed',
    });
    const implementing = transition(assessed, {
        type: 'task-transition',
        expectedRevision: 1,
        taskId: 'task-1',
        to: 'implementing',
    });

    expect(implementing).toMatchObject({
        revision: 2,
        state: 'assessed',
        tasks: { 'task-1': { state: 'implementing' } },
    });
    expect(snapshot()).toMatchObject({
        revision: 0,
        state: 'draft',
        tasks: { 'task-1': { state: 'pending' } },
    });
});

test('accepts every designed run and task state edge', () => {
    const runEdges: ReadonlyArray<readonly [RunState, RunState]> = [
        ['draft', 'assessed'],
        ['assessed', 'awaiting_approval'],
        ['awaiting_approval', 'approved'],
        ['approved', 'running'],
        ['running', 'needs_input'],
        ['running', 'failed'],
        ['running', 'cancelled'],
        ['running', 'completed'],
    ];
    for (const [from, to] of runEdges) {
        expect(
            transition(snapshot('pending', from), {
                type: 'run-transition',
                expectedRevision: 0,
                to,
            }).state,
        ).toBe(to);
    }

    const taskEdges: ReadonlyArray<readonly [TaskState, TaskState]> = [
        ['pending', 'implementing'],
        ['pending', 'awaiting_direct_agent'],
        ['awaiting_direct_agent', 'verified'],
        ['implementing', 'reviewing'],
        ['reviewing', 'fixing'],
        ['reviewing', 'verified'],
        ['fixing', 'reviewing'],
        ...(['awaiting_direct_agent', 'implementing', 'reviewing', 'fixing'] as const)
            .flatMap((from) =>
                (['needs_input', 'failed', 'cancelled'] as const).map(
                    (to) => [from, to] as const,
                ),
            ),
    ];
    for (const [from, to] of taskEdges) {
        expect(
            transition(snapshot(from), {
                type: 'task-transition',
                expectedRevision: 0,
                taskId: 'task-1',
                to,
            }).tasks['task-1'].state,
        ).toBe(to);
    }
});

test('rejects illegal and stale transitions with exact useful errors', () => {
    expect(() =>
        transition(snapshot(), {
            type: 'task-transition',
            expectedRevision: 0,
            taskId: 'task-1',
            to: 'verified',
        }),
    ).toThrow('Illegal task transition: pending -> verified.');
    expect(() =>
        transition(snapshot('pending', 'failed'), {
            type: 'run-transition',
            expectedRevision: 0,
            to: 'running',
        }),
    ).toThrow('Illegal run transition: failed -> running.');
    for (const [from, to] of [
        ['draft', 'failed'],
        ['assessed', 'needs_input'],
        ['awaiting_approval', 'cancelled'],
        ['approved', 'failed'],
    ] as const) {
        expect(() =>
            transition(snapshot('pending', from), {
                type: 'run-transition',
                expectedRevision: 0,
                to,
            }),
        ).toThrow(`Illegal run transition: ${from} -> ${to}.`);
    }
    expect(() =>
        transition(snapshot(), {
            type: 'run-transition',
            expectedRevision: 1,
            to: 'assessed',
        }),
    ).toThrow('Stale revision: expected 1, current 0.');
});

test('persists a delegation plan once for duplicate idempotency keys', () => {
    const event = {
        type: 'delegation-planned' as const,
        expectedRevision: 0,
        idempotencyKey: 'task-1:worker:0',
        taskId: 'task-1',
        requestId: 'request-1',
        stage: 'worker',
        attempt: 0,
        plannedAt: '2026-07-21T12:00:00.000Z',
    };
    const planned = transition(snapshot(), event);

    expect(planned).toMatchObject({
        revision: 1,
        tasks: {
            'task-1': { launches: 1, activeRequestId: 'request-1' },
        },
        consumedIdempotencyKeys: ['task-1:worker:0'],
        plannedDelegations: {
            'task-1:worker:0': {
                idempotencyKey: 'task-1:worker:0',
                taskId: 'task-1',
                requestId: 'request-1',
                stage: 'worker',
                attempt: 0,
                plannedAt: '2026-07-21T12:00:00.000Z',
            },
        },
    });
    expect(transition(planned, event)).toBe(planned);
});

test('rejects a reused idempotency key when any delegation field differs', () => {
    const event = {
        type: 'delegation-planned' as const,
        expectedRevision: 0,
        idempotencyKey: 'task-1:worker:0',
        taskId: 'task-1',
        requestId: 'request-1',
        stage: 'worker',
        attempt: 0,
        plannedAt: '2026-07-21T12:00:00.000Z',
    };
    const planned = transition(snapshot(), event);
    const conflicts = [
        { ...event, taskId: 'task-2' },
        { ...event, requestId: 'request-2' },
        { ...event, stage: 'reviewer' },
        { ...event, attempt: 1 },
        { ...event, plannedAt: '2026-07-21T12:01:00.000Z' },
    ];
    for (const conflict of conflicts) {
        expect(() => transition(planned, conflict)).toThrow(
            'Idempotency conflict: task-1:worker:0.',
        );
    }

    const corruptStoredKey: RunSnapshot = {
        ...planned,
        plannedDelegations: {
            'task-1:worker:0': {
                ...planned.plannedDelegations['task-1:worker:0'],
                idempotencyKey: 'different-key',
            },
        },
    };
    expect(() => transition(corruptStoredKey, event)).toThrow(
        'Idempotency conflict: task-1:worker:0.',
    );
});

test('refuses delegation plans after a task reaches its launch ceiling', () => {
    const atCeiling = snapshot();
    atCeiling.tasks['task-1'].launches = 2;

    expect(() =>
        transition(atCeiling, {
            type: 'delegation-planned',
            expectedRevision: 0,
            idempotencyKey: 'task-1:reviewer:0',
            taskId: 'task-1',
            requestId: 'request-2',
            stage: 'reviewer',
            attempt: 0,
            plannedAt: '2026-07-21T12:01:00.000Z',
        }),
    ).toThrow('Task task-1 launch ceiling reached: 2/2.');
});

test('records a correlated terminal response before clearing the active request', () => {
    const planned = transition(snapshot(), {
        type: 'delegation-planned',
        expectedRevision: 0,
        idempotencyKey: 'task-1:worker:1',
        taskId: 'task-1',
        requestId: 'run-1:task-1:worker:1',
        stage: 'worker',
        attempt: 1,
        plannedAt: '2026-07-21T12:00:00.000Z',
    });
    const response = {
        version: 1 as const,
        requestId: 'run-1:task-1:worker:1',
        status: 'completed' as const,
        output: 'done',
    };
    const recorded = transition(planned, {
        type: 'delegation-response-recorded',
        expectedRevision: 1,
        taskId: 'task-1',
        response,
    });

    expect(recorded.tasks['task-1']).toMatchObject({
        terminalResponses: { [response.requestId]: response },
    });
    expect(recorded.tasks['task-1'].activeRequestId).toBeUndefined();
    expect(
        transition(recorded, {
            type: 'delegation-response-recorded',
            expectedRevision: 1,
            taskId: 'task-1',
            response,
        }),
    ).toBe(recorded);
});

test('records durable cancellation, Direct evidence, and terminal reasons', () => {
    const cancelling = transition(snapshot('implementing', 'running'), {
        type: 'cancellation-requested',
        expectedRevision: 0,
        requestedAt: '2026-07-21T12:00:00.000Z',
        requestIds: ['request-1'],
    });
    expect(cancelling.cancellation).toEqual({
        requestedAt: '2026-07-21T12:00:00.000Z',
        requestIds: ['request-1'],
    });

    const awaiting = snapshot('awaiting_direct_agent', 'running');
    const evidence = {
        changedFiles: ['src/a.ts'],
        tests: ['a.test.ts'],
        commands: ['bun test a.test.ts'],
        validationOutput: '1 pass',
        residualRisks: ['none'],
    };
    const evidenced = transition(awaiting, {
        type: 'direct-evidence-recorded',
        expectedRevision: 0,
        taskId: 'task-1',
        evidence,
    });
    const reasoned = transition(evidenced, {
        type: 'terminal-reason-recorded',
        expectedRevision: 1,
        taskId: 'task-1',
        reason: 'budget_exhausted',
    });
    expect(reasoned.tasks['task-1']).toMatchObject({
        directEvidence: evidence,
        terminalReason: 'budget_exhausted',
    });
});

test('records each schema-validated review result once by request ID', () => {
    const reviewing = snapshot('reviewing', 'running');
    const review = {
        version: 1 as const,
        taskId: 'task-1',
        stage: 'combined' as const,
        verdict: 'pass' as const,
        findings: [],
        evidence: ['checked task contract'],
    };
    const recorded = transition(reviewing, {
        type: 'review-recorded',
        expectedRevision: 0,
        taskId: 'task-1',
        requestId: 'run-1:task-1:combined:1',
        review,
    });

    expect(recorded.tasks['task-1'].reviewResults).toEqual({
        'run-1:task-1:combined:1': review,
    });
    expect(
        transition(recorded, {
            type: 'review-recorded',
            expectedRevision: 0,
            taskId: 'task-1',
            requestId: 'run-1:task-1:combined:1',
            review,
        }),
    ).toBe(recorded);
});

test('records a run-level terminal reason without changing transition tables', () => {
    const reasoned = transition(snapshot('pending', 'running'), {
        type: 'run-terminal-reason-recorded',
        expectedRevision: 0,
        reason: 'source_digest_changed',
    });

    expect(reasoned).toMatchObject({
        revision: 1,
        state: 'running',
        terminalReason: 'source_digest_changed',
    });
});

test('marks a persisted review as applied exactly once', () => {
    const reviewing = snapshot('reviewing', 'running');
    reviewing.tasks['task-1'].reviewResults = {
        'run-1:task-1:spec:1': {
            version: 1,
            taskId: 'task-1',
            stage: 'spec',
            verdict: 'pass',
            findings: [],
            evidence: ['checked'],
        },
    };
    const applied = transition(reviewing, {
        type: 'review-applied',
        expectedRevision: 0,
        taskId: 'task-1',
        requestId: 'run-1:task-1:spec:1',
    });

    expect(applied.tasks['task-1'].appliedReviewRequestIds).toEqual([
        'run-1:task-1:spec:1',
    ]);
    expect(
        transition(applied, {
            type: 'review-applied',
            expectedRevision: 0,
            taskId: 'task-1',
            requestId: 'run-1:task-1:spec:1',
        }),
    ).toBe(applied);
});

test('marks a terminal delegation response as applied exactly once', () => {
    const responseId = 'run-1:task-1:worker:1';
    const running = snapshot('reviewing', 'running');
    running.tasks['task-1'].terminalResponses = {
        [responseId]: {
            version: 1,
            requestId: responseId,
            status: 'completed',
            acceptance: {
                status: 'verified',
                evidenceStatus: 'verified',
                explicit: true,
            },
        },
    };
    const applied = transition(running, {
        type: 'delegation-response-applied',
        expectedRevision: 0,
        taskId: 'task-1',
        requestId: responseId,
    });

    expect(applied.tasks['task-1'].appliedResponseRequestIds).toEqual([
        responseId,
    ]);
    expect(
        transition(applied, {
            type: 'delegation-response-applied',
            expectedRevision: 0,
            taskId: 'task-1',
            requestId: responseId,
        }),
    ).toBe(applied);
});

test('applies and deduplicates one boundary-bound recovery revision', () => {
    const requestId = 'run-1:task-1:worker:1';
    const uncertain = snapshot('needs_input', 'needs_input');
    uncertain.terminalReason = 'uncertain_foreground_delegation';
    uncertain.tasks['task-1'].activeRequestId = requestId;
    uncertain.tasks['task-1'].terminalReason =
        'uncertain_foreground_delegation';
    uncertain.plannedDelegations[requestId] = {
        idempotencyKey: requestId,
        taskId: 'task-1',
        requestId,
        stage: 'worker',
        attempt: 1,
        plannedAt: '2026-07-21T12:00:00.000Z',
    };
    const evidence = {
        changedFiles: ['src/one.ts'],
        tests: ['src/one.test.ts'],
        commands: ['bun test src/one.test.ts'],
        validationOutput: '1 pass, 0 fail',
        residualRisks: ['attested result'],
    };
    const attestation = {
        action: 'attest' as const,
        confirmation: true as const,
        authorizedBy: 'operator',
        requestId,
        stage: 'worker' as const,
    };
    const choice = {
        ...attestation,
        priorReason: 'uncertain_foreground_delegation' as const,
        evidence,
        digest: recoveryAttestationDigest(attestation, evidence),
    };
    const event = {
        type: 'recovery-attestation-applied' as const,
        expectedRevision: 0,
        taskId: 'task-1',
        profile: 'standard' as const,
        choice,
    };

    const recovered = transition(uncertain, event);

    expect(recovered).toMatchObject({
        revision: 1,
        state: 'running',
        terminalReason: undefined,
        tasks: {
            'task-1': {
                state: 'reviewing',
                activeRequestId: undefined,
                terminalReason: undefined,
                recoveryChoice: choice,
                appliedResponseRequestIds: [requestId],
                terminalResponses: {
                    [requestId]: {
                        status: 'completed',
                        acceptance: {
                            status: 'accepted',
                            evidenceStatus: 'verified',
                            explicit: true,
                        },
                    },
                },
            },
        },
    });
    expect(transition(recovered, event)).toBe(recovered);
});
