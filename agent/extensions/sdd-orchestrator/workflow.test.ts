import { expect, test } from 'bun:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createHash } from 'node:crypto';
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
    SubagentDelegationRequest,
    SubagentDelegationResponse,
} from 'pi-subagents/delegation';
import type { ApprovedManifest, ApprovedManifestTask } from './manifest.ts';
import type { RunEvent, RunSnapshot } from './state-machine.ts';
import type { TransitionRecord } from './store.ts';
import {
    completeDirect,
    SddWorkflow,
    selectRunnableBatch,
} from './workflow.ts';

const context = { cwd: '/repo' } as ExtensionContext;

function manifest(profile: 'direct' | 'light' | 'standard' | 'critical'):
    ApprovedManifest {
    const maxLaunches = { direct: 0, light: 1, standard: 4, critical: 7 }[
        profile
    ];
    return {
        manifestId: 'manifest-1',
        manifestVersion: 1,
        ruleSetVersion: 1,
        state: 'approved',
        planTitle: 'Workflow plan',
        planPath: import.meta.path,
        sourceDigest: createHash('sha256')
            .update(readFileSync(import.meta.path))
            .digest('hex'),
        assessmentDigest: 'assessment-1',
        assessorModel: 'assessor-model',
        globalProfile: profile,
        parallelismEnabled: false,
        maxConcurrentWriters: 2,
        finalIntegrationReview: false,
        maximumLaunches: maxLaunches,
        tasks: [
            {
                id: 'task-1',
                title: 'Task one',
                description: 'Implement task one.',
                recommendedProfile: profile,
                effectiveProfile: profile,
                classificationRules: [],
                signals: ['isolated_scope'],
                dependencies: [],
                files: ['src/one.ts'],
                verify: [{ id: 'test', command: 'bun test one.test.ts' }],
                budgets: {
                    initialWorkers: profile === 'direct' ? 0 : 1,
                    correctionWorkers:
                        profile === 'standard'
                            ? 1
                            : profile === 'critical'
                              ? 2
                              : 0,
                    reviewerAttempts:
                        profile === 'standard'
                            ? 2
                            : profile === 'critical'
                              ? 4
                              : 0,
                    maxLaunches,
                },
                parallelEligible: false,
            },
        ],
        decision: {
            globalProfile: profile,
            taskOverrides: {},
            parallelismEnabled: false,
            criticalDowngradeConfirmations: {},
            criticalDowngradeJustifications: {},
            approvedBy: 'operator',
            approvedAt: '2026-07-21T12:00:00.000Z',
        },
        approvalDigest: 'approval-1',
    };
}

function snapshot(maxLaunches: number): RunSnapshot {
    return {
        runId: 'run-1',
        revision: 0,
        state: 'approved',
        tasks: {
            'task-1': {
                id: 'task-1',
                state: 'pending',
                launches: 0,
                maxLaunches,
            },
        },
        consumedIdempotencyKeys: [],
        plannedDelegations: {},
    };
}

class MemoryStore {
    readonly saves: RunSnapshot[] = [];
    readonly events: RunEvent[] = [];

    constructor(public current: RunSnapshot) {}

    load(runId: string): RunSnapshot | null {
        return runId === this.current.runId ? structuredClone(this.current) : null;
    }

    save(next: RunSnapshot): void {
        this.current = structuredClone(next);
        this.saves.push(structuredClone(next));
    }

    appendTransition(record: TransitionRecord): void {
        this.events.push(record.event);
    }
}

class QueueDelegationClient {
    readonly requests: SubagentDelegationRequest[] = [];
    readonly cancelled: string[] = [];

    constructor(
        private readonly responses: SubagentDelegationResponse[],
        private readonly onRun?: (request: SubagentDelegationRequest) => void,
    ) {}

    run(request: SubagentDelegationRequest): Promise<SubagentDelegationResponse> {
        this.requests.push(request);
        this.onRun?.(request);
        const response = this.responses.shift();
        if (!response) throw new Error('Missing queued response.');
        return Promise.resolve({ ...response, requestId: request.requestId });
    }

    cancel(requestId: string): void {
        this.cancelled.push(requestId);
    }
}

test('Light persists implementation and response before verifying one worker', async () => {
    const approved = manifest('light');
    const store = new MemoryStore(snapshot(1));
    const client = new QueueDelegationClient(
        [
            {
                version: 1,
                requestId: 'replaced-by-fake',
                status: 'completed',
                output: 'implemented',
                acceptance: { status: 'verified', explicit: true },
            },
        ],
        (request) => {
            expect(store.current.tasks['task-1']).toMatchObject({
                state: 'implementing',
                launches: 1,
                activeRequestId: request.requestId,
            });
        },
    );
    const workflow = new SddWorkflow(
        store,
        client,
        () => approved,
    );

    const result = await workflow.run('run-1', context);

    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]).toMatchObject({
        requestId: 'run-1:task-1:worker:1',
        context: 'fresh',
    });
    expect(result.state).toBe('completed');
    expect(result.tasks['task-1']).toMatchObject({
        state: 'verified',
        launches: 1,
    });
    const responseSave = store.saves.findIndex(
        (saved) =>
            saved.tasks['task-1'].terminalResponses?.[
                'run-1:task-1:worker:1'
            ] !== undefined,
    );
    const verifiedSave = store.saves.findIndex(
        (saved) => saved.tasks['task-1'].state === 'verified',
    );
    expect(responseSave).toBeGreaterThanOrEqual(0);
    expect(verifiedSave).toBeGreaterThan(responseSave);
});

test('concurrent run calls join one in-process execution without reconciling it', async () => {
    const approved = manifest('light');
    const store = new MemoryStore(snapshot(1));
    let release!: (response: SubagentDelegationResponse) => void;
    const pending = new Promise<SubagentDelegationResponse>((resolve) => {
        release = resolve;
    });
    const requests: SubagentDelegationRequest[] = [];
    const client = {
        run(request: SubagentDelegationRequest) {
            requests.push(request);
            return pending.then((response) => ({
                ...response,
                requestId: request.requestId,
            }));
        },
        cancel() {},
    };
    const workflow = new SddWorkflow(store, client, () => approved);

    const first = workflow.run('run-1', context);
    await Promise.resolve();
    const second = workflow.run('run-1', context);

    expect(requests).toHaveLength(1);
    expect(store.current.state).toBe('running');
    expect(store.current.tasks['task-1'].state).toBe('implementing');

    release(workerResponse('implemented'));
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.state).toBe('completed');
    expect(requests).toHaveLength(1);
});

test('aborting a run persists cancellation before cancelling the active child', async () => {
    const approved = manifest('light');
    const store = new MemoryStore(snapshot(1));
    const order: string[] = [];
    let release!: (response: SubagentDelegationResponse) => void;
    const client = {
        run() {
            order.push('request');
            return new Promise<SubagentDelegationResponse>((resolve) => {
                release = resolve;
            });
        },
        cancel(requestId: string) {
            expect(store.current.cancellation?.requestIds).toContain(requestId);
            order.push('cancel');
        },
    };
    const workflow = new SddWorkflow(store, client, () => approved);
    const controller = new AbortController();

    const running = workflow.run('run-1', context, controller.signal);
    await Promise.resolve();
    controller.abort();

    expect(order).toEqual(['request', 'cancel']);
    release({
        version: 1,
        requestId: 'run-1:task-1:worker:1',
        status: 'cancelled',
    });
    const result = await running;
    expect(result.state).toBe('cancelled');
});

test('source digest drift fails closed before emitting a delegation', async () => {
    const approved = { ...manifest('light'), sourceDigest: '0'.repeat(64) };
    const store = new MemoryStore(snapshot(1));
    const client = new QueueDelegationClient([workerResponse('must not run')]);

    const result = await new SddWorkflow(store, client, () => approved).run(
        'run-1',
        context,
    );

    expect(client.requests).toHaveLength(0);
    expect(result).toMatchObject({
        state: 'needs_input',
        terminalReason: 'source_digest_changed',
    });
});

test('source digest is rechecked before each later delegation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sdd-workflow-'));
    const planPath = join(directory, 'plan.md');
    try {
        writeFileSync(planPath, 'approved plan');
        const approved = {
            ...manifest('standard'),
            planPath,
            sourceDigest: createHash('sha256')
                .update('approved plan')
                .digest('hex'),
        };
        const store = new MemoryStore(snapshot(4));
        const client = new QueueDelegationClient(
            [workerResponse('implemented')],
            () => writeFileSync(planPath, 'drifted plan'),
        );

        const result = await new SddWorkflow(
            store,
            client,
            () => approved,
        ).run('run-1', context);

        expect(client.requests.map((request) => request.requestId)).toEqual([
            'run-1:task-1:worker:1',
        ]);
        expect(result).toMatchObject({
            state: 'needs_input',
            terminalReason: 'source_digest_changed',
            tasks: {
                'task-1': {
                    state: 'needs_input',
                    terminalReason: 'source_digest_changed',
                },
            },
        });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('cancelling an approved run with no active request closes it without emission', () => {
    const approved = manifest('light');
    const store = new MemoryStore(snapshot(1));
    const client = new QueueDelegationClient([]);
    const workflow = new SddWorkflow(store, client, () => approved);

    const cancelled = workflow.cancel('run-1');
    const repeated = workflow.cancel('run-1');

    expect(cancelled.state).toBe('cancelled');
    expect(repeated).toEqual(cancelled);
    expect(client.requests).toHaveLength(0);
    expect(client.cancelled).toHaveLength(0);
    expect(
        store.events.filter((event) => event.type === 'cancellation-requested'),
    ).toHaveLength(1);
});

test('persisted cancellation prevents run from launching pending work', async () => {
    const approved = manifest('light');
    const initial = snapshot(1);
    initial.state = 'running';
    initial.cancellation = {
        requestedAt: '2026-07-21T12:00:00.000Z',
        requestIds: [],
    };
    const store = new MemoryStore(initial);
    const client = new QueueDelegationClient([]);

    const result = await new SddWorkflow(store, client, () => approved).run(
        'run-1',
        context,
    );

    expect(client.requests).toHaveLength(0);
    expect(result.state).toBe('cancelled');
});

function workerResponse(output: string): SubagentDelegationResponse {
    return {
        version: 1,
        requestId: 'replaced-by-fake',
        status: 'completed',
        output,
        acceptance: { status: 'verified', explicit: true },
    };
}

function reviewResponse(
    stage: 'combined' | 'spec' | 'quality',
    verdict: 'pass' | 'changes_required' | 'blocked',
): SubagentDelegationResponse {
    return {
        version: 1,
        requestId: 'replaced-by-fake',
        status: 'completed',
        output: JSON.stringify({
            version: 1,
            taskId: 'task-1',
            stage,
            verdict,
            findings:
                verdict === 'pass'
                    ? []
                    : [
                          {
                              id: `${stage}-finding`,
                              severity: 'important',
                              file: 'src/one.ts',
                              message: `${stage} correction required`,
                          },
                      ],
            evidence: [`${stage} evidence`],
        }),
    };
}

function integrationResponse(
    verdict: 'pass' | 'changes_required' | 'blocked',
): SubagentDelegationResponse {
    return {
        version: 1,
        requestId: 'replaced-by-fake',
        status: 'completed',
        output: JSON.stringify({
            version: 1,
            taskId: 'manifest:manifest-1',
            stage: 'integration',
            verdict,
            findings:
                verdict === 'pass'
                    ? []
                    : [
                          {
                              id: 'integration-finding',
                              severity: 'important',
                              file: 'src/one.ts',
                              message: 'integration correction required',
                          },
                      ],
            evidence: ['all approved task contracts integrated'],
        }),
    };
}

test('final integration review is one manifest-level launch outside task ceilings', async () => {
    const approved = {
        ...manifest('light'),
        finalIntegrationReview: true,
        maximumLaunches: 2,
    };
    const store = new MemoryStore(snapshot(1));
    const client = new QueueDelegationClient([
        workerResponse('changed src/one.ts; bun test passed'),
        integrationResponse('pass'),
    ]);

    const result = await new SddWorkflow(store, client, () => approved).run(
        'run-1',
        context,
    );

    expect(client.requests.map((request) => request.requestId)).toEqual([
        'run-1:task-1:worker:1',
        'run-1:manifest:integration:1',
    ]);
    expect(client.requests[1]).toMatchObject({
        agent: 'sdd-combined-reviewer',
        context: 'fresh',
    });
    expect(client.requests[1]?.task).toContain('Task ID: manifest:manifest-1');
    expect(client.requests[1]?.task).toContain('task-1');
    expect(client.requests[1]?.task).toContain(
        'changed src/one.ts; bun test passed',
    );
    expect(result).toMatchObject({
        state: 'completed',
        tasks: { 'task-1': { launches: 1, state: 'verified' } },
        integrationReview: { launches: 1 },
    });
});

test('a non-passing final integration review fails closed without correction', async () => {
    for (const verdict of ['changes_required', 'blocked'] as const) {
        const approved = {
            ...manifest('light'),
            finalIntegrationReview: true,
            maximumLaunches: 2,
        };
        const store = new MemoryStore(snapshot(1));
        const client = new QueueDelegationClient([
            workerResponse('implemented'),
            integrationResponse(verdict),
        ]);

        const result = await new SddWorkflow(
            store,
            client,
            () => approved,
        ).run('run-1', context);

        expect(client.requests).toHaveLength(2);
        expect(result.state).toBe(
            verdict === 'blocked' ? 'needs_input' : 'failed',
        );
        expect(result.terminalReason).toBe(
            verdict === 'blocked'
                ? 'integration_reviewer_blocked'
                : 'integration_changes_required',
        );
    }
});

test('integration reconciliation never relaunches and applies a persisted terminal review', () => {
    const approved = {
        ...manifest('light'),
        finalIntegrationReview: true,
        maximumLaunches: 2,
    };
    const requestId = 'run-1:manifest:integration:1';
    const initial = snapshot(1);
    initial.state = 'running';
    initial.tasks['task-1'].state = 'verified';
    initial.tasks['task-1'].launches = 1;
    initial.integrationReview = {
        launches: 1,
        plannedDelegation: {
            idempotencyKey: requestId,
            taskId: 'manifest:manifest-1',
            requestId,
            stage: 'integration',
            attempt: 1,
            plannedAt: '2026-07-21T12:00:00.000Z',
        },
        terminalResponse: {
            ...integrationResponse('pass'),
            requestId,
        },
    };
    const store = new MemoryStore(initial);
    const client = new QueueDelegationClient([]);

    const result = new SddWorkflow(store, client, () => approved).reconcile(
        'run-1',
    );

    expect(client.requests).toHaveLength(0);
    expect(result).toMatchObject({
        state: 'completed',
        integrationReview: {
            launches: 1,
            applied: true,
            review: { stage: 'integration', verdict: 'pass' },
        },
    });
});

test('an unterminated persisted integration plan fails closed without relaunch', () => {
    const approved = {
        ...manifest('light'),
        finalIntegrationReview: true,
        maximumLaunches: 2,
    };
    const requestId = 'run-1:manifest:integration:1';
    const initial = snapshot(1);
    initial.state = 'running';
    initial.tasks['task-1'].state = 'verified';
    initial.tasks['task-1'].launches = 1;
    initial.integrationReview = {
        launches: 1,
        activeRequestId: requestId,
        plannedDelegation: {
            idempotencyKey: requestId,
            taskId: 'manifest:manifest-1',
            requestId,
            stage: 'integration',
            attempt: 1,
            plannedAt: '2026-07-21T12:00:00.000Z',
        },
    };
    const store = new MemoryStore(initial);
    const client = new QueueDelegationClient([]);

    const result = new SddWorkflow(store, client, () => approved).reconcile(
        'run-1',
    );

    expect(client.requests).toHaveLength(0);
    expect(result).toMatchObject({
        state: 'needs_input',
        terminalReason: 'uncertain_foreground_delegation',
    });
});

test('Standard runs worker then one combined reviewer on a pass', async () => {
    const approved = manifest('standard');
    const store = new MemoryStore(snapshot(4));
    const client = new QueueDelegationClient([
        workerResponse('initial implementation'),
        reviewResponse('combined', 'pass'),
    ]);

    const result = await new SddWorkflow(store, client, () => approved).run(
        'run-1',
        context,
    );

    expect(client.requests.map((request) => request.requestId)).toEqual([
        'run-1:task-1:worker:1',
        'run-1:task-1:combined:1',
    ]);
    expect(result.tasks['task-1']).toMatchObject({
        state: 'verified',
        launches: 2,
    });
    expect(result.tasks['task-1'].reviewResults).toHaveProperty(
        'run-1:task-1:combined:1',
    );
});

test('Standard gives one fresh correction its exact prior output and findings', async () => {
    const approved = manifest('standard');
    const store = new MemoryStore(snapshot(4));
    const client = new QueueDelegationClient([
        workerResponse('initial implementation'),
        reviewResponse('combined', 'changes_required'),
        workerResponse('corrected implementation'),
        reviewResponse('combined', 'pass'),
    ]);

    const result = await new SddWorkflow(store, client, () => approved).run(
        'run-1',
        context,
    );

    expect(client.requests.map((request) => request.requestId)).toEqual([
        'run-1:task-1:worker:1',
        'run-1:task-1:combined:1',
        'run-1:task-1:correction:1',
        'run-1:task-1:combined:2',
    ]);
    expect(client.requests[2]).toMatchObject({ context: 'fresh' });
    expect(client.requests[2]!.task).toContain('initial implementation');
    expect(client.requests[2]!.task).toContain('combined correction required');
    expect(client.requests[2]!.task).toContain(
        'Changed files already reported: []',
    );
    expect(client.requests[2]!.task).toContain(
        'Command results already reported: []',
    );
    expect(result.tasks['task-1']).toMatchObject({
        state: 'verified',
        launches: 4,
    });
});

test('Standard fails budget_exhausted after its corrected implementation is rejected', async () => {
    const approved = manifest('standard');
    const store = new MemoryStore(snapshot(4));
    const client = new QueueDelegationClient([
        workerResponse('initial implementation'),
        reviewResponse('combined', 'changes_required'),
        workerResponse('corrected implementation'),
        reviewResponse('combined', 'changes_required'),
    ]);

    const result = await new SddWorkflow(store, client, () => approved).run(
        'run-1',
        context,
    );

    expect(client.requests).toHaveLength(4);
    expect(result.state).toBe('failed');
    expect(result.tasks['task-1']).toMatchObject({
        state: 'failed',
        launches: 4,
        terminalReason: 'budget_exhausted',
    });
});

test('Critical passes after worker, specification, and quality launches', async () => {
    const approved = manifest('critical');
    const store = new MemoryStore(snapshot(7));
    const client = new QueueDelegationClient([
        workerResponse('implementation'),
        reviewResponse('spec', 'pass'),
        reviewResponse('quality', 'pass'),
    ]);

    const result = await new SddWorkflow(store, client, () => approved).run(
        'run-1',
        context,
    );

    expect(client.requests.map((request) => request.requestId)).toEqual([
        'run-1:task-1:worker:1',
        'run-1:task-1:spec:1',
        'run-1:task-1:quality:1',
    ]);
    expect(result.tasks['task-1']).toMatchObject({
        state: 'verified',
        launches: 3,
    });
});

test('Critical repeats only the rejecting specification stage after correction', async () => {
    const approved = manifest('critical');
    const store = new MemoryStore(snapshot(7));
    const client = new QueueDelegationClient([
        workerResponse('implementation'),
        reviewResponse('spec', 'changes_required'),
        workerResponse('spec correction'),
        reviewResponse('spec', 'pass'),
        reviewResponse('quality', 'pass'),
    ]);

    const result = await new SddWorkflow(store, client, () => approved).run(
        'run-1',
        context,
    );

    expect(client.requests.map((request) => request.requestId)).toEqual([
        'run-1:task-1:worker:1',
        'run-1:task-1:spec:1',
        'run-1:task-1:correction:1',
        'run-1:task-1:spec:2',
        'run-1:task-1:quality:1',
    ]);
    expect(result.tasks['task-1']).toMatchObject({
        state: 'verified',
        launches: 5,
    });
});

test('Critical stops at seven launches when specification consumes both corrections', async () => {
    const approved = manifest('critical');
    const store = new MemoryStore(snapshot(7));
    const client = new QueueDelegationClient([
        workerResponse('implementation'),
        reviewResponse('spec', 'changes_required'),
        workerResponse('correction one'),
        reviewResponse('spec', 'changes_required'),
        workerResponse('correction two'),
        reviewResponse('spec', 'pass'),
        reviewResponse('quality', 'changes_required'),
    ]);

    const result = await new SddWorkflow(store, client, () => approved).run(
        'run-1',
        context,
    );

    expect(client.requests).toHaveLength(7);
    expect(result).toMatchObject({
        state: 'failed',
        tasks: {
            'task-1': {
                state: 'failed',
                launches: 7,
                terminalReason: 'budget_exhausted',
            },
        },
    });
});

test('Critical quality rejections consume the same two-correction budget', async () => {
    const approved = manifest('critical');
    const store = new MemoryStore(snapshot(7));
    const client = new QueueDelegationClient([
        workerResponse('implementation'),
        reviewResponse('spec', 'pass'),
        reviewResponse('quality', 'changes_required'),
        workerResponse('quality correction one'),
        reviewResponse('quality', 'changes_required'),
        workerResponse('quality correction two'),
        reviewResponse('quality', 'pass'),
    ]);

    const result = await new SddWorkflow(store, client, () => approved).run(
        'run-1',
        context,
    );

    expect(client.requests.map((request) => request.requestId)).toEqual([
        'run-1:task-1:worker:1',
        'run-1:task-1:spec:1',
        'run-1:task-1:quality:1',
        'run-1:task-1:correction:1',
        'run-1:task-1:quality:2',
        'run-1:task-1:correction:2',
        'run-1:task-1:quality:3',
    ]);
    expect(result.tasks['task-1']).toMatchObject({
        state: 'verified',
        launches: 7,
    });
});

test('Direct waits without delegation and completes only from current non-empty evidence', async () => {
    const planContent = readFileSync(import.meta.path, 'utf8');
    const approved = manifest('direct');
    const store = new MemoryStore(snapshot(0));
    const client = new QueueDelegationClient([]);
    const workflow = new SddWorkflow(store, client, () => approved);

    const awaiting = await workflow.run('run-1', context);

    expect(client.requests).toHaveLength(0);
    expect(awaiting).toMatchObject({
        state: 'running',
        tasks: { 'task-1': { state: 'awaiting_direct_agent', launches: 0 } },
    });
    const evidence = {
        changedFiles: ['src/one.ts'],
        tests: ['src/one.test.ts'],
        commands: ['bun test src/one.test.ts'],
        validationOutput: '1 pass, 0 fail',
        residualRisks: ['none'],
    };
    expect(() =>
        completeDirect(
            workflow,
            'run-1',
            'task-1',
            { ...evidence, commands: [] },
            planContent,
        ),
    ).toThrow('Direct evidence commands must not be empty.');
    expect(store.current.tasks['task-1'].state).toBe('awaiting_direct_agent');

    const completed = completeDirect(
        workflow,
        'run-1',
        'task-1',
        evidence,
        planContent,
    );

    expect(completed).toMatchObject({
        state: 'completed',
        tasks: {
            'task-1': {
                state: 'verified',
                launches: 0,
                directEvidence: evidence,
            },
        },
    });
});

test('Direct rereads the approved plan instead of trusting supplied old bytes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sdd-direct-'));
    const planPath = join(directory, 'plan.md');
    try {
        const oldBytes = 'approved Direct plan';
        writeFileSync(planPath, oldBytes);
        const approved = {
            ...manifest('direct'),
            planPath,
            sourceDigest: createHash('sha256').update(oldBytes).digest('hex'),
        };
        const store = new MemoryStore(snapshot(0));
        const workflow = new SddWorkflow(
            store,
            new QueueDelegationClient([]),
            () => approved,
        );
        await workflow.run('run-1', context);
        writeFileSync(planPath, 'mutated Direct plan');

        expect(() =>
            workflow.completeDirect(
                'run-1',
                'task-1',
                {
                    changedFiles: ['src/one.ts'],
                    tests: ['src/one.test.ts'],
                    commands: ['bun test src/one.test.ts'],
                    validationOutput: '1 pass, 0 fail',
                    residualRisks: ['none'],
                },
                oldBytes,
            ),
        ).toThrow('Source plan changed after approval.');
        expect(store.current.tasks['task-1'].state).toBe(
            'awaiting_direct_agent',
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('uncertain recovery requires an exact typed attestation and applies it atomically', async () => {
    const planContent = readFileSync(import.meta.path, 'utf8');
    const approved = manifest('standard');
    const uncertain = snapshot(4);
    uncertain.state = 'needs_input';
    uncertain.terminalReason = 'uncertain_foreground_delegation';
    uncertain.tasks['task-1'] = {
        id: 'task-1',
        state: 'needs_input',
        launches: 1,
        maxLaunches: 4,
        activeRequestId: 'run-1:task-1:worker:1',
        terminalReason: 'uncertain_foreground_delegation',
    };
    uncertain.consumedIdempotencyKeys = ['run-1:task-1:worker:1'];
    uncertain.plannedDelegations = {
        'run-1:task-1:worker:1': {
            idempotencyKey: 'run-1:task-1:worker:1',
            taskId: 'task-1',
            requestId: 'run-1:task-1:worker:1',
            stage: 'worker',
            attempt: 1,
            plannedAt: '2026-07-21T12:00:00.000Z',
        },
    };
    const store = new MemoryStore(uncertain);
    const client = new QueueDelegationClient([
        reviewResponse('combined', 'pass'),
    ]);
    const workflow = new SddWorkflow(
        store,
        client,
        () => approved,
    );
    const evidence = {
        changedFiles: ['src/one.ts'],
        tests: ['src/one.test.ts'],
        commands: ['bun test src/one.test.ts'],
        validationOutput: '1 pass, 0 fail',
        residualRisks: ['uncertain child response was explicitly attested'],
    };

    expect(() =>
        workflow.completeDirect(
            'run-1',
            'task-1',
            evidence,
            planContent,
        ),
    ).toThrow('Recovery attestation is required.');
    expect(() =>
        workflow.completeDirect('run-1', 'task-1', evidence, planContent, {
            action: 'attest',
            confirmation: true,
            authorizedBy: 'operator',
            requestId: 'run-1:task-1:worker:1',
            stage: 'combined',
        }),
    ).toThrow('Recovery attestation stage does not match');
    expect(store.current).toEqual(uncertain);

    const recovered = workflow.completeDirect(
        'run-1',
        'task-1',
        evidence,
        planContent,
        {
            action: 'attest',
            confirmation: true,
            authorizedBy: 'operator',
            requestId: 'run-1:task-1:worker:1',
            stage: 'worker',
        },
    );

    expect(recovered).toMatchObject({
        revision: uncertain.revision + 1,
        state: 'running',
        tasks: {
            'task-1': {
                state: 'reviewing',
                activeRequestId: undefined,
                appliedResponseRequestIds: ['run-1:task-1:worker:1'],
                recoveryChoice: {
                    action: 'attest',
                    confirmation: true,
                    authorizedBy: 'operator',
                    requestId: 'run-1:task-1:worker:1',
                    stage: 'worker',
                    priorReason: 'uncertain_foreground_delegation',
                    evidence,
                },
                terminalResponses: {
                    'run-1:task-1:worker:1': {
                        requestId: 'run-1:task-1:worker:1',
                        status: 'completed',
                        acceptance: { status: 'accepted', explicit: true },
                    },
                },
            },
        },
    });
    expect(
        recovered.tasks['task-1'].recoveryChoice?.digest,
    ).toMatch(/^[a-f\d]{64}$/);
    expect(
        store.events.filter(
            (event) => event.type === 'recovery-attestation-applied',
        ),
    ).toHaveLength(1);

    const completed = await workflow.run('run-1', context);
    expect(client.requests.map((request) => request.requestId)).toEqual([
        'run-1:task-1:combined:1',
    ]);
    expect(completed).toMatchObject({
        state: 'completed',
        tasks: { 'task-1': { state: 'verified', launches: 2 } },
    });
});

test('Critical specification attestation continues at quality instead of verifying early', async () => {
    const approved = manifest('critical');
    const workerId = 'run-1:task-1:worker:1';
    const specId = 'run-1:task-1:spec:1';
    const uncertain = snapshot(7);
    uncertain.state = 'needs_input';
    uncertain.terminalReason = 'uncertain_foreground_delegation';
    uncertain.tasks['task-1'] = {
        id: 'task-1',
        state: 'needs_input',
        launches: 2,
        maxLaunches: 7,
        activeRequestId: specId,
        terminalReason: 'uncertain_foreground_delegation',
        terminalResponses: {
            [workerId]: { ...workerResponse('implemented'), requestId: workerId },
        },
        appliedResponseRequestIds: [workerId],
    };
    uncertain.consumedIdempotencyKeys = [workerId, specId];
    uncertain.plannedDelegations = {
        [workerId]: {
            idempotencyKey: workerId,
            taskId: 'task-1',
            requestId: workerId,
            stage: 'worker',
            attempt: 1,
            plannedAt: '2026-07-21T12:00:00.000Z',
        },
        [specId]: {
            idempotencyKey: specId,
            taskId: 'task-1',
            requestId: specId,
            stage: 'spec',
            attempt: 1,
            plannedAt: '2026-07-21T12:01:00.000Z',
        },
    };
    const store = new MemoryStore(uncertain);
    const client = new QueueDelegationClient([
        reviewResponse('quality', 'pass'),
    ]);
    const workflow = new SddWorkflow(store, client, () => approved);
    const evidence = {
        changedFiles: ['src/one.ts'],
        tests: ['src/one.test.ts'],
        commands: ['bun test src/one.test.ts'],
        validationOutput: '1 pass, 0 fail',
        residualRisks: ['spec response attested'],
    };

    const recovered = workflow.completeDirect(
        'run-1',
        'task-1',
        evidence,
        '',
        {
            action: 'attest',
            confirmation: true,
            authorizedBy: 'operator',
            requestId: specId,
            stage: 'spec',
        },
    );
    expect(recovered).toMatchObject({
        state: 'running',
        tasks: {
            'task-1': {
                state: 'reviewing',
                appliedReviewRequestIds: [specId],
                reviewResults: {
                    [specId]: { stage: 'spec', verdict: 'pass' },
                },
            },
        },
    });

    const completed = await workflow.run('run-1', context);
    expect(client.requests.map((request) => request.requestId)).toEqual([
        'run-1:task-1:quality:1',
    ]);
    expect(completed.state).toBe('completed');
});

test('correction attestation reruns the rejecting Standard review', async () => {
    const approved = manifest('standard');
    const workerId = 'run-1:task-1:worker:1';
    const reviewId = 'run-1:task-1:combined:1';
    const correctionId = 'run-1:task-1:correction:1';
    const rejectingReview = {
        version: 1 as const,
        taskId: 'task-1',
        stage: 'combined' as const,
        verdict: 'changes_required' as const,
        findings: [
            {
                id: 'combined-finding',
                severity: 'important' as const,
                file: 'src/one.ts',
                message: 'correction required',
            },
        ],
        evidence: ['combined evidence'],
    };
    const uncertain = snapshot(4);
    uncertain.state = 'needs_input';
    uncertain.terminalReason = 'uncertain_foreground_delegation';
    uncertain.tasks['task-1'] = {
        id: 'task-1',
        state: 'needs_input',
        launches: 3,
        maxLaunches: 4,
        activeRequestId: correctionId,
        terminalReason: 'uncertain_foreground_delegation',
        terminalResponses: {
            [workerId]: { ...workerResponse('implemented'), requestId: workerId },
            [reviewId]: {
                ...reviewResponse('combined', 'changes_required'),
                requestId: reviewId,
            },
        },
        appliedResponseRequestIds: [workerId, reviewId],
        reviewResults: { [reviewId]: rejectingReview },
        appliedReviewRequestIds: [reviewId],
    };
    uncertain.consumedIdempotencyKeys = [workerId, reviewId, correctionId];
    uncertain.plannedDelegations = {
        [workerId]: {
            idempotencyKey: workerId,
            taskId: 'task-1',
            requestId: workerId,
            stage: 'worker',
            attempt: 1,
            plannedAt: '2026-07-21T12:00:00.000Z',
        },
        [reviewId]: {
            idempotencyKey: reviewId,
            taskId: 'task-1',
            requestId: reviewId,
            stage: 'combined',
            attempt: 1,
            plannedAt: '2026-07-21T12:00:00.000Z',
        },
        [correctionId]: {
            idempotencyKey: correctionId,
            taskId: 'task-1',
            requestId: correctionId,
            stage: 'correction',
            attempt: 1,
            plannedAt: '2026-07-21T12:00:00.000Z',
        },
    };
    const store = new MemoryStore(uncertain);
    const client = new QueueDelegationClient([
        reviewResponse('combined', 'pass'),
    ]);
    const workflow = new SddWorkflow(store, client, () => approved);
    const evidence = {
        changedFiles: ['src/one.ts'],
        tests: ['src/one.test.ts'],
        commands: ['bun test src/one.test.ts'],
        validationOutput: '1 pass, 0 fail',
        residualRisks: ['correction response attested'],
    };

    const recovered = workflow.completeDirect(
        'run-1',
        'task-1',
        evidence,
        '',
        {
            action: 'attest',
            confirmation: true,
            authorizedBy: 'operator',
            requestId: correctionId,
            stage: 'correction',
        },
    );
    expect(recovered.tasks['task-1']).toMatchObject({
        state: 'reviewing',
        appliedResponseRequestIds: [workerId, reviewId, correctionId],
    });

    const completed = await workflow.run('run-1', context);
    expect(client.requests.map((request) => request.requestId)).toEqual([
        'run-1:task-1:combined:2',
    ]);
    expect(completed.state).toBe('completed');
});

test('recovery retry after atomic save and after continuation never duplicates launches', async () => {
    const approved = manifest('standard');
    const requestId = 'run-1:task-1:worker:1';
    const uncertain = snapshot(4);
    uncertain.state = 'needs_input';
    uncertain.terminalReason = 'uncertain_foreground_delegation';
    uncertain.tasks['task-1'] = {
        id: 'task-1',
        state: 'needs_input',
        launches: 1,
        maxLaunches: 4,
        activeRequestId: requestId,
        terminalReason: 'uncertain_foreground_delegation',
    };
    uncertain.consumedIdempotencyKeys = [requestId];
    uncertain.plannedDelegations = {
        [requestId]: {
            idempotencyKey: requestId,
            taskId: 'task-1',
            requestId,
            stage: 'worker',
            attempt: 1,
            plannedAt: '2026-07-21T12:00:00.000Z',
        },
    };
    const store = new MemoryStore(uncertain);
    const client = new QueueDelegationClient([
        reviewResponse('combined', 'pass'),
    ]);
    const evidence = {
        changedFiles: ['src/one.ts'],
        tests: ['src/one.test.ts'],
        commands: ['bun test src/one.test.ts'],
        validationOutput: '1 pass, 0 fail',
        residualRisks: ['worker response attested'],
    };
    const attestation = {
        action: 'attest' as const,
        confirmation: true as const,
        authorizedBy: 'operator',
        requestId,
        stage: 'worker' as const,
    };
    const first = new SddWorkflow(store, client, () => approved);

    const atomicallySaved = first.completeDirect(
        'run-1',
        'task-1',
        evidence,
        '',
        attestation,
    );
    const revisionAfterSave = atomicallySaved.revision;

    const afterSaveRestart = new SddWorkflow(store, client, () => approved);
    expect(
        afterSaveRestart.completeDirect(
            'run-1',
            'task-1',
            evidence,
            '',
            attestation,
        ).revision,
    ).toBe(revisionAfterSave);
    const completed = await afterSaveRestart.run('run-1', context);
    expect(completed.state).toBe('completed');
    expect(client.requests).toHaveLength(1);

    const afterContinuationRestart = new SddWorkflow(
        store,
        client,
        () => approved,
    );
    const retried = afterContinuationRestart.completeDirect(
        'run-1',
        'task-1',
        evidence,
        '',
        attestation,
    );
    expect((await afterContinuationRestart.run('run-1', context)).revision).toBe(
        retried.revision,
    );
    expect(client.requests).toHaveLength(1);
    expect(
        store.events.filter(
            (event) => event.type === 'recovery-attestation-applied',
        ),
    ).toHaveLength(1);
});

test('all-Direct final evidence leaves the run for one integration review', async () => {
    const planContent = readFileSync(import.meta.path, 'utf8');
    const approved = {
        ...manifest('direct'),
        finalIntegrationReview: true,
        maximumLaunches: 1,
    };
    const store = new MemoryStore(snapshot(0));
    const client = new QueueDelegationClient([integrationResponse('pass')]);
    const workflow = new SddWorkflow(store, client, () => approved);
    const evidence = {
        changedFiles: ['src/one.ts'],
        tests: ['src/one.test.ts'],
        commands: ['bun test src/one.test.ts'],
        validationOutput: '1 pass, 0 fail',
        residualRisks: ['none'],
    };

    await workflow.run('run-1', context);
    const verified = workflow.completeDirect(
        'run-1',
        'task-1',
        evidence,
        planContent,
    );

    expect(verified).toMatchObject({
        state: 'running',
        tasks: { 'task-1': { state: 'verified' } },
    });
    expect(client.requests).toHaveLength(0);

    const completed = await workflow.run('run-1', context);
    expect(client.requests.map((request) => request.requestId)).toEqual([
        'run-1:manifest:integration:1',
    ]);
    expect(completed.state).toBe('completed');
});

test('a mixed manifest ending in Direct waits for final integration review', async () => {
    const planContent = readFileSync(import.meta.path, 'utf8');
    const base = manifest('light');
    const direct: ApprovedManifestTask = {
        ...base.tasks[0]!,
        id: 'task-2',
        title: 'Task two',
        recommendedProfile: 'direct',
        effectiveProfile: 'direct',
        dependencies: ['task-1'],
        files: ['src/two.ts'],
        budgets: {
            initialWorkers: 0,
            correctionWorkers: 0,
            reviewerAttempts: 0,
            maxLaunches: 0,
        },
    };
    const approved: ApprovedManifest = {
        ...base,
        finalIntegrationReview: true,
        maximumLaunches: 2,
        tasks: [base.tasks[0]!, direct],
    };
    const initial = snapshot(1);
    initial.tasks['task-2'] = {
        id: 'task-2',
        state: 'pending',
        launches: 0,
        maxLaunches: 0,
    };
    const store = new MemoryStore(initial);
    const client = new QueueDelegationClient([
        workerResponse('implemented task one'),
        integrationResponse('pass'),
    ]);
    const workflow = new SddWorkflow(store, client, () => approved);

    const awaiting = await workflow.run('run-1', context);
    expect(awaiting.tasks['task-2'].state).toBe('awaiting_direct_agent');

    const verified = workflow.completeDirect(
        'run-1',
        'task-2',
        {
            changedFiles: ['src/two.ts'],
            tests: ['src/two.test.ts'],
            commands: ['bun test src/two.test.ts'],
            validationOutput: '1 pass, 0 fail',
            residualRisks: ['none'],
        },
        planContent,
    );
    expect(verified.state).toBe('running');

    const completed = await workflow.run('run-1', context);
    expect(client.requests.map((request) => request.requestId)).toEqual([
        'run-1:task-1:worker:1',
        'run-1:manifest:integration:1',
    ]);
    expect(completed.state).toBe('completed');
});

test('selectRunnableBatch follows manifest order, dependencies, isolation, and cap', () => {
    const base = manifest('light');
    const task = base.tasks[0]!;
    const makeTask = (
        id: string,
        overrides: Partial<ApprovedManifestTask> = {},
    ): ApprovedManifestTask => ({
        ...task,
        id,
        title: id,
        files: [`src/${id}.ts`],
        parallelEligible: true,
        ...overrides,
    });
    const tasks = [makeTask('task-1'), makeTask('task-2'), makeTask('task-3')];
    const approved: ApprovedManifest = {
        ...base,
        parallelismEnabled: true,
        maxConcurrentWriters: 2,
        tasks,
    };
    const running: RunSnapshot = {
        runId: 'run-1',
        revision: 0,
        state: 'running',
        tasks: Object.fromEntries(
            tasks.map((candidate) => [
                candidate.id,
                {
                    id: candidate.id,
                    state: 'pending',
                    launches: 0,
                    maxLaunches: candidate.budgets.maxLaunches,
                },
            ]),
        ),
        consumedIdempotencyKeys: [],
        plannedDelegations: {},
    };

    expect(
        selectRunnableBatch(approved, running).map((candidate) => candidate.id),
    ).toEqual(['task-1', 'task-2']);

    const directFirst = {
        ...approved,
        tasks: [
            makeTask('direct', {
                effectiveProfile: 'direct',
                budgets: {
                    initialWorkers: 0,
                    correctionWorkers: 0,
                    reviewerAttempts: 0,
                    maxLaunches: 0,
                },
            }),
            ...tasks,
        ],
    };
    const directSnapshot = {
        ...running,
        tasks: {
            direct: {
                id: 'direct',
                state: 'pending' as const,
                launches: 0,
                maxLaunches: 0,
            },
            ...running.tasks,
        },
    };
    expect(
        selectRunnableBatch(directFirst, directSnapshot).map(
            (candidate) => candidate.id,
        ),
    ).toEqual(['direct']);

    for (const overrides of [
        { files: ['src/shared.ts'] },
        { signals: ['shared_infrastructure'] as const },
        { parallelEligible: false },
    ]) {
        const sequential = {
            ...approved,
            tasks: [
                makeTask('task-1', overrides),
                makeTask('task-2',
                    'files' in overrides
                        ? { files: ['src/shared.ts'] }
                        : {},
                ),
            ],
        };
        expect(
            selectRunnableBatch(sequential, running).map(
                (candidate) => candidate.id,
            ),
        ).toEqual(['task-1']);
    }

    const dependency = {
        ...approved,
        tasks: [
            makeTask('task-1'),
            makeTask('task-2', {
                dependencies: ['task-1'],
                parallelEligible: false,
            }),
        ],
    };
    expect(
        selectRunnableBatch(dependency, running).map(
            (candidate) => candidate.id,
        ),
    ).toEqual(['task-1']);
    const afterDependency = structuredClone(running);
    afterDependency.tasks['task-1'].state = 'verified';
    expect(
        selectRunnableBatch(dependency, afterDependency).map(
            (candidate) => candidate.id,
        ),
    ).toEqual(['task-2']);
});

test('run emits every request in an approved parallel batch before awaiting responses', async () => {
    const base = manifest('light');
    const first = { ...base.tasks[0]!, parallelEligible: true };
    const second: ApprovedManifestTask = {
        ...first,
        id: 'task-2',
        title: 'Task two',
        files: ['src/two.ts'],
    };
    const approved: ApprovedManifest = {
        ...base,
        parallelismEnabled: true,
        tasks: [first, second],
        maximumLaunches: 2,
    };
    const initial = snapshot(1);
    initial.tasks['task-2'] = {
        id: 'task-2',
        state: 'pending',
        launches: 0,
        maxLaunches: 1,
    };
    const store = new MemoryStore(initial);
    const requests: SubagentDelegationRequest[] = [];
    const resolvers: Array<(response: SubagentDelegationResponse) => void> = [];
    const client = {
        run(request: SubagentDelegationRequest) {
            requests.push(request);
            return new Promise<SubagentDelegationResponse>((resolve) => {
                resolvers.push(resolve);
            });
        },
        cancel() {},
    };
    const running = new SddWorkflow(store, client, () => approved).run(
        'run-1',
        context,
    );
    await Bun.sleep(0);

    expect(requests.map((request) => request.requestId)).toEqual([
        'run-1:task-1:worker:1',
        'run-1:task-2:worker:1',
    ]);
    for (let index = 0; index < resolvers.length; index++) {
        resolvers[index]!(
            {
                ...workerResponse(`implementation ${index + 1}`),
                requestId: requests[index]!.requestId,
            },
        );
    }

    const result = await running;
    expect(result.state).toBe('completed');
    expect(Object.values(result.tasks).map((task) => task.state)).toEqual([
        'verified',
        'verified',
    ]);
});

function plannedLightSnapshot(
    response?: SubagentDelegationResponse,
): RunSnapshot {
    const requestId = 'run-1:task-1:worker:1';
    return {
        runId: 'run-1',
        revision: response ? 2 : 1,
        state: 'running',
        tasks: {
            'task-1': {
                id: 'task-1',
                state: 'implementing',
                launches: 1,
                maxLaunches: 1,
                ...(response
                    ? { terminalResponses: { [requestId]: response } }
                    : { activeRequestId: requestId }),
            },
        },
        consumedIdempotencyKeys: [requestId],
        plannedDelegations: {
            [requestId]: {
                idempotencyKey: requestId,
                taskId: 'task-1',
                requestId,
                stage: 'worker',
                attempt: 1,
                plannedAt: '2026-07-21T12:00:00.000Z',
            },
        },
    };
}

test('reconcile never relaunches an unterminated foreground delegation', () => {
    const approved = manifest('light');
    const store = new MemoryStore(plannedLightSnapshot());
    const client = new QueueDelegationClient([]);
    const workflow = new SddWorkflow(store, client, () => approved);

    const reconciled = workflow.reconcile('run-1');

    expect(client.requests).toHaveLength(0);
    expect(reconciled).toMatchObject({
        state: 'needs_input',
        tasks: {
            'task-1': {
                state: 'needs_input',
                terminalReason: 'uncertain_foreground_delegation',
            },
        },
    });
});

test('reconcile advances a persisted accepted Light response without delegation', () => {
    const approved = manifest('light');
    const response = {
        ...workerResponse('persisted implementation'),
        requestId: 'run-1:task-1:worker:1',
    };
    const store = new MemoryStore(plannedLightSnapshot(response));
    const client = new QueueDelegationClient([]);
    const workflow = new SddWorkflow(store, client, () => approved);

    const reconciled = workflow.reconcile('run-1');

    expect(client.requests).toHaveLength(0);
    expect(reconciled).toMatchObject({
        state: 'completed',
        tasks: { 'task-1': { state: 'verified', launches: 1 } },
    });
});

test('reconcile completes Light after a crash between reviewing and its response marker', () => {
    const approved = manifest('light');
    const response = {
        ...workerResponse('persisted implementation'),
        requestId: 'run-1:task-1:worker:1',
    };
    const initial = plannedLightSnapshot(response);
    initial.tasks['task-1'].state = 'reviewing';
    const store = new MemoryStore(initial);
    const client = new QueueDelegationClient([]);

    const reconciled = new SddWorkflow(
        store,
        client,
        () => approved,
    ).reconcile('run-1');

    expect(client.requests).toHaveLength(0);
    expect(reconciled).toMatchObject({
        state: 'completed',
        tasks: {
            'task-1': {
                state: 'verified',
                appliedResponseRequestIds: ['run-1:task-1:worker:1'],
            },
        },
    });
});

function persistedReviewSnapshot(
    profile: 'standard' | 'critical',
    stage: 'combined' | 'spec',
    verdict: 'pass' | 'changes_required',
): RunSnapshot {
    const maxLaunches = profile === 'standard' ? 4 : 7;
    const workerId = 'run-1:task-1:worker:1';
    const reviewId = `run-1:task-1:${stage}:1`;
    const reviewTerminal = {
        ...reviewResponse(stage, verdict),
        requestId: reviewId,
    };
    return {
        runId: 'run-1',
        revision: 4,
        state: 'running',
        tasks: {
            'task-1': {
                id: 'task-1',
                state: 'reviewing',
                launches: 2,
                maxLaunches,
                terminalResponses: {
                    [workerId]: {
                        ...workerResponse('persisted implementation'),
                        requestId: workerId,
                    },
                    [reviewId]: reviewTerminal,
                },
                reviewResults: {
                    [reviewId]: JSON.parse(reviewTerminal.output ?? ''),
                },
            },
        },
        consumedIdempotencyKeys: [workerId, reviewId],
        plannedDelegations: {
            [workerId]: {
                idempotencyKey: workerId,
                taskId: 'task-1',
                requestId: workerId,
                stage: 'worker',
                attempt: 1,
                plannedAt: '2026-07-21T12:00:00.000Z',
            },
            [reviewId]: {
                idempotencyKey: reviewId,
                taskId: 'task-1',
                requestId: reviewId,
                stage,
                attempt: 1,
                plannedAt: '2026-07-21T12:01:00.000Z',
            },
        },
    };
}

test('run applies a persisted Critical spec pass once and continues at quality', async () => {
    const approved = manifest('critical');
    const store = new MemoryStore(
        persistedReviewSnapshot('critical', 'spec', 'pass'),
    );
    const client = new QueueDelegationClient([
        reviewResponse('quality', 'pass'),
    ]);

    const result = await new SddWorkflow(store, client, () => approved).run(
        'run-1',
        context,
    );

    expect(client.requests.map((request) => request.requestId)).toEqual([
        'run-1:task-1:quality:1',
    ]);
    expect(result.state).toBe('completed');
    expect(result.tasks['task-1'].appliedReviewRequestIds).toEqual([
        'run-1:task-1:spec:1',
        'run-1:task-1:quality:1',
    ]);
});

test('run resumes after a persisted accepted correction without repeating it', async () => {
    const approved = manifest('standard');
    const initial = persistedReviewSnapshot(
        'standard',
        'combined',
        'changes_required',
    );
    const correctionId = 'run-1:task-1:correction:1';
    initial.revision = 7;
    initial.tasks['task-1'].state = 'fixing';
    initial.tasks['task-1'].launches = 3;
    initial.tasks['task-1'].appliedReviewRequestIds = [
        'run-1:task-1:combined:1',
    ];
    initial.tasks['task-1'].terminalResponses![correctionId] = {
        ...workerResponse('persisted correction'),
        requestId: correctionId,
    };
    initial.consumedIdempotencyKeys.push(correctionId);
    initial.plannedDelegations[correctionId] = {
        idempotencyKey: correctionId,
        taskId: 'task-1',
        requestId: correctionId,
        stage: 'correction',
        attempt: 1,
        plannedAt: '2026-07-21T12:02:00.000Z',
    };
    const store = new MemoryStore(initial);
    const client = new QueueDelegationClient([
        reviewResponse('combined', 'pass'),
    ]);

    const result = await new SddWorkflow(store, client, () => approved).run(
        'run-1',
        context,
    );

    expect(client.requests.map((request) => request.requestId)).toEqual([
        'run-1:task-1:combined:2',
    ]);
    expect(result.state).toBe('completed');
});

test('repeated restart never reapplies an old Standard rejection after correction', () => {
    const approved = manifest('standard');
    const initial = persistedReviewSnapshot(
        'standard',
        'combined',
        'changes_required',
    );
    const workerId = 'run-1:task-1:worker:1';
    const reviewId = 'run-1:task-1:combined:1';
    const correctionId = 'run-1:task-1:correction:1';
    initial.revision = 8;
    initial.tasks['task-1'].state = 'fixing';
    initial.tasks['task-1'].launches = 3;
    initial.tasks['task-1'].appliedReviewRequestIds = [reviewId];
    initial.tasks['task-1'].appliedResponseRequestIds = [workerId, reviewId];
    initial.tasks['task-1'].terminalResponses![correctionId] = {
        ...workerResponse('persisted correction'),
        requestId: correctionId,
    };
    initial.consumedIdempotencyKeys.push(correctionId);
    initial.plannedDelegations[correctionId] = {
        idempotencyKey: correctionId,
        taskId: 'task-1',
        requestId: correctionId,
        stage: 'correction',
        attempt: 1,
        plannedAt: '2026-07-21T12:02:00.000Z',
    };
    const store = new MemoryStore(initial);
    const client = new QueueDelegationClient([]);
    const workflow = new SddWorkflow(store, client, () => approved);

    const first = workflow.reconcile('run-1');
    const second = workflow.reconcile('run-1');

    expect(client.requests).toHaveLength(0);
    expect(first.tasks['task-1']).toMatchObject({
        state: 'reviewing',
        appliedResponseRequestIds: [workerId, reviewId, correctionId],
    });
    expect(second).toEqual(first);
});

test('reconcile skips an obsolete malformed review when its repair is persisted', () => {
    const approved = manifest('standard');
    const initial = persistedReviewSnapshot('standard', 'combined', 'pass');
    const workerId = 'run-1:task-1:worker:1';
    const malformedId = 'run-1:task-1:combined:1';
    const repairedId = 'run-1:task-1:combined:2';
    const repaired = {
        ...reviewResponse('combined', 'pass'),
        requestId: repairedId,
    };
    initial.revision = 6;
    initial.tasks['task-1'].launches = 3;
    initial.tasks['task-1'].appliedResponseRequestIds = [workerId];
    initial.tasks['task-1'].terminalResponses![malformedId] = {
        version: 1,
        requestId: malformedId,
        status: 'completed',
        output: 'not json',
    };
    initial.tasks['task-1'].terminalResponses![repairedId] = repaired;
    initial.tasks['task-1'].reviewResults = {
        [repairedId]: JSON.parse(repaired.output ?? ''),
    };
    initial.consumedIdempotencyKeys.push(repairedId);
    initial.plannedDelegations[repairedId] = {
        idempotencyKey: repairedId,
        taskId: 'task-1',
        requestId: repairedId,
        stage: 'combined',
        attempt: 2,
        plannedAt: '2026-07-21T12:02:00.000Z',
    };
    const store = new MemoryStore(initial);
    const client = new QueueDelegationClient([]);

    const reconciled = new SddWorkflow(
        store,
        client,
        () => approved,
    ).reconcile('run-1');

    expect(client.requests).toHaveLength(0);
    expect(reconciled).toMatchObject({
        state: 'completed',
        tasks: {
            'task-1': {
                state: 'verified',
                appliedResponseRequestIds: [
                    workerId,
                    malformedId,
                    repairedId,
                ],
                appliedReviewRequestIds: [repairedId],
            },
        },
    });
});

test('reconcile completes a crash-interrupted terminal task without reapplying its review', () => {
    const approved = manifest('standard');
    const initial = persistedReviewSnapshot('standard', 'combined', 'pass');
    const reviewId = 'run-1:task-1:combined:1';
    initial.tasks['task-1'].state = 'failed';
    initial.tasks['task-1'].terminalReason = 'invalid_review_output';
    initial.tasks['task-1'].reviewResults = undefined;
    initial.tasks['task-1'].appliedReviewRequestIds = undefined;
    initial.tasks['task-1'].appliedResponseRequestIds = [
        'run-1:task-1:worker:1',
    ];
    initial.tasks['task-1'].terminalResponses![reviewId] = {
        version: 1,
        requestId: reviewId,
        status: 'completed',
        output: 'not json',
    };
    const store = new MemoryStore(initial);
    const workflow = new SddWorkflow(
        store,
        new QueueDelegationClient([]),
        () => approved,
    );

    const reconciled = workflow.reconcile('run-1');

    expect(reconciled).toMatchObject({
        state: 'failed',
        tasks: {
            'task-1': {
                state: 'failed',
                terminalReason: 'invalid_review_output',
            },
        },
    });
});

test('reconcile rejects a repaired Standard rejection with no review capacity', () => {
    const approved = manifest('standard');
    const initial = persistedReviewSnapshot(
        'standard',
        'combined',
        'changes_required',
    );
    const workerId = 'run-1:task-1:worker:1';
    const malformedId = 'run-1:task-1:combined:1';
    const repairedId = 'run-1:task-1:combined:2';
    const repaired = {
        ...reviewResponse('combined', 'changes_required'),
        requestId: repairedId,
    };
    initial.revision = 6;
    initial.tasks['task-1'].launches = 3;
    initial.tasks['task-1'].appliedResponseRequestIds = [workerId];
    initial.tasks['task-1'].terminalResponses![malformedId] = {
        version: 1,
        requestId: malformedId,
        status: 'completed',
        output: 'not json',
    };
    initial.tasks['task-1'].terminalResponses![repairedId] = repaired;
    initial.tasks['task-1'].reviewResults = {
        [repairedId]: JSON.parse(repaired.output ?? ''),
    };
    initial.consumedIdempotencyKeys.push(repairedId);
    initial.plannedDelegations[repairedId] = {
        idempotencyKey: repairedId,
        taskId: 'task-1',
        requestId: repairedId,
        stage: 'combined',
        attempt: 2,
        plannedAt: '2026-07-21T12:02:00.000Z',
    };
    const store = new MemoryStore(initial);
    const client = new QueueDelegationClient([]);

    const reconciled = new SddWorkflow(
        store,
        client,
        () => approved,
    ).reconcile('run-1');

    expect(client.requests).toHaveLength(0);
    expect(reconciled).toMatchObject({
        state: 'failed',
        tasks: {
            'task-1': {
                state: 'failed',
                terminalReason: 'budget_exhausted',
                launches: 3,
            },
        },
    });
});

test('persisted exhausted malformed review fails like the live path', () => {
    const approved = manifest('standard');
    const initial = persistedReviewSnapshot('standard', 'combined', 'pass');
    const reviewId = 'run-1:task-1:combined:1';
    initial.tasks['task-1'].reviewResults = {};
    initial.tasks['task-1'].terminalResponses![reviewId] = {
        version: 1,
        requestId: reviewId,
        status: 'completed',
        output: 'not json',
    };
    const store = new MemoryStore(initial);
    const client = new QueueDelegationClient([]);

    const reconciled = new SddWorkflow(
        store,
        client,
        () => approved,
    ).reconcile('run-1');

    expect(client.requests).toHaveLength(0);
    expect(reconciled).toMatchObject({
        state: 'failed',
        tasks: {
            'task-1': {
                state: 'failed',
                terminalReason: 'invalid_review_output',
            },
        },
    });
});

test('implementing without a persisted delegation plan fails once without looping', async () => {
    const approved = manifest('light');
    const initial = snapshot(1);
    initial.state = 'running';
    initial.tasks['task-1'].state = 'implementing';
    const store = new MemoryStore(initial);
    const client = new QueueDelegationClient([]);
    const workflow = new SddWorkflow(store, client, () => approved);

    const first = await workflow.run('run-1', context);
    const second = await workflow.run('run-1', context);

    expect(client.requests).toHaveLength(0);
    expect(first).toMatchObject({
        state: 'needs_input',
        tasks: {
            'task-1': {
                state: 'needs_input',
                terminalReason: 'missing_delegation_plan',
            },
        },
    });
    expect(second).toEqual(first);
});

test('reconcile applies persisted changes once without calling delegation', () => {
    const approved = manifest('standard');
    const store = new MemoryStore(
        persistedReviewSnapshot(
            'standard',
            'combined',
            'changes_required',
        ),
    );
    const client = new QueueDelegationClient([]);
    const workflow = new SddWorkflow(store, client, () => approved);

    const first = workflow.reconcile('run-1');
    const second = workflow.reconcile('run-1');

    expect(client.requests).toHaveLength(0);
    expect(first.tasks['task-1']).toMatchObject({
        state: 'fixing',
        appliedReviewRequestIds: ['run-1:task-1:combined:1'],
    });
    expect(second).toEqual(first);
});

test('cancel persists one intent before cancelling every active parallel request', async () => {
    const base = manifest('light');
    const first = { ...base.tasks[0]!, parallelEligible: true };
    const second: ApprovedManifestTask = {
        ...first,
        id: 'task-2',
        title: 'Task two',
        files: ['src/two.ts'],
    };
    const approved: ApprovedManifest = {
        ...base,
        parallelismEnabled: true,
        tasks: [first, second],
        maximumLaunches: 2,
    };
    const initial = snapshot(1);
    initial.tasks['task-2'] = {
        id: 'task-2',
        state: 'pending',
        launches: 0,
        maxLaunches: 1,
    };
    const store = new MemoryStore(initial);
    const resolvers = new Map<
        string,
        (response: SubagentDelegationResponse) => void
    >();
    const cancelled: string[] = [];
    const client = {
        run(request: SubagentDelegationRequest) {
            return new Promise<SubagentDelegationResponse>((resolve) => {
                resolvers.set(request.requestId, resolve);
            });
        },
        cancel(requestId: string) {
            expect(store.current.cancellation?.requestIds).toContain(requestId);
            cancelled.push(requestId);
            resolvers.get(requestId)?.({
                version: 1,
                requestId,
                status: 'cancelled',
            });
        },
    };
    const workflow = new SddWorkflow(store, client, () => approved);
    const running = workflow.run('run-1', context);
    await Bun.sleep(0);

    workflow.cancel('run-1');
    workflow.cancel('run-1');
    const result = await running;

    expect(cancelled).toEqual([
        'run-1:task-1:worker:1',
        'run-1:task-2:worker:1',
    ]);
    expect(
        store.events.filter((event) => event.type === 'cancellation-requested'),
    ).toHaveLength(1);
    expect(result.state).toBe('cancelled');
    expect(Object.values(result.tasks).map((task) => task.state)).toEqual([
        'cancelled',
        'cancelled',
    ]);
});

test('non-success terminal policies fail closed without relaunching', async () => {
    for (const status of [
        'failed',
        'timed_out',
        'cancelled',
        'interrupted',
        'turn_budget_exhausted',
        'tool_budget_exhausted',
        'acceptance_failed',
        'invalid_request',
        'unavailable_context',
    ] as const) {
        const approved = manifest('light');
        const store = new MemoryStore(snapshot(1));
        const client = new QueueDelegationClient([
            {
                version: 1,
                requestId: 'replaced-by-fake',
                status,
            },
        ]);

        const result = await new SddWorkflow(store, client, () => approved).run(
            'run-1',
            context,
        );

        const expected =
            status === 'unavailable_context' ? 'needs_input' : 'failed';
        expect(client.requests).toHaveLength(1);
        expect(result.state).toBe(expected);
        expect(result.tasks['task-1']).toMatchObject({
            state: expected,
            terminalReason: status,
        });
    }
});

test('a blocked reviewer pauses without a correction launch', async () => {
    const approved = manifest('standard');
    const store = new MemoryStore(snapshot(4));
    const client = new QueueDelegationClient([
        workerResponse('implementation'),
        reviewResponse('combined', 'blocked'),
    ]);

    const result = await new SddWorkflow(store, client, () => approved).run(
        'run-1',
        context,
    );

    expect(client.requests).toHaveLength(2);
    expect(result).toMatchObject({
        state: 'needs_input',
        tasks: {
            'task-1': {
                state: 'needs_input',
                terminalReason: 'reviewer_blocked',
            },
        },
    });
});

test('a reviewer gets one schema-repair launch within its existing ceiling', async () => {
    const approved = manifest('standard');
    const store = new MemoryStore(snapshot(4));
    const client = new QueueDelegationClient([
        workerResponse('implementation'),
        {
            version: 1,
            requestId: 'replaced-by-fake',
            status: 'completed',
            output: 'not json',
        },
        reviewResponse('combined', 'pass'),
    ]);

    const result = await new SddWorkflow(store, client, () => approved).run(
        'run-1',
        context,
    );

    expect(client.requests.map((request) => request.requestId)).toEqual([
        'run-1:task-1:worker:1',
        'run-1:task-1:combined:1',
        'run-1:task-1:combined:2',
    ]);
    expect(client.requests[2]!.task).toContain('Schema-repair retry: 1');
    expect(client.requests[2]!.task).toContain('Original output: not json');
    expect(result.tasks['task-1']).toMatchObject({
        state: 'verified',
        launches: 3,
    });
});

test('a second malformed review fails visibly without exceeding the ceiling', async () => {
    const approved = manifest('standard');
    const store = new MemoryStore(snapshot(4));
    const malformed: SubagentDelegationResponse = {
        version: 1,
        requestId: 'replaced-by-fake',
        status: 'completed',
        output: 'not json',
    };
    const client = new QueueDelegationClient([
        workerResponse('implementation'),
        malformed,
        malformed,
    ]);

    const result = await new SddWorkflow(store, client, () => approved).run(
        'run-1',
        context,
    );

    expect(client.requests).toHaveLength(3);
    expect(result).toMatchObject({
        state: 'failed',
        tasks: {
            'task-1': {
                state: 'failed',
                terminalReason: 'invalid_review_output',
            },
        },
    });
});

test('a repaired Standard rejection cannot spend a correction without re-review capacity', async () => {
    const approved = manifest('standard');
    const store = new MemoryStore(snapshot(4));
    const client = new QueueDelegationClient([
        workerResponse('implementation'),
        {
            version: 1,
            requestId: 'replaced-by-fake',
            status: 'completed',
            output: 'not json',
        },
        reviewResponse('combined', 'changes_required'),
    ]);

    const result = await new SddWorkflow(store, client, () => approved).run(
        'run-1',
        context,
    );

    expect(client.requests).toHaveLength(3);
    expect(result.tasks['task-1']).toMatchObject({
        state: 'failed',
        launches: 3,
        terminalReason: 'budget_exhausted',
    });
});

test('a Direct singleton pauses later manifest tasks until its handoff completes', async () => {
    const direct = manifest('direct');
    const lightTask: ApprovedManifestTask = {
        ...manifest('light').tasks[0]!,
        id: 'task-2',
        title: 'Task two',
        files: ['src/two.ts'],
    };
    const approved: ApprovedManifest = {
        ...direct,
        tasks: [direct.tasks[0]!, lightTask],
        maximumLaunches: 1,
    };
    const initial = snapshot(0);
    initial.tasks['task-2'] = {
        id: 'task-2',
        state: 'pending',
        launches: 0,
        maxLaunches: 1,
    };
    const store = new MemoryStore(initial);
    const client = new QueueDelegationClient([workerResponse('later task')]);

    const result = await new SddWorkflow(store, client, () => approved).run(
        'run-1',
        context,
    );

    expect(client.requests).toHaveLength(0);
    expect(result.tasks).toMatchObject({
        'task-1': { state: 'awaiting_direct_agent' },
        'task-2': { state: 'pending' },
    });
});
