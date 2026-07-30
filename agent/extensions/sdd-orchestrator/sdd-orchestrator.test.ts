import {
    afterEach,
    beforeEach,
    expect,
    mock,
    test,
} from 'bun:test';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { SubagentDelegationResponse } from 'pi-subagents/delegation';
import type { SddConfig } from './config.ts';
import {
    DelegationClient,
    DelegationDisposedError,
    type EventBus,
} from './delegation-client.ts';
import type { ApprovedManifest, DraftManifest } from './manifest.ts';
import type { DirectEvidence, RunSnapshot } from './state-machine.ts';
import { SddStore } from './store.ts';
import {
    collectRunStatuses,
    registerSddExtension,
    shouldContinueAfterReconcile,
    type SddRuntime,
} from './index.ts';

let agentDir: string;
let cwd: string;

beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'sdd-index-agent-'));
    cwd = mkdtempSync(join(tmpdir(), 'sdd-index-cwd-'));
});

afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
});

const config: SddConfig = {
    agents: {
        assessor: 'orchestration-assessor',
        quickWorker: 'quick-worker',
        worker: 'sdd-worker',
        combinedReviewer: 'sdd-combined-reviewer',
        specReviewer: 'sdd-spec-reviewer',
        qualityReviewer: 'sdd-quality-reviewer',
    },
    models: {},
    timeoutsMs: { assessor: 600_000, worker: 2_700_000, reviewer: 900_000 },
    maxConcurrentWriters: 2,
    structuredOutputRetries: 1,
};

const planContent = `# Tool plan

### Task 1: Change one file

~~~sdd-task
{"id":"task-1","dependsOn":[],"files":["src/one.ts"],"verify":[{"id":"one","command":"bun test one"}]}
~~~

Implement one isolated change.
`;

const assessment = JSON.stringify({
    version: 1,
    assessorModel: 'assessor-model',
    tasks: [
        {
            taskId: 'task-1',
            signals: [
                'isolated_scope',
                'clear_requirements',
                'existing_test_pattern',
            ],
            evidence: [
                { signal: 'isolated_scope', source: 'One file is declared.' },
                { signal: 'clear_requirements', source: 'The task is explicit.' },
                {
                    signal: 'existing_test_pattern',
                    source: 'A verification command is declared.',
                },
            ],
            confidence: 'high',
            uncertainties: [],
            advisoryMinimum: 'light',
        },
    ],
});

function context(mode: ExtensionContext['mode'] = 'print'): ExtensionContext {
    return {
        cwd,
        mode,
        ui: { custom: mock() },
    } as unknown as ExtensionContext;
}

function contextWithEntries(
    entries: Array<{ type: string; data: unknown }>,
): ExtensionContext {
    return {
        ...context(),
        sessionManager: {
            getEntries: () =>
                entries.map(({ type, data }) => ({
                    type: 'custom' as const,
                    customType: type,
                    data,
                })),
        },
    } as unknown as ExtensionContext;
}

function fakePi() {
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    const entries: Array<{ type: string; data: unknown }> = [];
    const handlers = new Map<string, Function[]>();
    return {
        api: {
            on(event: string, handler: Function) {
                const registered = handlers.get(event) ?? [];
                registered.push(handler);
                handlers.set(event, registered);
            },
            registerTool(tool: any) {
                tools.set(tool.name, tool);
            },
            registerCommand(name: string, command: any) {
                commands.set(name, command);
            },
            appendEntry(type: string, data: unknown) {
                entries.push({ type, data });
            },
            events: { on: mock(), emit: mock() },
        },
        tools,
        commands,
        entries,
        handlers,
    };
}

class LifecycleEventBus implements EventBus {
    private readonly handlers = new Map<
        string,
        Set<(data: unknown) => void>
    >();

    on(channel: string, handler: (data: unknown) => void): () => void {
        const registered = this.handlers.get(channel) ?? new Set();
        registered.add(handler);
        this.handlers.set(channel, registered);
        return () => registered.delete(handler);
    }

    emit(channel: string, data: unknown): void {
        for (const handler of this.handlers.get(channel) ?? []) handler(data);
    }

    listenerCount(): number {
        return [...this.handlers.values()].reduce(
            (total, handlers) => total + handlers.size,
            0,
        );
    }
}

function snapshot(runId: string, state: RunSnapshot['state'] = 'approved'):
    RunSnapshot {
    return {
        runId,
        revision: 0,
        state,
        tasks: {
            'task-1': {
                id: 'task-1',
                state: 'pending',
                launches: 0,
                maxLaunches: 1,
            },
        },
        consumedIdempotencyKeys: [],
        plannedDelegations: {},
    };
}

function approvedManifest(runId: string): ApprovedManifest {
    return {
        manifestId: runId,
        manifestVersion: 1,
        ruleSetVersion: 1,
        state: 'approved',
        planTitle: 'Approved plan',
        planPath: join(cwd, 'plan.md'),
        sourceDigest: 'source',
        assessmentDigest: 'assessment',
        assessorModel: 'model',
        globalProfile: 'direct',
        parallelismEnabled: true,
        maxConcurrentWriters: 2,
        finalIntegrationReview: false,
        maximumLaunches: 0,
        tasks: [],
        decision: {
            globalProfile: 'direct',
            taskOverrides: {},
            parallelismEnabled: true,
            criticalDowngradeConfirmations: {},
            criticalDowngradeJustifications: {},
            approvedBy: 'operator',
            approvedAt: '2026-07-21T12:00:00.000Z',
        },
        approvalDigest: 'approval',
    };
}

function seedApproved(
    store: SddStore,
    manifest: ApprovedManifest,
    initial: RunSnapshot,
): void {
    const {
        decision: _decision,
        approvalDigest: _approvalDigest,
        ...approvedFields
    } = manifest;
    const draft: DraftManifest = {
        ...approvedFields,
        state: 'awaiting_approval',
    };
    store.createManifest(draft);
    store.approveManifest(draft, manifest, initial);
}

function approvedTask(
    id: string,
    profile: 'direct' | 'light',
    dependencies: readonly string[] = [],
): ApprovedManifest['tasks'][number] {
    return {
        id,
        title: id,
        description: `Implement ${id}.`,
        recommendedProfile: profile,
        effectiveProfile: profile,
        classificationRules: [],
        signals: [],
        dependencies,
        files: [`src/${id}.ts`],
        verify: [{ id: `${id}-test`, command: `bun test ${id}` }],
        budgets:
            profile === 'direct'
                ? {
                      initialWorkers: 0,
                      correctionWorkers: 0,
                      reviewerAttempts: 0,
                      maxLaunches: 0,
                  }
                : {
                      initialWorkers: 1,
                      correctionWorkers: 0,
                      reviewerAttempts: 0,
                      maxLaunches: 1,
                  },
        parallelEligible: dependencies.length === 0,
    };
}

const directEvidence = {
    runId: 'unused',
    taskId: 'task-1',
    changedFiles: ['src/task-1.ts'],
    tests: ['task-1 test'],
    commands: ['bun test task-1'],
    validationOutput: 'pass',
    residualRisks: ['none'],
};

function runtime(
    store: SddStore,
    responses: SubagentDelegationResponse[] = [],
): SddRuntime & { requests: any[]; order: string[]; signals: unknown[] } {
    const requests: any[] = [];
    const order: string[] = [];
    const signals: unknown[] = [];
    return {
        agentDir,
        store,
        config: () => config,
        now: () => '2026-07-21T12:00:00.000Z',
        requests,
        order,
        signals,
        delegation: {
            async run(request) {
                requests.push(request);
                const response = responses.shift();
                if (!response) throw new Error('No fake response.');
                return { ...response, requestId: request.requestId };
            },
            dispose() {
                order.push('dispose');
            },
        },
        workflow: {
            async run(runId, _ctx, signal) {
                order.push('run');
                signals.push(signal);
                const current = store.load(runId);
                if (!current) throw new Error('Run missing before workflow.');
                const manifest = store.loadManifest(runId);
                if (manifest?.state !== 'approved') {
                    throw new Error('Approved manifest missing before workflow.');
                }
                return current;
            },
            cancel(runId) {
                order.push('cancel');
                const current = store.load(runId);
                if (!current) throw new Error('Run missing.');
                return { ...current, state: 'cancelled' as const };
            },
            completeDirect(
                runId: string,
                _taskId: string,
                _evidence: DirectEvidence,
            ) {
                order.push('direct');
                const current = store.load(runId);
                if (!current) throw new Error('Run missing.');
                const completed = {
                    ...current,
                    revision: current.revision + 1,
                    state: 'completed' as const,
                };
                store.save(completed);
                return completed;
            },
            reconcile(runId) {
                order.push(`reconcile:${runId}`);
                const current = store.load(runId);
                if (!current) throw new Error('Run missing.');
                return current;
            },
        },
        openReview: async () => ({ type: 'cancel' }),
    };
}

async function execute(
    tool: any,
    params: unknown,
    ctx = context(),
    signal?: AbortSignal,
) {
    return tool.execute('call-1', params, signal, undefined, ctx);
}

test('registers exactly seven tools and one command from a thin index', () => {
    const pi = fakePi();
    const store = new SddStore(agentDir);
    registerSddExtension(pi.api as never, runtime(store));

    expect([...pi.tools.keys()]).toEqual([
        'sdd_prepare',
        'sdd_submit',
        'sdd_approve',
        'sdd_status',
        'sdd_result',
        'sdd_cancel',
        'sdd_direct_complete',
    ]);
    expect([...pi.commands.keys()]).toEqual(['sdd-review']);
    for (const tool of pi.tools.values()) {
        expect(tool.parameters.additionalProperties).toBe(false);
    }
    expect(
        pi.tools.get('sdd_approve').parameters.properties
            .finalIntegrationReview,
    ).toMatchObject({ type: 'boolean' });
    expect(
        pi.tools.get('sdd_direct_complete').parameters.properties.recovery,
    ).toMatchObject({
        type: 'object',
        required: [
            'action',
            'confirmation',
            'authorizedBy',
            'requestId',
            'stage',
        ],
        additionalProperties: false,
    });

    const source = readFileSync(
        join(import.meta.dir, 'index.ts'),
        'utf8',
    );
    expect(source).not.toContain('authentication_or_authorization');
    expect(source).not.toContain('snapshot.lock-tickets');
    expect(source).not.toMatch(/while\s*\(/);
});

test('prepare performs one bounded JSON repair and stores a complete draft', async () => {
    writeFileSync(join(cwd, 'plan.md'), planContent);
    const store = new SddStore(agentDir);
    const pi = fakePi();
    const rt = runtime(store, [
        { version: 1, requestId: 'ignored', status: 'completed', output: 'bad' },
        {
            version: 1,
            requestId: 'ignored',
            status: 'completed',
            output: assessment,
        },
    ]);
    registerSddExtension(pi.api as never, rt);

    const result = await execute(pi.tools.get('sdd_prepare'), {
        planPath: 'plan.md',
        globalProfile: 'standard',
    });
    const draft = result.details.manifest as DraftManifest;

    expect(rt.requests).toHaveLength(2);
    expect(rt.requests[1].task).toContain('Return only corrected JSON');
    expect(rt.requests[1].task).toContain('Logical job ID:');
    expect(draft).toMatchObject({
        state: 'awaiting_approval',
        planTitle: 'Tool plan',
        globalProfile: 'standard',
        parallelismEnabled: true,
        maxConcurrentWriters: 2,
    });
    expect(store.loadManifest(draft.manifestId)).toEqual(draft);
    expect(result.content[0].text).toContain('sdd_approve');
    await expect(
        execute(pi.tools.get('sdd_prepare'), {
            planPath: 'missing.md',
            globalProfile: 'standard',
        }),
    ).rejects.toThrow();
});

test('prepare accepts and persists a home-relative plan path', async () => {
    const homePlanDir = mkdtempSync(join(homedir(), 'sdd-portable-path-'));
    try {
        writeFileSync(join(homePlanDir, 'plan.md'), planContent);
        const store = new SddStore(agentDir);
        const pi = fakePi();
        const rt = runtime(store, [
            {
                version: 1,
                requestId: 'ignored',
                status: 'completed',
                output: assessment,
            },
        ]);
        registerSddExtension(pi.api as never, rt);

        const input = `~/${relative(homedir(), join(homePlanDir, 'plan.md'))}`;
        const result = await execute(
            pi.tools.get('sdd_prepare'),
            { planPath: input, globalProfile: 'standard' },
            { ...context(), cwd: homePlanDir },
        );
        const draft = result.details.manifest as DraftManifest;

        expect(draft.planPath).toBe(input);
        expect(store.loadManifest(draft.manifestId)?.planPath).toBe(input);
    } finally {
        rmSync(homePlanDir, { recursive: true, force: true });
    }
});

test('prepare reuses one validated assessment for an unchanged plan', async () => {
    writeFileSync(join(cwd, 'plan.md'), planContent);
    const store = new SddStore(agentDir);
    const pi = fakePi();
    const rt = runtime(store, [
        {
            version: 1,
            requestId: 'ignored',
            status: 'completed',
            output: assessment,
        },
    ]);
    registerSddExtension(pi.api as never, rt);

    const first = await execute(pi.tools.get('sdd_prepare'), {
        planPath: 'plan.md',
        globalProfile: 'standard',
    });
    const second = await execute(pi.tools.get('sdd_prepare'), {
        planPath: 'plan.md',
        globalProfile: 'standard',
    });

    expect(rt.requests).toHaveLength(1);
    expect(second.details.manifest).toEqual(first.details.manifest);
});

test('approval stores manifest and run before workflow and appends only the SDD entry', async () => {
    writeFileSync(join(cwd, 'plan.md'), planContent);
    const store = new SddStore(agentDir);
    const pi = fakePi();
    const rt = runtime(store, [
        {
            version: 1,
            requestId: 'ignored',
            status: 'completed',
            output: assessment,
        },
    ]);
    registerSddExtension(pi.api as never, rt);
    const prepared = await execute(pi.tools.get('sdd_prepare'), {
        planPath: 'plan.md',
        globalProfile: 'direct',
    });
    const draft = prepared.details.manifest as DraftManifest;

    const controller = new AbortController();
    const approved = await execute(pi.tools.get('sdd_approve'), {
        manifestId: draft.manifestId,
        globalProfile: 'direct',
        taskOverrides: {},
        parallelismEnabled: true,
        finalIntegrationReview: true,
        criticalDowngradeConfirmations: {},
        criticalDowngradeJustifications: {},
        approvedBy: 'operator',
    }, context(), controller.signal);

    expect(rt.order).toEqual(['run']);
    expect(rt.signals).toEqual([controller.signal]);
    expect(store.loadManifest(draft.manifestId)?.state).toBe('approved');
    expect(
        (store.loadManifest(draft.manifestId) as ApprovedManifest).decision
            .finalIntegrationReview,
    ).toBe(true);
    expect(store.load(draft.manifestId)).not.toBeNull();
    expect(pi.entries).toEqual([
        {
            type: 'sdd:manifest-approved',
            data: expect.objectContaining({
                manifestId: draft.manifestId,
                runId: draft.manifestId,
            }),
        },
    ]);
    expect(pi.entries.some(({ type }) => type === 'plannotator:plan-approved')).toBe(
        false,
    );
    expect(approved.content[0].text).toContain('sdd_direct_complete');
    expect(approved.details.snapshot).toEqual(store.load(draft.manifestId));
});

test('preparing an already approved manifest cannot downgrade it to a draft', async () => {
    writeFileSync(join(cwd, 'plan.md'), planContent);
    const store = new SddStore(agentDir);
    const pi = fakePi();
    const completedAssessment: SubagentDelegationResponse = {
        version: 1,
        requestId: 'ignored',
        status: 'completed',
        output: assessment,
    };
    const rt = runtime(store, [completedAssessment, completedAssessment]);
    registerSddExtension(pi.api as never, rt);
    const prepared = await execute(pi.tools.get('sdd_prepare'), {
        planPath: 'plan.md',
        globalProfile: 'direct',
    });
    const draft = prepared.details.manifest as DraftManifest;
    await execute(pi.tools.get('sdd_approve'), {
        manifestId: draft.manifestId,
        globalProfile: 'direct',
        taskOverrides: {},
        parallelismEnabled: true,
        criticalDowngradeConfirmations: {},
        criticalDowngradeJustifications: {},
        approvedBy: 'operator',
    });
    const approved = store.loadManifest(draft.manifestId);

    await expect(
        execute(pi.tools.get('sdd_prepare'), {
            planPath: 'plan.md',
            globalProfile: 'direct',
        }),
    ).rejects.toThrow(`Manifest ${draft.manifestId} is already approved.`);
    expect(store.loadManifest(draft.manifestId)).toEqual(approved);
});

test('public approval retry matches the persisted decision without duplicate continuation', async () => {
    writeFileSync(join(cwd, 'plan.md'), planContent);
    const store = new SddStore(agentDir);
    const pi = fakePi();
    const base = runtime(store, [
        {
            version: 1,
            requestId: 'ignored',
            status: 'completed',
            output: assessment,
        },
    ]);
    let runCalls = 0;
    const rt: SddRuntime = {
        ...base,
        workflow: {
            ...base.workflow,
            async run(runId) {
                runCalls++;
                const current = store.load(runId);
                if (!current) throw new Error('Run missing after approval.');
                if (runCalls === 1) {
                    store.save({
                        ...current,
                        revision: current.revision + 1,
                        state: 'completed',
                    });
                    throw new Error('injected post-commit workflow failure');
                }
                return current;
            },
        },
    };
    registerSddExtension(pi.api as never, rt);
    const prepared = await execute(pi.tools.get('sdd_prepare'), {
        planPath: 'plan.md',
        globalProfile: 'direct',
    });
    const draft = prepared.details.manifest as DraftManifest;
    const approval = {
        manifestId: draft.manifestId,
        globalProfile: 'direct',
        taskOverrides: {},
        parallelismEnabled: true,
        criticalDowngradeConfirmations: {},
        criticalDowngradeJustifications: {},
        approvedBy: 'operator',
    };

    await expect(
        execute(pi.tools.get('sdd_approve'), approval),
    ).rejects.toThrow('injected post-commit workflow failure');
    expect(store.loadManifest(draft.manifestId)?.state).toBe('approved');
    expect(store.load(draft.manifestId)?.state).toBe('completed');
    expect(pi.entries).toHaveLength(1);

    const retried = await execute(pi.tools.get('sdd_approve'), approval);
    expect(retried.details.snapshot.state).toBe('completed');
    expect(pi.entries).toHaveLength(1);
    expect(runCalls).toBe(1);

    await expect(
        execute(pi.tools.get('sdd_approve'), {
            ...approval,
            globalProfile: 'light',
        }),
    ).rejects.toThrow(`Manifest approval conflict: ${draft.manifestId}.`);
    expect(pi.entries).toHaveLength(1);
    expect(runCalls).toBe(1);
});

test('fresh registration dedupes a prior approval entry despite a later approval timestamp', async () => {
    writeFileSync(join(cwd, 'plan.md'), planContent);
    const store = new SddStore(agentDir);
    const firstPi = fakePi();
    const firstBase = runtime(store, [
        {
            version: 1,
            requestId: 'ignored',
            status: 'completed',
            output: assessment,
        },
    ]);
    const firstRuntime: SddRuntime = {
        ...firstBase,
        now: () => '2026-07-21T12:00:00.000Z',
        workflow: {
            ...firstBase.workflow,
            async run(runId) {
                const current = store.load(runId);
                if (!current) throw new Error('Run missing after approval.');
                const completed: RunSnapshot = {
                    ...current,
                    revision: current.revision + 1,
                    state: 'completed',
                };
                store.save(completed);
                return completed;
            },
        },
    };
    registerSddExtension(firstPi.api as never, firstRuntime);
    const prepared = await execute(firstPi.tools.get('sdd_prepare'), {
        planPath: 'plan.md',
        globalProfile: 'direct',
    });
    const draft = prepared.details.manifest as DraftManifest;
    const approval = {
        manifestId: draft.manifestId,
        globalProfile: 'direct',
        taskOverrides: {},
        parallelismEnabled: true,
        criticalDowngradeConfirmations: {},
        criticalDowngradeJustifications: {},
        approvedBy: 'operator',
    };
    await execute(firstPi.tools.get('sdd_approve'), approval);
    expect(firstPi.entries).toHaveLength(1);

    const reloadedNow = '2026-07-21T13:00:00.000Z';
    expect(
        (store.loadManifest(draft.manifestId) as ApprovedManifest).decision
            .approvedAt,
    ).not.toBe(reloadedNow);
    const reloadedPi = fakePi();
    const reloadedBase = runtime(store);
    let reloadedRunCalls = 0;
    registerSddExtension(reloadedPi.api as never, {
        ...reloadedBase,
        now: () => reloadedNow,
        workflow: {
            ...reloadedBase.workflow,
            async run(runId) {
                reloadedRunCalls++;
                return store.load(runId)!;
            },
        },
    });

    const retried = await execute(
        reloadedPi.tools.get('sdd_approve'),
        approval,
        contextWithEntries(firstPi.entries),
    );

    expect(retried.details.snapshot.state).toBe('completed');
    expect(reloadedPi.entries).toHaveLength(0);
    expect(reloadedRunCalls).toBe(0);
});

test('fresh registration resumes one persisted nonterminal approval exactly once', async () => {
    const runId = 'retry-nonterminal-run';
    const store = new SddStore(agentDir);
    const manifest = approvedManifest(runId);
    const initial: RunSnapshot = {
        ...snapshot(runId, 'approved'),
        tasks: {},
    };
    seedApproved(store, manifest, initial);
    const priorEntries = [
        {
            type: 'sdd:manifest-approved',
            data: {
                manifestId: runId,
                runId,
                approvalDigest: manifest.approvalDigest,
            },
        },
    ];
    const pi = fakePi();
    const base = runtime(store);
    let runCalls = 0;
    registerSddExtension(pi.api as never, {
        ...base,
        now: () => '2026-07-21T13:00:00.000Z',
        workflow: {
            ...base.workflow,
            async run(id) {
                runCalls++;
                const current = store.load(id);
                if (!current) throw new Error('Persisted run missing.');
                const completed: RunSnapshot = {
                    ...current,
                    revision: current.revision + 1,
                    state: 'completed',
                };
                store.save(completed);
                return store.load(id)!;
            },
        },
    });

    const retried = await execute(
        pi.tools.get('sdd_approve'),
        {
            manifestId: runId,
            globalProfile: 'direct',
            taskOverrides: {},
            parallelismEnabled: true,
            criticalDowngradeConfirmations: {},
            criticalDowngradeJustifications: {},
            approvedBy: 'operator',
        },
        contextWithEntries(priorEntries),
    );

    expect(runCalls).toBe(1);
    expect(retried.details.snapshot).toEqual(store.load(runId));
    expect(retried.details.snapshot.state).toBe('completed');
    expect(pi.entries).toHaveLength(0);
});

test('session startup and resume reconcile every nonterminal durable run only', async () => {
    const store = new SddStore(agentDir);
    const uncertain: RunSnapshot = {
        ...snapshot('uncertain-run', 'running'),
        tasks: {
            'task-1': {
                id: 'task-1',
                state: 'implementing',
                launches: 1,
                maxLaunches: 1,
                activeRequestId: 'uncertain-request',
            },
        },
    };
    const persistedTerminal: RunSnapshot = {
        ...snapshot('persisted-run', 'running'),
        tasks: {
            'task-1': {
                id: 'task-1',
                state: 'reviewing',
                launches: 1,
                maxLaunches: 1,
                terminalResponses: {
                    'persisted-request': {
                        version: 1,
                        requestId: 'persisted-request',
                        status: 'completed',
                        acceptance: { status: 'accepted', explicit: true },
                    },
                },
            },
        },
    };
    store.create(uncertain);
    store.create(persistedTerminal);
    store.create(snapshot('terminal-run', 'completed'));
    const pi = fakePi();
    const rt = runtime(store);
    registerSddExtension(pi.api as never, rt);
    const start = pi.handlers.get('session_start')?.[0];
    expect(typeof start).toBe('function');

    await start!({ type: 'session_start', reason: 'startup' }, context());
    expect(rt.order).toEqual([
        'reconcile:persisted-run',
        'reconcile:uncertain-run',
    ]);
    expect(rt.requests).toHaveLength(0);
    rt.order.length = 0;
    await start!({ type: 'session_start', reason: 'resume' }, context());
    expect(rt.order).toEqual([
        'reconcile:persisted-run',
        'reconcile:uncertain-run',
    ]);
    expect(rt.requests).toHaveLength(0);
});

test('subagent child startup leaves parent durable runs untouched', async () => {
    const store = new SddStore(agentDir);
    const activeParentRun: RunSnapshot = {
        ...snapshot('active-parent-run', 'running'),
        tasks: {
            'task-1': {
                id: 'task-1',
                state: 'implementing',
                launches: 1,
                maxLaunches: 1,
                activeRequestId: 'active-parent-request',
            },
        },
    };
    store.create(activeParentRun);
    const pi = fakePi();
    const rt = runtime(store);
    registerSddExtension(pi.api as never, rt);
    const start = pi.handlers.get('session_start')?.[0];
    expect(typeof start).toBe('function');

    const previousChildMarker = process.env.PI_SUBAGENT_CHILD;
    process.env.PI_SUBAGENT_CHILD = '1';
    try {
        await start!({ type: 'session_start', reason: 'startup' }, context());
    } finally {
        if (previousChildMarker === undefined) {
            delete process.env.PI_SUBAGENT_CHILD;
        } else {
            process.env.PI_SUBAGENT_CHILD = previousChildMarker;
        }
    }

    expect(rt.order).toEqual([]);
    expect(store.load(activeParentRun.runId)).toEqual(activeParentRun);
});

test('session startup continues one newly reconciled persisted terminal boundary', async () => {
    const runId = 'persisted-terminal-boundary';
    const requestId = `${runId}:task-1:worker:1`;
    const store = new SddStore(agentDir);
    store.create({
        runId,
        revision: 2,
        state: 'running',
        tasks: {
            'task-1': {
                id: 'task-1',
                state: 'implementing',
                launches: 1,
                maxLaunches: 4,
                terminalResponses: {
                    [requestId]: {
                        version: 1,
                        requestId,
                        status: 'completed',
                        acceptance: { status: 'verified', explicit: true },
                    },
                },
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
    });
    const pi = fakePi();
    const base = runtime(store);
    const order: string[] = [];
    registerSddExtension(pi.api as never, {
        ...base,
        workflow: {
            ...base.workflow,
            reconcile(id) {
                order.push('reconcile');
                const current = store.load(id)!;
                store.save({
                    ...current,
                    revision: current.revision + 1,
                    tasks: {
                        ...current.tasks,
                        'task-1': {
                            ...current.tasks['task-1']!,
                            state: 'reviewing',
                            appliedResponseRequestIds: [requestId],
                        },
                    },
                });
                return store.load(id)!;
            },
            async run(id) {
                order.push('run');
                const current = store.load(id)!;
                store.save({
                    ...current,
                    revision: current.revision + 1,
                    state: 'completed',
                });
                return store.load(id)!;
            },
        },
    });
    const start = pi.handlers.get('session_start')?.[0];

    await start!({ type: 'session_start', reason: 'startup' }, context());
    expect(order).toEqual(['reconcile', 'run']);
    expect(store.load(runId)?.state).toBe('completed');

    await start!({ type: 'session_start', reason: 'resume' }, context());
    expect(order).toEqual(['reconcile', 'run']);
});

test('safe continuation is decided from the current durable post-reconcile snapshot', () => {
    const resumable = snapshot('safe-run', 'running');
    resumable.tasks['task-1'] = {
        id: 'task-1',
        state: 'reviewing',
        launches: 1,
        maxLaunches: 4,
        appliedResponseRequestIds: ['safe-run:task-1:worker:1'],
    };
    expect(shouldContinueAfterReconcile(resumable)).toBe(true);

    const pending = snapshot('pending-run', 'running');
    expect(shouldContinueAfterReconcile(pending)).toBe(true);

    const directWaiting = structuredClone(resumable);
    directWaiting.tasks['task-1'].state = 'awaiting_direct_agent';
    expect(shouldContinueAfterReconcile(directWaiting)).toBe(false);

    const needsInput = structuredClone(resumable);
    needsInput.tasks['task-1'].state = 'needs_input';
    expect(shouldContinueAfterReconcile(needsInput)).toBe(false);

    const uncertain = structuredClone(resumable);
    uncertain.tasks['task-1'].activeRequestId = 'still-active';
    expect(shouldContinueAfterReconcile(uncertain)).toBe(false);

    const unapplied = structuredClone(resumable);
    unapplied.tasks['task-1'].appliedResponseRequestIds = [];
    expect(shouldContinueAfterReconcile(unapplied)).toBe(false);

    const cancelling = structuredClone(resumable);
    cancelling.cancellation = {
        requestedAt: '2026-07-21T12:00:00.000Z',
        requestIds: [],
    };
    expect(shouldContinueAfterReconcile(cancelling)).toBe(false);
});

test('session startup resumes an already-applied boundary without requiring a new reconcile revision', async () => {
    const runId = 'post-apply-pre-run';
    const store = new SddStore(agentDir);
    const current = snapshot(runId, 'running');
    current.tasks['task-1'] = {
        id: 'task-1',
        state: 'reviewing',
        launches: 1,
        maxLaunches: 4,
        appliedResponseRequestIds: [`${runId}:task-1:worker:1`],
    };
    store.create(current);
    const pi = fakePi();
    const base = runtime(store);
    const order: string[] = [];
    registerSddExtension(pi.api as never, {
        ...base,
        workflow: {
            ...base.workflow,
            reconcile(id) {
                order.push('reconcile');
                return store.load(id)!;
            },
            async run(id) {
                order.push('run');
                const loaded = store.load(id)!;
                store.save({ ...loaded, revision: loaded.revision + 1, state: 'completed' });
                return store.load(id)!;
            },
        },
    });
    const start = pi.handlers.get('session_start')?.[0];

    await start!({ type: 'session_start', reason: 'resume' }, context());

    expect(order).toEqual(['reconcile', 'run']);
    expect(store.load(runId)?.state).toBe('completed');
});

test('session shutdown and reload dispose delegation listeners and pending work', async () => {
    const events = new LifecycleEventBus();
    const client = new DelegationClient(events);
    const store = new SddStore(agentDir);
    const base = runtime(store);
    const pi = fakePi();
    registerSddExtension(pi.api as never, {
        ...base,
        delegation: client,
    });
    const pending = client.run({
        version: 1,
        requestId: 'shutdown-request',
        agent: 'worker',
        task: 'Wait for shutdown.',
        context: 'fresh',
        cwd,
    });
    const settled = pending.catch((error: unknown) => error);
    const shutdown = pi.handlers.get('session_shutdown')?.[0];
    if (shutdown) {
        await shutdown(
            { type: 'session_shutdown', reason: 'reload' },
            context(),
        );
    } else {
        client.dispose();
    }

    expect(await settled).toBeInstanceOf(DelegationDisposedError);
    expect(typeof shutdown).toBe('function');
    expect(events.listenerCount()).toBe(0);
});

test('status merges legacy queue read-only and operational tools return snapshots', async () => {
    const store = new SddStore(agentDir);
    writeFileSync(join(cwd, 'plan.md'), planContent);
    const observableManifest = {
        ...approvedManifest('new-run'),
        globalProfile: 'light' as const,
        maximumLaunches: 1,
        tasks: [approvedTask('task-1', 'light')],
    };
    seedApproved(store, observableManifest, snapshot('new-run'));
    const queueDir = join(agentDir, '.sdd', 'queue');
    mkdirSync(queueDir, { recursive: true });
    const legacyPath = join(queueDir, 'legacy-run.json');
    const legacy = {
        runId: 'legacy-run',
        planPath: '/original/legacy-plan.md',
        planTitle: 'Legacy plan',
        queuedAt: '2026-07-20T00:00:00.000Z',
    };
    writeFileSync(legacyPath, JSON.stringify(legacy));
    writeFileSync(join(queueDir, 'malformed.json'), '{not json');
    const duplicate = {
        runId: 'duplicate-legacy',
        planPath: '/first/duplicate-plan.md',
    };
    writeFileSync(
        join(queueDir, 'a-duplicate.json'),
        JSON.stringify(duplicate),
    );
    writeFileSync(
        join(queueDir, 'b-duplicate.json'),
        JSON.stringify({
            ...duplicate,
            planPath: '/second/duplicate-plan.md',
        }),
    );

    expect(collectRunStatuses(store, agentDir)).toEqual([
        snapshot('new-run'),
        { ...duplicate, status: 'legacy_queued' },
        { ...legacy, status: 'legacy_queued' },
    ]);

    const before = readFileSync(legacyPath, 'utf8');
    const pi = fakePi();
    const rt = runtime(store);
    registerSddExtension(pi.api as never, rt);
    const listed = await execute(pi.tools.get('sdd_status'), {});
    expect(listed.details.snapshots).toHaveLength(3);
    expect(listed.details.runs[0]).toMatchObject({
        manifest: { manifestId: 'new-run' },
        snapshot: { runId: 'new-run' },
        selectedProfiles: [{ taskId: 'task-1', profile: 'light' }],
        budgets: [
            {
                taskId: 'task-1',
                launchesConsumed: 0,
                launchesRemaining: 1,
            },
        ],
        qualitativeEstimate: 'short',
    });
    expect(listed.content[0].text).toContain('/original/legacy-plan.md');

    const result = await execute(pi.tools.get('sdd_result'), { runId: 'new-run' });
    expect(result.details.snapshot.runId).toBe('new-run');
    expect(result.details.observation.manifest.manifestId).toBe('new-run');
    const cancelled = await execute(pi.tools.get('sdd_cancel'), {
        runId: 'new-run',
    });
    expect(cancelled.details.snapshot.state).toBe('cancelled');
    const direct = await execute(pi.tools.get('sdd_direct_complete'), {
        runId: 'new-run',
        taskId: 'task-1',
        changedFiles: ['src/one.ts'],
        tests: ['one test'],
        commands: ['bun test one'],
        validationOutput: 'pass',
        residualRisks: ['none'],
    });
    expect(direct.details.snapshot.state).toBe('completed');
    expect(readFileSync(legacyPath, 'utf8')).toBe(before);
});

test('status exposes the exact blocked worker output', async () => {
    const store = new SddStore(agentDir);
    const runId = 'blocked-run';
    const manifest = {
        ...approvedManifest(runId),
        globalProfile: 'light' as const,
        maximumLaunches: 1,
        tasks: [approvedTask('task-1', 'light')],
    };
    const blocked = snapshot(runId);
    blocked.state = 'needs_input';
    blocked.terminalReason = 'worker_blocked';
    blocked.tasks['task-1'] = {
        id: 'task-1',
        state: 'needs_input',
        launches: 1,
        maxLaunches: 1,
        terminalReason: 'worker_blocked',
        terminalResponses: {
            'blocked-request': {
                version: 1,
                requestId: 'blocked-request',
                status: 'acceptance_failed',
                output: 'BLOCKED: choose the public API shape',
            },
        },
    };
    seedApproved(store, manifest, blocked);
    const pi = fakePi();
    registerSddExtension(pi.api as never, runtime(store));

    const listed = await execute(pi.tools.get('sdd_status'), { runId });

    expect(listed.details.observation).toMatchObject({
        blockedDecision: 'worker_blocked',
        blockedOutput: 'BLOCKED: choose the public API shape',
    });
});

test('targeted status and result expose task, review, and acceptance evidence to the model', async () => {
    const store = new SddStore(agentDir);
    const runId = 'completed-run';
    const task = {
        ...approvedTask('task-1', 'light'),
        recommendedProfile: 'standard' as const,
        effectiveProfile: 'standard' as const,
        budgets: {
            initialWorkers: 1,
            correctionWorkers: 1,
            reviewerAttempts: 2,
            maxLaunches: 4,
        },
    };
    const completed = snapshot(runId, 'completed');
    completed.tasks['task-1'] = {
        id: 'task-1',
        state: 'verified',
        launches: 2,
        maxLaunches: 4,
        reviewResults: {
            'review-1': {
                version: 1,
                taskId: 'task-1',
                stage: 'combined',
                verdict: 'pass',
                findings: [],
                evidence: ['Focused tests passed.'],
            },
        },
        terminalResponses: {
            'worker-1': {
                version: 1,
                requestId: 'worker-1',
                status: 'completed',
                runId: 'child-1',
                acceptance: { status: 'verified', explicit: true },
            },
        },
    };
    seedApproved(
        store,
        {
            ...approvedManifest(runId),
            globalProfile: 'standard',
            maximumLaunches: 4,
            tasks: [task],
        },
        completed,
    );
    const pi = fakePi();
    registerSddExtension(pi.api as never, runtime(store));

    const status = await execute(pi.tools.get('sdd_status'), { runId });
    const result = await execute(pi.tools.get('sdd_result'), { runId });

    for (const output of [status.content[0].text, result.content[0].text]) {
        expect(output).toContain(`${runId}: completed`);
        expect(output).toContain(
            'task-1: verified [standard], launches 2/4',
        );
        expect(output).toContain(
            'task-1/combined: pass, findings 0, evidence 1',
        );
        expect(output).toContain(
            'task-1: completed, acceptance verified, child child-1',
        );
        expect(output).toContain('active requests: none');
    }
});

test('Direct completion resumes a dependent task and returns the durable result', async () => {
    const runId = 'mixed-direct-run';
    writeFileSync(join(cwd, 'plan.md'), planContent);
    const store = new SddStore(agentDir);
    const initial: RunSnapshot = {
        ...snapshot(runId, 'running'),
        tasks: {
            'task-1': {
                id: 'task-1',
                state: 'awaiting_direct_agent',
                launches: 0,
                maxLaunches: 0,
            },
            'task-2': {
                id: 'task-2',
                state: 'pending',
                launches: 0,
                maxLaunches: 1,
            },
        },
    };
    const manifest: ApprovedManifest = {
        ...approvedManifest(runId),
        maximumLaunches: 1,
        tasks: [
            approvedTask('task-1', 'direct'),
            approvedTask('task-2', 'light', ['task-1']),
        ],
    };
    seedApproved(store, manifest, initial);
    const afterEvidence: RunSnapshot = {
        ...initial,
        revision: 1,
        tasks: {
            ...initial.tasks,
            'task-1': { ...initial.tasks['task-1']!, state: 'verified' },
        },
    };
    const resumed: RunSnapshot = {
        ...afterEvidence,
        revision: 2,
        state: 'completed',
        tasks: {
            ...afterEvidence.tasks,
            'task-2': {
                ...afterEvidence.tasks['task-2']!,
                state: 'verified',
                launches: 1,
            },
        },
    };
    const order: string[] = [];
    const base = runtime(store);
    const rt: SddRuntime = {
        ...base,
        workflow: {
            ...base.workflow,
            completeDirect() {
                order.push('direct');
                store.save(afterEvidence);
                return afterEvidence;
            },
            async run() {
                order.push('run');
                store.save(resumed);
                return store.load(runId)!;
            },
        },
    };
    const pi = fakePi();
    registerSddExtension(pi.api as never, rt);

    const result = await execute(pi.tools.get('sdd_direct_complete'), {
        ...directEvidence,
        runId,
    });

    expect(order).toEqual(['direct', 'run']);
    expect(result.details.snapshot).toEqual(resumed);
    expect(store.load(runId)).toEqual(resumed);
});

test('Direct completion resumes the required final integration review', async () => {
    const runId = 'direct-integration-run';
    writeFileSync(join(cwd, 'plan.md'), planContent);
    const store = new SddStore(agentDir);
    const initial: RunSnapshot = {
        ...snapshot(runId, 'running'),
        tasks: {
            'task-1': {
                id: 'task-1',
                state: 'awaiting_direct_agent',
                launches: 0,
                maxLaunches: 0,
            },
        },
    };
    const manifest: ApprovedManifest = {
        ...approvedManifest(runId),
        finalIntegrationReview: true,
        maximumLaunches: 1,
        tasks: [approvedTask('task-1', 'direct')],
    };
    seedApproved(store, manifest, initial);
    const afterEvidence: RunSnapshot = {
        ...initial,
        revision: 1,
        tasks: {
            'task-1': { ...initial.tasks['task-1']!, state: 'verified' },
        },
    };
    const integrated: RunSnapshot = {
        ...afterEvidence,
        revision: 2,
        state: 'completed',
        integrationReview: { launches: 1, applied: true },
    };
    const order: string[] = [];
    const base = runtime(store);
    const rt: SddRuntime = {
        ...base,
        workflow: {
            ...base.workflow,
            completeDirect() {
                order.push('direct');
                store.save(afterEvidence);
                return afterEvidence;
            },
            async run() {
                order.push('integration');
                store.save(integrated);
                return store.load(runId)!;
            },
        },
    };
    const pi = fakePi();
    registerSddExtension(pi.api as never, rt);

    const result = await execute(pi.tools.get('sdd_direct_complete'), {
        ...directEvidence,
        runId,
    });

    expect(order).toEqual(['direct', 'integration']);
    expect(result.details.snapshot).toEqual(integrated);
    expect(store.load(runId)).toEqual(integrated);
});

test('rejected or stale Direct evidence never resumes the workflow', async () => {
    writeFileSync(join(cwd, 'plan.md'), planContent);
    for (const [index, message] of [
        'Direct evidence commands must not be empty.',
        'Source plan changed after approval.',
    ].entries()) {
        const runId = `rejected-direct-${index}`;
        const store = new SddStore(agentDir);
        const manifest: ApprovedManifest = {
            ...approvedManifest(runId),
            tasks: [approvedTask('task-1', 'direct')],
        };
        seedApproved(store, manifest, snapshot(runId, 'running'));
        const run = mock(async () => snapshot(runId));
        const base = runtime(store);
        const rt: SddRuntime = {
            ...base,
            workflow: {
                ...base.workflow,
                completeDirect() {
                    throw new Error(message);
                },
                run,
            },
        };
        const pi = fakePi();
        registerSddExtension(pi.api as never, rt);

        await expect(
            execute(pi.tools.get('sdd_direct_complete'), {
                ...directEvidence,
                runId,
            }),
        ).rejects.toThrow(message);
        expect(run).not.toHaveBeenCalled();
    }
});

test('legacy submit delegates to prepare with Standard and never writes queue state', async () => {
    writeFileSync(join(cwd, 'plan.md'), planContent);
    const store = new SddStore(agentDir);
    const pi = fakePi();
    const rt = runtime(store, [
        {
            version: 1,
            requestId: 'ignored',
            status: 'completed',
            output: assessment,
        },
    ]);
    registerSddExtension(pi.api as never, rt);

    const result = await execute(pi.tools.get('sdd_submit'), {
        planPath: 'plan.md',
    });
    const draft = result.details.manifest as DraftManifest;
    expect(result.content[0].text).toStartWith('Deprecated:');
    expect(draft.globalProfile).toBe('standard');
    expect(existsSync(join(agentDir, '.sdd', 'queue'))).toBe(false);
});

function runtimeWithProgress(
    store: SddStore,
    response: SubagentDelegationResponse,
): SddRuntime & {
    delegationRunOptions: Array<Record<string, unknown> | undefined>;
} {
    const delegationRunOptions: Array<Record<string, unknown> | undefined> = [];
    return {
        agentDir,
        store,
        config: () => config,
        now: () => '2026-07-21T12:00:00.000Z',
        delegationRunOptions,
        delegation: {
            async run(request: any, options?: any) {
                delegationRunOptions.push(options);
                if (options?.onUpdate) {
                    options.onUpdate({
                        version: 1,
                        requestId: request.requestId,
                        currentTool: 'grep',
                        durationMs: 1200,
                    });
                }
                return { ...response, requestId: request.requestId };
            },
            dispose() {},
        },
        workflow: {
            async run(runId: string) {
                return store.load(runId)!;
            },
            cancel(runId: string) {
                return store.load(runId)!;
            },
            completeDirect(runId: string) {
                return store.load(runId)!;
            },
            reconcile(runId: string) {
                return store.load(runId)!;
            },
        },
        openReview: async () => ({ type: 'cancel' }),
    };
}

function contextTui(
    statusCalls: string[],
    workingCalls: string[],
): ExtensionContext {
    return {
        cwd,
        mode: 'tui',
        ui: {
            custom: mock(),
            setStatus: (key: string, text: string | undefined) => {
                statusCalls.push(`${key}=${text ?? '<cleared>'}`);
            },
            setWorkingMessage: (message?: string) => {
                workingCalls.push(message ?? '<default>');
            },
            theme: { fg: (c: string, t: string) => `[${c}|${t}]` } as never,
        },
    } as unknown as ExtensionContext;
}

function runtimeWithProgressResponses(
    store: SddStore,
    responses: SubagentDelegationResponse[],
    seen: string[],
): SddRuntime & {
    seen: string[];
} {
    const queue = [...responses];
    return {
        agentDir,
        store,
        config: () => config,
        now: () => '2026-07-21T12:00:00.000Z',
        seen,
        delegation: {
            async run(request: any, options?: any) {
                const response = queue.shift();
                if (!response) throw new Error('No fake response.');
                seen.push(request.requestId);
                if (options?.onUpdate) {
                    options.onUpdate({
                        version: 1,
                        requestId: request.requestId,
                        currentTool: 'grep',
                        durationMs: 1200,
                    });
                }
                return { ...response, requestId: request.requestId };
            },
            dispose() {},
        },
        workflow: {
            async run(runId: string) {
                return store.load(runId)!;
            },
            cancel(runId: string) {
                return store.load(runId)!;
            },
            completeDirect(runId: string) {
                return store.load(runId)!;
            },
            reconcile(runId: string) {
                return store.load(runId)!;
            },
        },
        openReview: async () => ({ type: 'cancel' }),
    } as SddRuntime & { seen: string[] };
}

function seedRun(
    store: SddStore,
    runId: string,
    state: RunSnapshot['state'],
): void {
    const m = approvedManifest(runId);
    const snap = snapshot(runId, state);
    seedApproved(store, m, snap);
}

test('prepare threads assessor progress into setStatus and setWorkingMessage during assess', async () => {
    writeFileSync(join(cwd, 'plan.md'), planContent);
    const store = new SddStore(agentDir);
    const pi = fakePi();
    const rt = runtimeWithProgress(store, {
        version: 1,
        requestId: 'ignored',
        status: 'completed',
        output: assessment,
    });
    registerSddExtension(pi.api as never, rt);

    const statusCalls: string[] = [];
    const workingCalls: string[] = [];
    const ctx = contextTui(statusCalls, workingCalls);

    await execute(pi.tools.get('sdd_prepare'), {
        planPath: 'plan.md',
        globalProfile: 'standard',
    }, ctx);

    // Delegation received onUpdate/onStarted options (threaded through cache).
    expect(rt.delegationRunOptions).toHaveLength(1);
    expect(rt.delegationRunOptions[0]).toHaveProperty('onUpdate');
    expect(rt.delegationRunOptions[0]).toHaveProperty('onStarted');

    // Spinner message transitions through assess stages.
    expect(workingCalls).toEqual(
        expect.arrayContaining([
            'reading plan',
            'assessing (attempt 1)',
            'parsing assessment',
            'compiling manifest',
        ]),
    );

    // setStatus got the themed assessor line with currentTool from onUpdate.
    expect(statusCalls.some((call) => call.startsWith('sdd-prepare='))).toBe(
        true,
    );
    expect(
        statusCalls.some((call) => call.includes('grep') && call.includes('attempt 1')),
    ).toBe(true);

    // finally clears the status and restores the default spinner.
    expect(statusCalls.at(-1)).toBe('sdd-prepare=<cleared>');
    expect(workingCalls.at(-1)).toBe('<default>');
});

test('prepare non-TUI emits themed partials via onUpdate instead of setStatus', async () => {
    writeFileSync(join(cwd, 'plan.md'), planContent);
    const store = new SddStore(agentDir);
    const pi = fakePi();
    const rt = runtimeWithProgress(store, {
        version: 1,
        requestId: 'ignored',
        status: 'completed',
        output: assessment,
    });
    registerSddExtension(pi.api as never, rt);

    const updates: unknown[] = [];
    const onUpdate = (partial: any) => updates.push(partial);
    const result = (pi.tools.get('sdd_prepare') as any).execute(
        'call-1',
        { planPath: 'plan.md', globalProfile: 'standard' },
        undefined,
        onUpdate,
        context(),
    );
    await result;

    expect(updates.length).toBeGreaterThan(0);
    expect(updates.some((u: any) => /assess/i.test(u.content?.[0]?.text ?? ''))).toBe(
        true,
    );
});

test('prepare reports the assessment cached stage on a cache hit (not a misleading status line)', async () => {
    writeFileSync(join(cwd, 'plan.md'), planContent);
    const store = new SddStore(agentDir);
    const pi = fakePi();
    const rt = runtimeWithProgress(store, {
        version: 1,
        requestId: 'ignored',
        status: 'completed',
        output: assessment,
    });
    registerSddExtension(pi.api as never, rt);

    const statusCalls: string[] = [];
    const workingCalls: string[] = [];
    // First prepare warms the cache.
    await execute(
        pi.tools.get('sdd_prepare'),
        { planPath: 'plan.md', globalProfile: 'standard' },
        contextTui(statusCalls, workingCalls),
    );
    workingCalls.length = 0;
    statusCalls.length = 0;
    // Second prepare must hit the cache.
    await execute(
        pi.tools.get('sdd_prepare'),
        { planPath: 'plan.md', globalProfile: 'standard' },
        contextTui(statusCalls, workingCalls),
    );
    expect(workingCalls).toContain('assessment cached');
    expect(statusCalls.some((c) => c.includes('attempt 1') && c.includes('cached'))).toBe(false);
    expect(statusCalls.at(-1)).toBe('sdd-prepare=<cleared>');
});

test('prepare retries surface attempt 2 in the status line after a failed first attempt', async () => {
    writeFileSync(join(cwd, 'plan.md'), planContent);
    const store = new SddStore(agentDir);
    // One invalid then one valid response → structuredOutputRetries=1 allows one repair.
    const seen: string[] = [];
    const rt = runtimeWithProgressResponses(
        store,
        [
            { version: 1, requestId: 'r1', status: 'completed', output: 'bad' },
            { version: 1, requestId: 'r2', status: 'completed', output: assessment },
        ],
        seen,
    );
    const pi = fakePi();
    registerSddExtension(pi.api as never, rt);

    const statusCalls: string[] = [];
    const workingCalls: string[] = [];
    await execute(
        pi.tools.get('sdd_prepare'),
        { planPath: 'plan.md', globalProfile: 'standard' },
        contextTui(statusCalls, workingCalls),
    );
    expect(statusCalls.some((c) => c.includes('attempt 1'))).toBe(true);
    expect(statusCalls.some((c) => c.includes('attempt 2'))).toBe(true);
    expect(statusCalls.at(-1)).toBe('sdd-prepare=<cleared>');
});

test('prepare clears progress in finally even when delegation rejects', async () => {
    writeFileSync(join(cwd, 'plan.md'), planContent);
    const store = new SddStore(agentDir);
    const seen: string[] = [];
    const rt = runtimeWithProgressResponses(
        store,
        [], // empty queue → delegation.run throws "No fake response."
        seen,
    );
    const pi = fakePi();
    registerSddExtension(pi.api as never, rt);

    const statusCalls: string[] = [];
    const workingCalls: string[] = [];
    await expect(
        execute(
            pi.tools.get('sdd_prepare'),
            { planPath: 'plan.md', globalProfile: 'standard' },
            contextTui(statusCalls, workingCalls),
        ),
    ).rejects.toBeDefined();
    // finally still ran despite the rejection
    expect(statusCalls.at(-1)).toBe('sdd-prepare=<cleared>');
    expect(workingCalls.at(-1)).toBe('<default>');
});

test('untargeted sdd_status themes approved runs and keeps legacy entries plain', async () => {
    const store = new SddStore(agentDir);
    seedRun(store, 'app-1', 'running');
    seedRun(store, 'app-2', 'completed');
    const pi = fakePi();
    registerSddExtension(pi.api as never, runtime(store));
    const tuiTheme = { fg: (c: string, t: string) => `[${c}|${t}]` } as never;
    const ctx = { ...context('tui'), ui: { ...((context('tui') as any).ui), theme: tuiTheme } };
    const result = await execute(pi.tools.get('sdd_status'), {}, ctx);
    const text = result.content[0].text;
    expect(text).toContain('app-1: running');
    expect(text).toContain('app-2: completed');
});

test('non-TUI prepare output is a compact summary, not raw JSON', async () => {
    writeFileSync(join(cwd, 'plan.md'), planContent);
    const store = new SddStore(agentDir);
    const pi = fakePi();
    const rt = runtimeWithProgress(store, {
        version: 1,
        requestId: 'ignored',
        status: 'completed',
        output: assessment,
    });
    registerSddExtension(pi.api as never, rt);
    const result = await execute(pi.tools.get('sdd_prepare'), {
        planPath: 'plan.md',
        globalProfile: 'standard',
    });
    const text = result.content[0].text;
    expect(text).not.toStartWith('{');
    expect(text).toContain('SDD manifest prepared:');
    expect(text).toContain('task-1');
    expect(text).toContain('Approve with sdd_approve');
    // Full draft still present in details.
    expect(result.details.manifest.manifestId).toBeDefined();
});

test('package metadata describes the deterministic public-delegation extension', () => {
    const metadata = JSON.parse(
        readFileSync(join(import.meta.dir, 'package.json'), 'utf8'),
    );
    expect(metadata.version).toBe('2.0.0');
    expect(metadata.description.toLowerCase()).toContain('deterministic');
    expect(metadata.description.toLowerCase()).toContain('public delegation');
    expect(metadata.pi.extensions).toEqual(['./index.ts']);
    expect(metadata.dependencies).toBeUndefined();
});
