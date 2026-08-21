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
    SddDelegationRequest as SubagentDelegationRequest,
    SddDelegationResponse as SubagentDelegationResponse,
} from './delegation-contract.ts';
import type { ApprovedManifest, ApprovedManifestTask } from './manifest.ts';
import type { RunEvent, RunSnapshot, TaskVerification } from './state-machine.ts';
import type { TransitionRecord } from './store.ts';
import type { DelegationRunOptions } from './delegation-client.ts';
import type {
    SddDelegationActivityContext,
    SddWorkflowObserver,
} from './workflow-observer.ts';
import {
    completeDirect,
    SddWorkflow,
    selectRunnableBatch,
} from './workflow.ts';
import {
    MAX_VERIFY_OUTPUT_CHARS,
    type VerificationRunResult,
    type VerificationRunner,
} from './verification.ts';

const context = { cwd: process.cwd() } as ExtensionContext;

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
                verify: [{ id: 'test', command: 'true' }],
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

function verificationResult(
    output: string,
    overrides: Partial<VerificationRunResult> = {},
): VerificationRunResult {
    const outputBytes = Buffer.byteLength(output);
    return {
        status: 'completed',
        exitCode: 0,
        output,
        outputSha256: createHash('sha256').update(output).digest('hex'),
        outputBytes,
        truncated: outputBytes > MAX_VERIFY_OUTPUT_CHARS,
        ...overrides,
    };
}

const successfulVerificationRunner = {
    async run() {
        return verificationResult('pass');
    },
};

function persistedPassedVerification(responseRequestId: string) {
    return {
        responseRequestId,
        status: 'passed' as const,
        commands: [
            {
                id: 'test',
                command: 'true',
                cwd: process.cwd(),
                timeoutMs: 600_000,
                status: 'completed' as const,
                exitCode: 0,
                outputPreview: 'pass',
                outputSha256: createHash('sha256').update('pass').digest('hex'),
                outputLength: 4,
                truncated: false,
            },
        ],
    };
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
                acceptance: {
                    status: 'verified',
                    evidenceStatus: 'verified',
                    explicit: true,
                },
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
        cwd: process.cwd(),
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

test('parallel writers settle as a batch before any local verification begins', async () => {
    const base = manifest('light');
    const first = {
        ...base.tasks[0]!,
        id: 'first',
        files: ['src/first.ts'],
        parallelEligible: true,
    };
    const second = {
        ...base.tasks[0]!,
        id: 'second',
        files: ['src/second.ts'],
        parallelEligible: true,
    };
    const approved = {
        ...base,
        parallelismEnabled: true,
        tasks: [first, second],
    };
    const initial = snapshot(1);
    initial.tasks = {
        first: { id: 'first', state: 'pending', launches: 0, maxLaunches: 1 },
        second: { id: 'second', state: 'pending', launches: 0, maxLaunches: 1 },
    };
    let releaseSecond: (() => void) | undefined;
    let signalSecondStarted: (() => void) | undefined;
    const secondIsRunning = new Promise<void>((resolve) => {
        signalSecondStarted = resolve;
    });
    const verificationCalls: string[] = [];
    const client = {
        cancel() {},
        run(request: SubagentDelegationRequest) {
            if (request.requestId.includes(':second:')) {
                signalSecondStarted?.();
                return new Promise<SubagentDelegationResponse>((resolve) => {
                    releaseSecond = () =>
                        resolve({
                            ...workerResponse('second complete'),
                            requestId: request.requestId,
                        });
                });
            }
            return Promise.resolve({
                ...workerResponse('first complete'),
                requestId: request.requestId,
            });
        },
    };
    const workflow = new SddWorkflow(
        new MemoryStore(initial),
        client,
        () => approved,
        undefined,
        undefined,
        {
            async run(input: { command: { id: string } }) {
                verificationCalls.push(input.command.id);
                return verificationResult('pass');
            },
        },
    );

    const running = workflow.run('run-1', context);
    await secondIsRunning;
    await Promise.resolve();
    const callsWhileSecondWrites = [...verificationCalls];
    releaseSecond?.();
    const completed = await running;
    expect(completed.state).toBe('completed');
    expect(callsWhileSecondWrites).toEqual([]);
    expect(verificationCalls).toEqual(['test', 'test']);
});

test('an isolated snapshot routes delegated workers through its recorded worktree', async () => {
    const approved = manifest('light');
    const initial = snapshot(1);
    initial.workspace = {
        mode: 'isolated',
        sourceRoot: '/repo',
        baseCommit: 'a'.repeat(40),
        worktreePath: '/isolated/run-1',
        delivery: { status: 'pending' },
    };
    const store = new MemoryStore(initial);
    const client = new QueueDelegationClient([workerResponse('implemented')]);
    const workspace = {
        resolveExecutionCwd(recorded: RunSnapshot['workspace'], sourceCwd: string) {
            expect(sourceCwd).toBe(process.cwd());
            expect(recorded).toEqual(initial.workspace);
            return '/isolated/run-1';
        },
    };

    const result = await new SddWorkflow(
        store,
        client,
        () => approved,
        undefined,
        workspace,
        successfulVerificationRunner,
    ).run('run-1', context);

    expect(result.state).toBe('completed');
    expect(client.requests[0]?.cwd).toBe('/isolated/run-1');
});

test('an unavailable isolated worktree leaves the run needs_input without delegation', async () => {
    const approved = manifest('light');
    const initial = snapshot(1);
    initial.workspace = {
        mode: 'isolated',
        sourceRoot: '/repo',
        baseCommit: 'a'.repeat(40),
        worktreePath: '/isolated/missing',
        delivery: { status: 'pending' },
    };
    const store = new MemoryStore(initial);
    const client = new QueueDelegationClient([workerResponse('must not run')]);
    const workspace = {
        resolveExecutionCwd() {
            throw new Error('SDD isolated worktree is missing: /isolated/missing.');
        },
    };

    const result = await new SddWorkflow(
        store,
        client,
        () => approved,
        undefined,
        workspace,
        successfulVerificationRunner,
    ).run('run-1', context);

    expect(client.requests).toHaveLength(0);
    expect(result).toMatchObject({
        state: 'needs_input',
        terminalReason: 'SDD isolated worktree is missing: /isolated/missing.',
    });
});

test('an existing isolated run with mixed Direct and delegated tasks fails closed before either can run', async () => {
    const base = manifest('light');
    const delegated = { ...base.tasks[0]!, id: 'delegated', dependencies: ['direct'] };
    const direct = {
        ...base.tasks[0]!,
        id: 'direct',
        effectiveProfile: 'direct' as const,
        recommendedProfile: 'direct' as const,
        dependencies: [],
        budgets: {
            ...base.tasks[0]!.budgets,
            initialWorkers: 0,
            correctionWorkers: 0,
            reviewerAttempts: 0,
            maxLaunches: 0,
        },
    };
    const approved = {
        ...base,
        maximumLaunches: 1,
        tasks: [direct, delegated],
    };
    const initial = snapshot(0);
    initial.tasks = {
        direct: {
            id: 'direct',
            state: 'pending',
            launches: 0,
            maxLaunches: 0,
        },
        delegated: {
            id: 'delegated',
            state: 'pending',
            launches: 0,
            maxLaunches: 1,
        },
    };
    initial.workspace = {
        mode: 'isolated',
        sourceRoot: '/repo',
        baseCommit: 'a'.repeat(40),
        worktreePath: '/isolated/run-1',
        delivery: { status: 'pending' },
    };
    const store = new MemoryStore(initial);
    const client = new QueueDelegationClient([workerResponse('must not run')]);
    const workspace = {
        resolveExecutionCwd() {
            throw new Error('workspace resolution must not run');
        },
    };

    const result = await new SddWorkflow(
        store,
        client,
        () => approved,
        undefined,
        workspace,
        successfulVerificationRunner,
    ).run('run-1', context);

    expect(client.requests).toHaveLength(0);
    expect(result).toMatchObject({
        state: 'needs_input',
        terminalReason: 'isolated_workspace_mixed_profiles',
    });
});

test('an isolated worktree is the cwd for workers, corrections, reviewers, and integration review', async () => {
    const approved = {
        ...manifest('standard'),
        finalIntegrationReview: true,
        maximumLaunches: 5,
    };
    const initial = snapshot(4);
    initial.workspace = {
        mode: 'isolated',
        sourceRoot: '/repo',
        baseCommit: 'a'.repeat(40),
        worktreePath: '/isolated/run-1',
        delivery: { status: 'pending' },
    };
    const store = new MemoryStore(initial);
    const client = new QueueDelegationClient([
        workerResponse('initial implementation'),
        reviewResponse('combined', 'changes_required'),
        workerResponse('corrected implementation'),
        reviewResponse('combined', 'pass'),
        integrationResponse('pass'),
    ]);
    const workspace = {
        resolveExecutionCwd() {
            return '/isolated/run-1';
        },
    };
    const verificationCwds: string[] = [];

    const result = await new SddWorkflow(
        store,
        client,
        () => approved,
        undefined,
        workspace,
        {
            async run(input: { cwd: string }) {
                verificationCwds.push(input.cwd);
                return verificationResult('pass');
            },
        },
    ).run('run-1', context);

    expect(result.state).toBe('completed');
    expect(client.requests).toHaveLength(5);
    expect(client.requests.every((request) => request.cwd === '/isolated/run-1')).toBe(
        true,
    );
    expect(verificationCwds).toEqual(['/isolated/run-1', '/isolated/run-1']);
});

test('records delivery only after an isolated run completed', () => {
    const approved = manifest('light');
    const initial = snapshot(1);
    initial.state = 'completed';
    initial.tasks['task-1'].state = 'verified';
    initial.workspace = {
        mode: 'isolated',
        sourceRoot: '/repo',
        baseCommit: 'a'.repeat(40),
        worktreePath: '/isolated/run-1',
        delivery: { status: 'pending' },
    };
    const store = new MemoryStore(initial);
    const workflow = new SddWorkflow(
        store,
        new QueueDelegationClient([]),
        () => approved,
    );

    const delivered = workflow.recordWorkspaceApplied(
        'run-1',
        'b'.repeat(64),
        '2026-08-02T12:00:00.000Z',
    );

    expect(delivered.workspace?.delivery).toEqual({
        status: 'applied',
        patchDigest: 'b'.repeat(64),
        appliedAt: '2026-08-02T12:00:00.000Z',
    });
});

test('records a matching workspace delivery once when concurrent apply callers converge', () => {
    const approved = manifest('light');
    const initial = snapshot(1);
    initial.state = 'completed';
    initial.tasks['task-1'].state = 'verified';
    initial.workspace = {
        mode: 'isolated',
        sourceRoot: '/repo',
        baseCommit: 'a'.repeat(40),
        worktreePath: '/isolated/run-1',
        delivery: { status: 'pending' },
    };
    const store = new MemoryStore(initial);
    const workflow = new SddWorkflow(
        store,
        new QueueDelegationClient([]),
        () => approved,
    );
    const digest = 'c'.repeat(64);

    const first = workflow.recordWorkspaceApplied(
        'run-1',
        digest,
        '2026-08-02T12:00:00.000Z',
    );
    const second = workflow.recordWorkspaceApplied(
        'run-1',
        digest,
        '2026-08-02T12:00:01.000Z',
    );

    expect(second).toEqual(first);
    expect(store.saves).toHaveLength(1);
    expect(store.events).toHaveLength(1);
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

test('checks a relative approved plan from the source cwd, not the process cwd', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sdd-workflow-relative-'));
    try {
        writeFileSync(join(directory, 'plan.md'), 'approved plan');
        const approved = {
            ...manifest('light'),
            planPath: 'plan.md',
            sourceDigest: createHash('sha256')
                .update('approved plan')
                .digest('hex'),
        };
        const store = new MemoryStore(snapshot(1));
        const client = new QueueDelegationClient([workerResponse('implemented')]);

        const result = await new SddWorkflow(
            store,
            client,
            () => approved,
        ).run('run-1', { cwd: directory } as ExtensionContext);

        expect(result.state).toBe('completed');
        expect(client.requests).toHaveLength(1);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('checks a relative Direct plan from the source cwd before recording evidence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sdd-direct-relative-'));
    try {
        writeFileSync(join(directory, 'plan.md'), 'approved plan');
        const approved = {
            ...manifest('direct'),
            planPath: 'plan.md',
            sourceDigest: createHash('sha256')
                .update('approved plan')
                .digest('hex'),
        };
        const initial = snapshot(0);
        initial.state = 'running';
        initial.tasks['task-1'].state = 'awaiting_direct_agent';
        const store = new MemoryStore(initial);

        const result = new SddWorkflow(
            store,
            new QueueDelegationClient([]),
            () => approved,
        ).completeDirect(
            'run-1',
            'task-1',
            {
                changedFiles: ['src/one.ts'],
                tests: ['bun test one.test.ts'],
                commands: ['bun test one.test.ts'],
                validationOutput: '1 pass, 0 fail',
                residualRisks: ['none'],
            },
            'ignored old bytes',
            undefined,
            directory,
        );

        expect(result.state).toBe('completed');
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
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
        acceptance: {
            status: 'verified',
            evidenceStatus: 'verified',
            explicit: true,
        },
    };
}

function textDoneResponse(): SubagentDelegationResponse {
    return {
        version: 1,
        requestId: 'replaced-by-fake',
        status: 'completed',
        result: { kind: 'text', text: 'done' },
    };
}

test('Light fails closed when a completed text response has no successful local verification', async () => {
    const approved = manifest('light');
    const store = new MemoryStore(snapshot(1));
    const calls: Array<{
        command: { id: string; command: string };
        cwd: string;
        timeoutMs: number;
    }> = [];
    const verificationRunner = {
        async run(input: (typeof calls)[number]) {
            calls.push(input);
            return verificationResult('1 failing test', { exitCode: 1 });
        },
    };
    const result = await new SddWorkflow(
        store,
        new QueueDelegationClient([textDoneResponse()]),
        () => approved,
        undefined,
        undefined,
        verificationRunner,
    ).run('run-1', context);

    expect(calls).toMatchObject([
        {
            command: { id: 'test', command: 'true' },
            cwd: process.cwd(),
            timeoutMs: 600_000,
        },
    ]);
    expect(result).toMatchObject({
        state: 'failed',
        tasks: {
            'task-1': { state: 'failed', terminalReason: 'verification_failed' },
        },
    });
    expect(result.tasks['task-1'].state).not.toBe('verified');
});

test('Light persists only redacted bounded local verification evidence before it becomes verified', async () => {
    const approved = manifest('light');
    const store = new MemoryStore(snapshot(1));
    const verificationRunner = {
        async run() {
            return verificationResult('Bearer top-secret-token');
        },
    };
    const result = await new SddWorkflow(
        store,
        new QueueDelegationClient([textDoneResponse()]),
        () => approved,
        undefined,
        undefined,
        verificationRunner,
    ).run('run-1', context);

    const verification = result.tasks['task-1'].verificationResults?.[
        'run-1:task-1:worker:1'
    ];
    expect(result.tasks['task-1'].state).toBe('verified');
    expect(verification).toMatchObject({ status: 'passed' });
    expect(verification?.commands).toHaveLength(1);
    expect(verification?.commands[0]).toMatchObject({
        outputPreview: '[REDACTED]',
        outputLength: Buffer.byteLength('Bearer top-secret-token'),
        outputSha256: createHash('sha256')
            .update('Bearer top-secret-token')
            .digest('hex'),
    });
    expect(JSON.stringify(store.current)).not.toContain('Bearer top-secret-token');
    expect(JSON.stringify(store.saves)).not.toContain('Bearer top-secret-token');
    expect(JSON.stringify(store.events)).not.toContain('Bearer top-secret-token');
    expect(store.events.some((event) => event.type === 'verification-recorded')).toBe(
        true,
    );
});

test('Light persists runner-provided full-stream digests without retaining distinct secret suffixes', async () => {
    const approved = manifest('light');
    const task = approved.tasks[0]!;
    const prefix = 'x'.repeat(MAX_VERIFY_OUTPUT_CHARS);
    const firstRaw = `${prefix}Bearer first-secret-suffix`;
    const secondRaw = `${prefix}Bearer second-secret-suffix`;
    const first = {
        ...verificationResult(prefix, {
            outputSha256: createHash('sha256').update(firstRaw).digest('hex'),
            outputBytes: Buffer.byteLength(firstRaw),
            truncated: true,
        }),
    };
    const second = {
        ...verificationResult(prefix, {
            outputSha256: createHash('sha256').update(secondRaw).digest('hex'),
            outputBytes: Buffer.byteLength(secondRaw),
            truncated: true,
        }),
    };
    const withTwoCommands: ApprovedManifest = {
        ...approved,
        tasks: [
            {
                ...task,
                verify: [
                    task.verify[0]!,
                    { id: 'second', command: 'second-command' },
                ],
            },
        ],
    };
    const store = new MemoryStore(snapshot(1));
    let calls = 0;
    const result = await new SddWorkflow(
        store,
        new QueueDelegationClient([textDoneResponse()]),
        () => withTwoCommands,
        undefined,
        undefined,
        {
            async run() {
                calls += 1;
                return calls === 1 ? first : second;
            },
        },
    ).run('run-1', context);

    const commands = result.tasks['task-1'].verificationResults?.[
        'run-1:task-1:worker:1'
    ]?.commands;
    expect(result.tasks['task-1'].state).toBe('verified');
    expect(commands).toHaveLength(2);
    expect(commands?.[0]?.outputPreview).toBe(commands?.[1]?.outputPreview);
    expect(commands?.[0]?.outputPreview.length).toBeLessThanOrEqual(
        MAX_VERIFY_OUTPUT_CHARS,
    );
    expect(commands?.map((command) => command.outputSha256)).toEqual([
        createHash('sha256').update(firstRaw).digest('hex'),
        createHash('sha256').update(secondRaw).digest('hex'),
    ]);
    expect(commands?.map((command) => command.outputLength)).toEqual([
        Buffer.byteLength(firstRaw),
        Buffer.byteLength(secondRaw),
    ]);
    expect(JSON.stringify(store.current)).not.toContain('first-secret-suffix');
    expect(JSON.stringify(store.events)).not.toContain('second-secret-suffix');
});

test('Light persists a byte-bounded UTF-8 preview without invalidating complete-stream evidence', async () => {
    const approved = manifest('light');
    const prefix = 'x'.repeat(MAX_VERIFY_OUTPUT_CHARS - 1);
    const raw = `${prefix}éBearer unicode-secret-suffix`;
    const store = new MemoryStore(snapshot(1));
    const result = await new SddWorkflow(
        store,
        new QueueDelegationClient([textDoneResponse()]),
        () => approved,
        undefined,
        undefined,
        {
            async run() {
                return verificationResult(prefix, {
                    outputSha256: createHash('sha256').update(raw).digest('hex'),
                    outputBytes: Buffer.byteLength(raw),
                    truncated: true,
                });
            },
        },
    ).run('run-1', context);

    const command = result.tasks['task-1'].verificationResults?.[
        'run-1:task-1:worker:1'
    ]?.commands[0];
    expect(result.tasks['task-1'].state).toBe('verified');
    expect(command).toMatchObject({
        outputSha256: createHash('sha256').update(raw).digest('hex'),
        outputLength: Buffer.byteLength(raw),
        truncated: true,
    });
    expect(command?.outputPreview).not.toContain('\uFFFD');
    expect(Buffer.byteLength(command?.outputPreview ?? '')).toBeLessThanOrEqual(
        MAX_VERIFY_OUTPUT_CHARS,
    );
    expect(JSON.stringify(store.current)).not.toContain('unicode-secret-suffix');
    expect(JSON.stringify(store.events)).not.toContain('unicode-secret-suffix');
});

test('Light records a local verification timeout and never becomes verified', async () => {
    const approved = manifest('light');
    const store = new MemoryStore(snapshot(1));
    const verificationRunner = {
        async run() {
            return verificationResult('timed out', {
                status: 'timed_out',
                exitCode: null,
            });
        },
    };
    const result = await new SddWorkflow(
        store,
        new QueueDelegationClient([textDoneResponse()]),
        () => approved,
        undefined,
        undefined,
        verificationRunner,
    ).run('run-1', context);

    expect(result).toMatchObject({
        state: 'failed',
        tasks: {
            'task-1': {
                state: 'failed',
                terminalReason: 'verification_timed_out',
            },
        },
    });
});

for (const signal of [false, 'SIGTERM'] as const) {
    test(`Light rejects an invalid verification runner signal shape: ${String(signal)}`, async () => {
        const result = await new SddWorkflow(
            new MemoryStore(snapshot(1)),
            new QueueDelegationClient([textDoneResponse()]),
            () => manifest('light'),
            undefined,
            undefined,
            {
                async run() {
                    return {
                        status: 'completed' as const,
                        exitCode: 0,
                        signal,
                        output: 'pass',
                        truncated: false,
                    };
                },
            } as unknown as VerificationRunner,
        ).run('run-1', context);

        expect(result.tasks['task-1']).toMatchObject({
            state: 'failed',
            terminalReason: 'verification_invalid_output',
        });
    });
}

test('Light never verifies when no approved local verification command can run', async () => {
    const approved = manifest('light');
    const task = approved.tasks[0]!;
    const withoutVerify: ApprovedManifest = {
        ...approved,
        tasks: [{ ...task, verify: [] }],
    };
    const store = new MemoryStore(snapshot(1));
    let calls = 0;
    const verificationRunner = {
        async run() {
            calls += 1;
            return verificationResult('unused');
        },
    };

    const result = await new SddWorkflow(
        store,
        new QueueDelegationClient([textDoneResponse()]),
        () => withoutVerify,
        undefined,
        undefined,
        verificationRunner,
    ).run('run-1', context);

    expect(calls).toBe(0);
    expect(result.tasks['task-1']).toMatchObject({
        state: 'failed',
        terminalReason: 'verification_failed',
    });
});

test('Standard reruns approved local verification after its correction without adding reviewers', async () => {
    const approved = manifest('standard');
    const store = new MemoryStore(snapshot(4));
    const verificationInputs: Array<{ id: string; cwd: string }> = [];
    const verificationRunner = {
        async run(input: { command: { id: string }; cwd: string }) {
            verificationInputs.push({ id: input.command.id, cwd: input.cwd });
            return verificationResult('pass');
        },
    };
    const client = new QueueDelegationClient([
        textDoneResponse(),
        reviewResponse('combined', 'changes_required'),
        textDoneResponse(),
        reviewResponse('combined', 'pass'),
    ]);
    const result = await new SddWorkflow(
        store,
        client,
        () => approved,
        undefined,
        undefined,
        verificationRunner,
    ).run('run-1', context);

    expect(verificationInputs).toEqual([
        { id: 'test', cwd: process.cwd() },
        { id: 'test', cwd: process.cwd() },
    ]);
    expect(client.requests.map((request) => request.requestId)).toEqual([
        'run-1:task-1:worker:1',
        'run-1:task-1:combined:1',
        'run-1:task-1:correction:1',
        'run-1:task-1:combined:2',
    ]);
    expect(result.tasks['task-1'].verificationResults).toMatchObject({
        'run-1:task-1:worker:1': { status: 'passed' },
        'run-1:task-1:correction:1': { status: 'passed' },
    });
});

test('recovery applies persisted local verification without rerunning it', () => {
    const response = {
        ...textDoneResponse(),
        requestId: 'run-1:task-1:worker:1',
    };
    const initial = plannedLightSnapshot(response);
    initial.tasks['task-1'].state = 'reviewing';
    initial.tasks['task-1'].verificationResults = {
        [response.requestId]: {
            responseRequestId: response.requestId,
            status: 'passed',
            commands: [
                {
                    id: 'test',
                    command: 'true',
                    cwd: process.cwd(),
                    timeoutMs: 600_000,
                    status: 'completed',
                    exitCode: 0,
                    outputPreview: 'pass',
                    outputSha256: createHash('sha256').update('pass').digest('hex'),
                    outputLength: 4,
                    truncated: false,
                },
            ],
        },
    };
    const store = new MemoryStore(initial);
    let calls = 0;
    const verificationRunner = {
        async run() {
            calls += 1;
            throw new Error('verification must not rerun after durable recovery');
        },
    };

    const result = new SddWorkflow(
        store,
        new QueueDelegationClient([]),
        () => manifest('light'),
        undefined,
        undefined,
        verificationRunner,
    ).reconcile('run-1', process.cwd());

    expect(calls).toBe(0);
    expect(result.tasks['task-1'].state).toBe('verified');
});

test('recovery fails closed when persisted verification uses a non-canonical command result', () => {
    const response = {
        ...textDoneResponse(),
        requestId: 'run-1:task-1:worker:1',
    };
    const initial = plannedLightSnapshot(response);
    initial.tasks['task-1'].verificationResults![response.requestId] = {
        ...persistedPassedVerification(response.requestId),
        commands: [
            {
                ...persistedPassedVerification(response.requestId).commands[0]!,
                status: 'not_run',
            },
        ],
    };
    let calls = 0;
    const result = new SddWorkflow(
        new MemoryStore(initial),
        new QueueDelegationClient([]),
        () => manifest('light'),
        undefined,
        undefined,
        { async run() { calls += 1; throw new Error('must not rerun'); } },
    ).reconcile('run-1', process.cwd());

    expect(calls).toBe(0);
    expect(result.tasks['task-1']).toMatchObject({
        state: 'needs_input',
        terminalReason: 'verification_evidence_invalid_after_recovery',
    });
});

test('recovery requires the exact durable verification command contract without rerunning', () => {
    const requestId = 'run-1:task-1:worker:1';
    const valid = persistedPassedVerification(requestId);
    const cases: Array<{ name: string; verification: TaskVerification }> = [
        {
            name: 'response request id',
            verification: { ...valid, responseRequestId: 'other-request' },
        },
        { name: 'empty commands', verification: { ...valid, commands: [] } },
        {
            name: 'command text',
            verification: {
                ...valid,
                commands: [{ ...valid.commands[0]!, command: 'false' }],
            },
        },
        {
            name: 'command cwd',
            verification: {
                ...valid,
                commands: [{ ...valid.commands[0]!, cwd: '/wrong-cwd' }],
            },
        },
        {
            name: 'command timeout',
            verification: {
                ...valid,
                commands: [{ ...valid.commands[0]!, timeoutMs: 1 }],
            },
        },
        {
            name: 'exit code',
            verification: {
                ...valid,
                commands: [{ ...valid.commands[0]!, exitCode: 1 }],
            },
        },
        {
            name: 'incoherent truncation',
            verification: {
                ...valid,
                commands: [{ ...valid.commands[0]!, truncated: true }],
            },
        },
        {
            name: 'raw output field',
            verification: {
                ...valid,
                commands: [
                    {
                        ...valid.commands[0]!,
                        output: 'Bearer raw-token-must-not-persist',
                    },
                ],
            } as unknown as TaskVerification,
        },
        {
            name: 'unbounded output length without truncation',
            verification: {
                ...valid,
                commands: [
                    {
                        ...valid.commands[0]!,
                        outputLength: 16_385,
                    },
                ],
            },
        },
        {
            name: 'malformed full-stream digest',
            verification: {
                ...valid,
                commands: [
                    { ...valid.commands[0]!, outputSha256: 'not-a-sha256' },
                ],
            },
        },
        {
            name: 'negative full-stream byte length',
            verification: {
                ...valid,
                commands: [{ ...valid.commands[0]!, outputLength: -1 }],
            },
        },
    ];

    for (const { name, verification } of cases) {
        const initial = plannedLightSnapshot({
            ...textDoneResponse(),
            requestId,
        });
        initial.tasks['task-1'].verificationResults = { [requestId]: verification };
        let calls = 0;
        const result = new SddWorkflow(
            new MemoryStore(initial),
            new QueueDelegationClient([]),
            () => manifest('light'),
            undefined,
            undefined,
            { async run() { calls += 1; throw new Error('must not rerun'); } },
        ).reconcile('run-1', process.cwd());

        expect(calls, name).toBe(0);
        expect(result.tasks['task-1']).toMatchObject({
            state: 'needs_input',
            terminalReason: 'verification_evidence_invalid_after_recovery',
        });
    }
});

test('reconcile fails closed before completing a delegated Light task marked verified without proof', () => {
    const requestId = 'run-1:task-1:worker:1';
    const initial = plannedLightSnapshot({
        ...textDoneResponse(),
        requestId,
    });
    initial.tasks['task-1'].state = 'verified';
    initial.tasks['task-1'].verificationResults = undefined;

    const result = new SddWorkflow(
        new MemoryStore(initial),
        new QueueDelegationClient([]),
        () => manifest('light'),
    ).reconcile('run-1', process.cwd());

    expect(result).toMatchObject({
        state: 'needs_input',
        tasks: {
            'task-1': {
                state: 'needs_input',
                terminalReason: 'verification_missing_after_recovery',
            },
        },
    });
});

test('reconcile rejects applied passed evidence with commands empty without looping', async () => {
    const requestId = 'run-1:task-1:worker:1';
    const initial = plannedLightSnapshot({
        ...textDoneResponse(),
        requestId,
    });
    initial.tasks['task-1'].appliedResponseRequestIds = [requestId];
    initial.tasks['task-1'].verificationResults = {
        [requestId]: {
            ...persistedPassedVerification(requestId),
            commands: [],
        },
    };
    const workflow = new SddWorkflow(
        new MemoryStore(initial),
        new QueueDelegationClient([]),
        () => manifest('light'),
    );

    const result = await Promise.race([
        workflow.run('run-1', context),
        Bun.sleep(250).then(() => {
            throw new Error('reconcile looped on malformed applied verification evidence');
        }),
    ]);

    expect(result).toMatchObject({
        state: 'needs_input',
        tasks: {
            'task-1': {
                state: 'needs_input',
                terminalReason: 'verification_evidence_invalid_after_recovery',
            },
        },
    });
});

test('reconcile fails closed instead of throwing for commands null', () => {
    const requestId = 'run-1:task-1:worker:1';
    const initial = plannedLightSnapshot({
        ...textDoneResponse(),
        requestId,
    });
    initial.tasks['task-1'].verificationResults = {
        [requestId]: {
            ...persistedPassedVerification(requestId),
            commands: null,
        } as unknown as TaskVerification,
    };
    const workflow = new SddWorkflow(
        new MemoryStore(initial),
        new QueueDelegationClient([]),
        () => manifest('light'),
    );

    expect(() => workflow.reconcile('run-1', process.cwd())).not.toThrow();
    expect(workflow.reconcile('run-1', process.cwd()).tasks['task-1']).toMatchObject({
        state: 'needs_input',
        terminalReason: 'verification_evidence_invalid_after_recovery',
    });
});

test('reconcile fails closed instead of throwing for failed evidence commands null entries', () => {
    const requestId = 'run-1:task-1:worker:1';
    const initial = plannedLightSnapshot({
        ...textDoneResponse(),
        requestId,
    });
    initial.tasks['task-1'].appliedResponseRequestIds = [requestId];
    initial.tasks['task-1'].verificationResults = {
        [requestId]: {
            ...persistedPassedVerification(requestId),
            status: 'failed',
            commands: [null],
        } as unknown as TaskVerification,
    };
    const workflow = new SddWorkflow(
        new MemoryStore(initial),
        new QueueDelegationClient([]),
        () => manifest('light'),
    );

    expect(() => workflow.reconcile('run-1', process.cwd())).not.toThrow();
    expect(workflow.reconcile('run-1', process.cwd()).tasks['task-1']).toMatchObject({
        state: 'failed',
        terminalReason: 'verification_evidence_invalid_after_recovery',
    });
});

test('reconcile rejects persisted empty evidence when the manifest has no approved verify command', () => {
    const requestId = 'run-1:task-1:worker:1';
    const approved = manifest('light');
    const noVerify: ApprovedManifest = {
        ...approved,
        tasks: [{ ...approved.tasks[0]!, verify: [] }],
    };
    const initial = plannedLightSnapshot({
        ...textDoneResponse(),
        requestId,
    });
    initial.tasks['task-1'].verificationResults = {
        [requestId]: {
            responseRequestId: requestId,
            status: 'passed',
            commands: [],
        },
    };
    const result = new SddWorkflow(
        new MemoryStore(initial),
        new QueueDelegationClient([]),
        () => noVerify,
    ).reconcile('run-1', process.cwd());

    expect(result).toMatchObject({
        state: 'needs_input',
        tasks: {
            'task-1': {
                state: 'needs_input',
                terminalReason: 'verification_evidence_invalid_after_recovery',
            },
        },
    });
});

test('Light recovery attestation never manufactures verification or completion', async () => {
    const requestId = 'run-1:task-1:worker:1';
    const initial = snapshot(1);
    initial.state = 'needs_input';
    initial.terminalReason = 'uncertain_foreground_delegation';
    initial.tasks['task-1'] = {
        id: 'task-1',
        state: 'needs_input',
        launches: 1,
        maxLaunches: 1,
        activeRequestId: requestId,
        terminalReason: 'uncertain_foreground_delegation',
    };
    initial.consumedIdempotencyKeys = [requestId];
    initial.plannedDelegations = {
        [requestId]: {
            idempotencyKey: requestId,
            taskId: 'task-1',
            requestId,
            stage: 'worker',
            attempt: 1,
            plannedAt: '2026-07-21T12:00:00.000Z',
        },
    };
    const workflow = new SddWorkflow(
        new MemoryStore(initial),
        new QueueDelegationClient([]),
        () => manifest('light'),
    );
    const evidence = {
        changedFiles: ['src/one.ts'],
        tests: ['src/one.test.ts'],
        commands: ['bun test src/one.test.ts'],
        validationOutput: '1 pass, 0 fail',
        residualRisks: ['worker response was uncertain'],
    };
    const attested = workflow.completeDirect('run-1', 'task-1', evidence, '', {
        action: 'attest',
        confirmation: true,
        authorizedBy: 'operator',
        requestId,
        stage: 'worker',
    });

    expect(attested.tasks['task-1']).toMatchObject({ state: 'reviewing' });
    expect(attested.tasks['task-1'].verificationResults).toBeUndefined();
    const result = await workflow.run('run-1', context);
    expect(result).toMatchObject({
        state: 'needs_input',
        tasks: {
            'task-1': {
                state: 'needs_input',
                terminalReason: 'verification_missing_after_recovery',
            },
        },
    });
});

for (const profile of ['standard', 'critical'] as const) {
    test(`${profile} consumes a canonical-worker recovery review without rerunning a reviewer`, async () => {
        const initial =
            profile === 'standard'
                ? persistedReviewSnapshot('standard', 'combined', 'pass')
                : persistedReviewSnapshot('critical', 'spec', 'pass');
        const workerId = 'run-1:task-1:worker:1';
        const reviewId =
            profile === 'standard'
                ? 'run-1:task-1:combined:1'
                : 'run-1:task-1:quality:1';
        initial.state = 'needs_input';
        initial.terminalReason = 'uncertain_foreground_delegation';
        initial.tasks['task-1'] = {
            ...initial.tasks['task-1']!,
            state: 'needs_input',
            activeRequestId: reviewId,
            terminalReason: 'uncertain_foreground_delegation',
            ...(profile === 'standard'
                ? {
                      terminalResponses: {
                          [workerId]: initial.tasks['task-1']!.terminalResponses![workerId]!,
                      },
                      reviewResults: undefined,
                      appliedReviewRequestIds: undefined,
                  }
                : {
                      appliedResponseRequestIds: [workerId],
                      appliedReviewRequestIds: ['run-1:task-1:spec:1'],
                  }),
        };
        if (profile === 'critical') {
            initial.consumedIdempotencyKeys.push(reviewId);
            initial.plannedDelegations[reviewId] = {
                idempotencyKey: reviewId,
                taskId: 'task-1',
                requestId: reviewId,
                stage: 'quality',
                attempt: 1,
                plannedAt: '2026-07-21T12:02:00.000Z',
            };
        }
        const client = new QueueDelegationClient([]);
        const workflow = new SddWorkflow(
            new MemoryStore(initial),
            client,
            () => manifest(profile),
        );
        const evidence = {
            changedFiles: ['src/one.ts'],
            tests: ['src/one.test.ts'],
            commands: ['bun test src/one.test.ts'],
            validationOutput: '1 pass, 0 fail',
            residualRisks: ['review response was uncertain'],
        };

        const attested = workflow.completeDirect('run-1', 'task-1', evidence, '', {
            action: 'attest',
            confirmation: true,
            authorizedBy: 'operator',
            requestId: reviewId,
            stage: profile === 'standard' ? 'combined' : 'quality',
        });
        expect(attested.tasks['task-1']?.state).toBe('reviewing');
        expect(attested.tasks['task-1']?.appliedReviewRequestIds).toContain(reviewId);
        expect(attested.tasks['task-1']?.reviewResults?.[reviewId]).toMatchObject({
            verdict: 'pass',
        });

        const completed = await workflow.run('run-1', context);
        expect(client.requests).toHaveLength(0);
        expect(completed).toMatchObject({
            state: 'completed',
            tasks: { 'task-1': { state: 'verified' } },
        });
    });
}

for (const profile of ['standard', 'critical'] as const) {
    test(`${profile} resumes a crash before correction dispatch without a duplicate reviewing transition`, async () => {
        const approved = manifest(profile);
        const stage = profile === 'standard' ? 'combined' : 'spec';
        const initial = persistedReviewSnapshot(profile, stage, 'changes_required');
        const client = new QueueDelegationClient([
            textDoneResponse(),
            reviewResponse(stage, 'pass'),
            ...(profile === 'critical' ? [reviewResponse('quality', 'pass')] : []),
        ]);

        const result = await new SddWorkflow(
            new MemoryStore(initial),
            client,
            () => approved,
            undefined,
            undefined,
            successfulVerificationRunner,
        ).run('run-1', context);

        expect(client.requests.map((request) => request.requestId)).toEqual(
            profile === 'standard'
                ? ['run-1:task-1:correction:1', 'run-1:task-1:combined:2']
                : [
                      'run-1:task-1:correction:1',
                      'run-1:task-1:spec:2',
                      'run-1:task-1:quality:1',
                  ],
        );
        expect(result.tasks['task-1'].state).toBe('verified');
    });

    test(`${profile} fails closed when its resumed correction verification fails`, async () => {
        const approved = manifest(profile);
        const stage = profile === 'standard' ? 'combined' : 'spec';
        const initial = persistedReviewSnapshot(profile, stage, 'changes_required');
        const client = new QueueDelegationClient([textDoneResponse()]);

        const result = await new SddWorkflow(
            new MemoryStore(initial),
            client,
            () => approved,
            undefined,
            undefined,
            {
                async run() {
                    return verificationResult('failing correction verification', {
                        exitCode: 1,
                    });
                },
            },
        ).run('run-1', context);

        expect(client.requests.map((request) => request.requestId)).toEqual([
            'run-1:task-1:correction:1',
        ]);
        expect(result.tasks['task-1']).toMatchObject({
            state: 'failed',
            terminalReason: 'verification_failed',
        });
    });
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
    expect(
        recovered.tasks['task-1'].recoveryChoice?.digest,
    ).toMatch(/^[a-f\d]{64}$/);
    expect(
        store.events.filter(
            (event) => event.type === 'recovery-attestation-applied',
        ),
    ).toHaveLength(1);

    const completed = await workflow.run('run-1', context);
    expect(client.requests).toHaveLength(0);
    expect(completed).toMatchObject({
        state: 'needs_input',
        tasks: {
            'task-1': {
                state: 'needs_input',
                terminalReason: 'verification_missing_after_recovery',
            },
        },
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
    expect(client.requests).toHaveLength(0);
    expect(completed.tasks['task-1']).toMatchObject({
        state: 'needs_input',
        terminalReason: 'verification_missing_after_recovery',
    });
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
    expect(client.requests).toHaveLength(0);
    expect(completed.tasks['task-1']).toMatchObject({
        state: 'needs_input',
        terminalReason: 'verification_missing_after_recovery',
    });
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
    expect(completed.state).toBe('needs_input');
    expect(client.requests).toHaveLength(0);

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
    expect(client.requests).toHaveLength(0);
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
                    ? {
                          terminalResponses: { [requestId]: response },
                          verificationResults: {
                              [requestId]: persistedPassedVerification(requestId),
                          },
                      }
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

    const reconciled = workflow.reconcile('run-1', process.cwd());

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

    const reconciled = workflow.reconcile('run-1', process.cwd());

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
    ).reconcile('run-1', process.cwd());

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
                verificationResults: {
                    [workerId]: persistedPassedVerification(workerId),
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
    initial.tasks['task-1'].verificationResults![correctionId] =
        persistedPassedVerification(correctionId);
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
    initial.tasks['task-1'].verificationResults![correctionId] =
        persistedPassedVerification(correctionId);
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

    const first = workflow.reconcile('run-1', process.cwd());
    const second = workflow.reconcile('run-1', process.cwd());

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
    ).reconcile('run-1', process.cwd());

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

    const reconciled = workflow.reconcile('run-1', process.cwd());

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
    ).reconcile('run-1', process.cwd());

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
    ).reconcile('run-1', process.cwd());

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

    const first = workflow.reconcile('run-1', process.cwd());
    const second = workflow.reconcile('run-1', process.cwd());

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

test('workflow observation follows durable persistence for worker, reviewer, correction, and integration', async () => {
    const approved = {
        ...manifest('standard'),
        finalIntegrationReview: true,
        maximumLaunches: 5,
    };
    const store = new MemoryStore(snapshot(4));
    const responses = [
        workerResponse('initial implementation'),
        reviewResponse('combined', 'changes_required'),
        workerResponse('corrected implementation'),
        reviewResponse('combined', 'pass'),
        integrationResponse('pass'),
    ];
    const events: string[] = [];
    const observer: SddWorkflowObserver = {
        onSnapshot(observed) {
            expect(store.current).toEqual(observed);
            events.push(`snapshot:${observed.revision}`);
        },
        onDelegationPrepared(activity) {
            expect(
                activity.stage === 'integration'
                    ? store.current.integrationReview?.activeRequestId
                    : store.current.tasks[activity.taskId]?.activeRequestId,
            ).toBe(activity.requestId);
            events.push(`prepared:${activity.stage}`);
        },
        onDelegationStarted(activity) {
            events.push(`started:${activity.stage}`);
        },
        onDelegationUpdate(activity) {
            events.push(`update:${activity.stage}`);
        },
        onDelegationFinished(activity, response) {
            const persisted =
                activity.stage === 'integration'
                    ? store.current.integrationReview?.terminalResponse
                    : store.current.tasks[activity.taskId]?.terminalResponses?.[
                          response.requestId
                      ];
            expect(persisted).toEqual(response);
            events.push(`finished:${activity.stage}`);
        },
    };
    const client = {
        cancel() {},
        async run(
            request: SubagentDelegationRequest,
            options?: DelegationRunOptions,
        ) {
            events.push(`run:${request.requestId}`);
            options?.onStarted?.({
                requestId: request.requestId,
                ownerRunId: request.ownerRunId,
                nodeId: request.nodeId,
            });
            options?.onUpdate?.({
                requestId: request.requestId,
                ownerRunId: request.ownerRunId,
                nodeId: request.nodeId,
                currentTool: 'read',
            });
            const response = responses.shift();
            if (!response) throw new Error('Missing response.');
            return { ...response, requestId: request.requestId };
        },
    };

    const result = await new SddWorkflow(
        store,
        client,
        () => approved,
        observer,
    ).run('run-1', context);

    expect(result.state).toBe('completed');
    expect(
        events.filter((event) => event.startsWith('prepared:')),
    ).toEqual([
        'prepared:worker',
        'prepared:combined',
        'prepared:correction',
        'prepared:combined',
        'prepared:integration',
    ]);
    for (const stage of [
        'worker',
        'combined',
        'correction',
        'integration',
    ]) {
        expect(events.indexOf(`prepared:${stage}`)).toBeLessThan(
            events.indexOf(`started:${stage}`),
        );
        expect(events.indexOf(`started:${stage}`)).toBeLessThan(
            events.indexOf(`finished:${stage}`),
        );
    }
});

test('observer failures never fail or cancel the workflow', async () => {
    const approved = manifest('light');
    const store = new MemoryStore(snapshot(1));
    const client = new QueueDelegationClient([
        workerResponse('implementation'),
    ]);
    const throwing = new Proxy(
        {},
        {
            get: () => () => {
                throw new Error('observer failure');
            },
        },
    ) as SddWorkflowObserver;

    const result = await new SddWorkflow(
        store,
        client,
        () => approved,
        throwing,
    ).run('run-1', context);

    expect(result.state).toBe('completed');
});
