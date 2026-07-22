import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
    SUBAGENT_DELEGATION_CANCEL_EVENT,
    SUBAGENT_DELEGATION_REQUEST_EVENT,
    SUBAGENT_DELEGATION_RESPONSE_EVENT,
    SUBAGENT_DELEGATION_STARTED_EVENT,
    SUBAGENT_DELEGATION_UPDATE_EVENT,
    type SubagentDelegationRequest,
    type SubagentDelegationResponse,
} from 'pi-subagents/delegation';
import type { SddConfig } from './config.ts';
import { DelegationClient, type EventBus } from './delegation-client.ts';
import type { ApprovedManifest, DraftManifest } from './manifest.ts';
import { registerSddExtension } from './index.ts';
import type { RunSnapshot } from './state-machine.ts';
import { SddStore } from './store.ts';
import { SddWorkflow } from './workflow.ts';

const config: SddConfig = {
    agents: {
        assessor: 'orchestration-assessor',
        worker: 'worker',
        combinedReviewer: 'sdd-combined-reviewer',
        specReviewer: 'sdd-spec-reviewer',
        qualityReviewer: 'sdd-quality-reviewer',
    },
    models: {},
    timeoutsMs: { assessor: 1_000, worker: 1_000, reviewer: 1_000 },
    maxConcurrentWriters: 2,
    structuredOutputRetries: 1,
};

type ResponseFactory = (
    request: SubagentDelegationRequest,
) => SubagentDelegationResponse;

class ScriptedEventBus implements EventBus {
    readonly requests: SubagentDelegationRequest[] = [];
    readonly cancellations: string[] = [];
    readonly heldRequests: SubagentDelegationRequest[] = [];
    private readonly handlers = new Map<
        string,
        Set<(data: unknown) => void>
    >();
    private readonly responses: Array<ResponseFactory | null> = [];

    enqueue(...responses: ResponseFactory[]): void {
        this.responses.push(...responses);
    }

    enqueueHeld(count: number): void {
        this.responses.push(...Array.from({ length: count }, () => null));
    }

    respondHeld(requestId: string, response: ResponseFactory): void {
        const index = this.heldRequests.findIndex(
            (request) => request.requestId === requestId,
        );
        if (index < 0) throw new Error(`Request is not held: ${requestId}.`);
        const [request] = this.heldRequests.splice(index, 1);
        this.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, response(request!));
    }

    on(channel: string, handler: (data: unknown) => void): () => void {
        const registered = this.handlers.get(channel) ?? new Set();
        registered.add(handler);
        this.handlers.set(channel, registered);
        return () => registered.delete(handler);
    }

    emit(channel: string, data: unknown): void {
        for (const handler of this.handlers.get(channel) ?? []) handler(data);
        if (channel === SUBAGENT_DELEGATION_CANCEL_EVENT) {
            this.cancellations.push((data as { requestId: string }).requestId);
            return;
        }
        if (channel !== SUBAGENT_DELEGATION_REQUEST_EVENT) return;

        const request = data as SubagentDelegationRequest;
        this.requests.push(request);
        const response = this.responses.shift();
        if (response === undefined) {
            throw new Error(`No response scripted for ${request.agent}.`);
        }
        this.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
            version: 1,
            requestId: request.requestId,
        });
        this.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
            version: 1,
            requestId: request.requestId,
            currentTool: 'read',
        });
        if (response === null) {
            this.heldRequests.push(request);
            return;
        }
        this.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, response(request));
    }
}

function completed(output: string): ResponseFactory {
    return (request) => ({
        version: 1,
        requestId: request.requestId,
        status: 'completed',
        output,
    });
}

function assessment(
    taskId: string,
    signals: string[] = [],
    advisoryMinimum = 'direct',
): string {
    return JSON.stringify({
        version: 1,
        assessorModel: 'fake-assessor',
        tasks: [
            {
                taskId,
                signals,
                evidence: signals.map((signal) => ({
                    signal,
                    source: `Verified ${signal} in the integration fixture.`,
                })),
                confidence: 'medium',
                uncertainties: [],
                advisoryMinimum,
            },
        ],
    });
}

function acceptedWorker(output: string): ResponseFactory {
    return (request) => ({
        version: 1,
        requestId: request.requestId,
        status: 'completed',
        output,
        acceptance: { status: 'verified', explicit: true },
    });
}

function terminal(
    status: 'unavailable_context' | 'timed_out' | 'acceptance_failed',
): ResponseFactory {
    return (request) => ({
        version: 1,
        requestId: request.requestId,
        status,
        error: `fake ${status}`,
    });
}

function cancelled(): ResponseFactory {
    return (request) => ({
        version: 1,
        requestId: request.requestId,
        status: 'cancelled',
        error: 'cancelled by operator',
    });
}

function review(
    taskId: string,
    stage: 'combined' | 'spec' | 'quality' | 'integration',
    verdict: 'pass' | 'changes_required' | 'blocked',
): ResponseFactory {
    return completed(
        JSON.stringify({
            version: 1,
            taskId,
            stage,
            verdict,
            findings:
                verdict === 'changes_required'
                    ? [
                          {
                              id: `${stage}-finding`,
                              severity: 'important',
                              file: `src/${taskId}.ts`,
                              message: `${stage} correction required`,
                          },
                      ]
                    : [],
            evidence: [`${stage} evidence`],
        }),
    );
}

function integrationPass(): ResponseFactory {
    return (request) => {
        const runId = request.requestId.slice(
            0,
            request.requestId.indexOf(':manifest:integration:'),
        );
        return {
            version: 1,
            requestId: request.requestId,
            status: 'completed',
            output: JSON.stringify({
                version: 1,
                taskId: `manifest:${runId}`,
                stage: 'integration',
                verdict: 'pass',
                findings: [],
                evidence: ['integrated'],
            }),
        };
    };
}

function createFakePi() {
    const tools = new Map<
        string,
        {
            execute(
                id: string,
                params: never,
                signal: AbortSignal | undefined,
                onUpdate: undefined,
                ctx: ExtensionContext,
            ): Promise<{ details: unknown }>;
        }
    >();
    const handlers = new Map<
        string,
        Array<(event: never, ctx: never) => void | Promise<void>>
    >();
    return {
        api: {
            registerTool(tool: { name: string }): void {
                tools.set(tool.name, tool as never);
            },
            registerCommand(): void {},
            appendEntry(): void {},
            on(
                event: string,
                handler: (event: never, ctx: never) => void | Promise<void>,
            ): void {
                const registered = handlers.get(event) ?? [];
                registered.push(handler);
                handlers.set(event, registered);
            },
        },
        tools,
        handlers,
    };
}

function plan(taskId: string): string {
    return `# Direct integration plan

### Task 1: Direct task

~~~sdd-task
{"id":"${taskId}","dependsOn":[],"files":["src/${taskId}.ts"],"verify":[{"id":"test","command":"bun test ${taskId}"}]}
~~~

Implement the direct task.
`;
}

function approvedStandardManifest(
    runId: string,
    planPath: string,
    planContent: string,
): ApprovedManifest {
    return {
        manifestId: runId,
        manifestVersion: 1,
        ruleSetVersion: 1,
        state: 'approved',
        planTitle: 'Persisted terminal plan',
        planPath,
        sourceDigest: createHash('sha256').update(planContent).digest('hex'),
        assessmentDigest: 'assessment',
        assessorModel: 'fake-assessor',
        globalProfile: 'standard',
        parallelismEnabled: false,
        maxConcurrentWriters: 2,
        finalIntegrationReview: false,
        maximumLaunches: 4,
        tasks: [
            {
                id: 'task-1',
                title: 'Task one',
                description: 'Implement task one.',
                recommendedProfile: 'standard',
                effectiveProfile: 'standard',
                classificationRules: ['standard-boundary'],
                signals: ['public_contract'],
                dependencies: [],
                files: ['src/task-1.ts'],
                verify: [{ id: 'test', command: 'bun test task-1' }],
                budgets: {
                    initialWorkers: 1,
                    correctionWorkers: 1,
                    reviewerAttempts: 2,
                    maxLaunches: 4,
                },
                parallelEligible: false,
            },
        ],
        decision: {
            globalProfile: 'standard',
            taskOverrides: {},
            parallelismEnabled: false,
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
    approved: ApprovedManifest,
    snapshot: RunSnapshot,
): void {
    const {
        decision: _decision,
        approvalDigest: _approvalDigest,
        ...draftFields
    } = approved;
    const draft: DraftManifest = {
        ...draftFields,
        state: 'awaiting_approval',
    };
    store.createManifest(draft);
    store.approveManifest(draft, approved, snapshot);
}

function dependencyPlan(): string {
    return `# Dependency integration plan

### Task 1: Root one

~~~sdd-task
{"id":"task-1","dependsOn":[],"files":["src/root-1.ts"],"verify":[{"id":"test-1","command":"bun test root-1"}]}
~~~

Implement root one.

### Task 2: Root two

~~~sdd-task
{"id":"task-2","dependsOn":[],"files":["src/root-2.ts"],"verify":[{"id":"test-2","command":"bun test root-2"}]}
~~~

Implement root two.

### Task 3: Dependent

~~~sdd-task
{"id":"task-3","dependsOn":["task-1","task-2"],"files":["src/dependent.ts"],"verify":[{"id":"test-3","command":"bun test dependent"}]}
~~~

Implement the dependent task.
`;
}

function lowRiskAssessment(taskIds: string[]): string {
    return JSON.stringify({
        version: 1,
        assessorModel: 'fake-assessor',
        tasks: taskIds.map((taskId) => ({
            taskId,
            signals: [
                'isolated_scope',
                'clear_requirements',
                'existing_test_pattern',
            ],
            evidence: [
                {
                    signal: 'isolated_scope',
                    source: `${taskId} owns a disjoint file.`,
                },
                {
                    signal: 'clear_requirements',
                    source: `${taskId} has an explicit body.`,
                },
                {
                    signal: 'existing_test_pattern',
                    source: `${taskId} has a verification command.`,
                },
            ],
            confidence: 'high',
            uncertainties: [],
            advisoryMinimum: 'light',
        })),
    });
}

function legacyShapePlan(): string {
    const dependencies = [
        [],
        ['task-1'],
        ['task-2'],
        ['task-3'],
        ['task-2'],
        ['task-2'],
        [],
        [
            'task-1',
            'task-2',
            'task-3',
            'task-4',
            'task-5',
            'task-6',
            'task-7',
        ],
    ];
    return [
        '# Eight-task legacy-shape plan',
        ...dependencies.flatMap((dependsOn, index) => {
            const ordinal = index + 1;
            return [
                '',
                `### Task ${ordinal}: Legacy-shape task ${ordinal}`,
                '',
                '~~~sdd-task',
                JSON.stringify({
                    id: `task-${ordinal}`,
                    dependsOn,
                    files: [`src/task-${ordinal}.ts`],
                    verify: [
                        {
                            id: `test-${ordinal}`,
                            command: `bun test task-${ordinal}`,
                        },
                    ],
                }),
                '~~~',
                '',
                `Implement legacy-shape task ${ordinal}.`,
            ];
        }),
        '',
    ].join('\n');
}

function legacyShapeAssessment(): string {
    return JSON.stringify({
        version: 1,
        assessorModel: 'fake-assessor',
        tasks: Array.from({ length: 8 }, (_, index) => {
            const ordinal = index + 1;
            const profile = ordinal <= 2 ? 'critical' : ordinal <= 7 ? 'standard' : 'light';
            const signals =
                profile === 'critical'
                    ? ['pi_core_behavior']
                    : profile === 'standard'
                      ? ['public_contract']
                      : [
                            'isolated_scope',
                            'clear_requirements',
                            'existing_test_pattern',
                        ];
            return {
                taskId: `task-${ordinal}`,
                signals,
                evidence: signals.map((signal) => ({
                    signal,
                    source: `Verified ${signal} for task-${ordinal}.`,
                })),
                confidence: 'high',
                uncertainties: [],
                advisoryMinimum: profile,
            };
        }),
    });
}

async function execute(
    tools: ReturnType<typeof createFakePi>['tools'],
    name: string,
    params: Record<string, unknown>,
    ctx: ExtensionContext,
): Promise<{ details: unknown }> {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Tool not registered: ${name}.`);
    return tool.execute('integration-call', params as never, undefined, undefined, ctx);
}

async function waitForRequestCount(
    events: ScriptedEventBus,
    count: number,
): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
        if (events.requests.length >= count) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(
        `Expected ${count} delegation requests, received ${events.requests.length}.`,
    );
}

async function runProfile(
    profile: 'light' | 'standard' | 'critical',
    signals: string[],
    scriptedExecution: ResponseFactory[],
): Promise<{
    snapshot: RunSnapshot;
    requests: SubagentDelegationRequest[];
}> {
    const agentDir = mkdtempSync(join(tmpdir(), 'sdd-profile-agent-'));
    const cwd = mkdtempSync(join(tmpdir(), 'sdd-profile-cwd-'));
    const events = new ScriptedEventBus();
    const delegation = new DelegationClient(events);
    try {
        writeFileSync(join(cwd, 'plan.md'), plan('task-1'));
        events.enqueue(
            completed(assessment('task-1', signals, profile)),
            ...scriptedExecution,
        );
        const store = new SddStore(agentDir);
        const workflow = new SddWorkflow(store, delegation, (runId) => {
            const manifest = store.loadManifest(runId);
            return manifest?.state === 'approved' ? manifest : null;
        });
        const pi = createFakePi();
        registerSddExtension(pi.api as never, {
            agentDir,
            store,
            delegation,
            workflow,
            config: () => config,
            now: () => '2026-07-21T12:00:00.000Z',
        });
        const ctx = { cwd, mode: 'print' } as ExtensionContext;
        const prepared = await execute(
            pi.tools,
            'sdd_prepare',
            { planPath: 'plan.md', globalProfile: profile },
            ctx,
        );
        const draft = (prepared.details as { manifest: DraftManifest }).manifest;
        const result = await execute(
            pi.tools,
            'sdd_approve',
            {
                manifestId: draft.manifestId,
                globalProfile: profile,
                taskOverrides: {},
                parallelismEnabled: false,
                criticalDowngradeConfirmations: {},
                criticalDowngradeJustifications: {},
                approvedBy: 'operator',
            },
            ctx,
        );
        return {
            snapshot: (result.details as { snapshot: RunSnapshot }).snapshot,
            requests: [...events.requests],
        };
    } finally {
        delegation.dispose();
        rmSync(agentDir, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
    }
}

test('Direct uses no execution child and completes only after exact evidence', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'sdd-integration-agent-'));
    const cwd = mkdtempSync(join(tmpdir(), 'sdd-integration-cwd-'));
    const planPath = join(cwd, 'plan.md');
    const events = new ScriptedEventBus();
    const delegation = new DelegationClient(events);
    try {
        writeFileSync(planPath, plan('task-1'));
        events.enqueue(completed(assessment('task-1')));

        const store = new SddStore(agentDir);
        const workflow = new SddWorkflow(store, delegation, (runId) => {
            const manifest = store.loadManifest(runId);
            return manifest?.state === 'approved' ? manifest : null;
        });
        const pi = createFakePi();
        registerSddExtension(pi.api as never, {
            agentDir,
            store,
            delegation,
            workflow,
            config: () => config,
            now: () => '2026-07-21T12:00:00.000Z',
        });
        const ctx = { cwd, mode: 'print' } as ExtensionContext;

        expect([...pi.tools.keys()]).toEqual([
            'sdd_prepare',
            'sdd_submit',
            'sdd_approve',
            'sdd_status',
            'sdd_result',
            'sdd_cancel',
            'sdd_direct_complete',
        ]);
        const prepared = await execute(
            pi.tools,
            'sdd_prepare',
            { planPath: 'plan.md', globalProfile: 'direct' },
            ctx,
        );
        const draft = (prepared.details as { manifest: DraftManifest }).manifest;
        const approved = await execute(
            pi.tools,
            'sdd_approve',
            {
                manifestId: draft.manifestId,
                globalProfile: 'direct',
                taskOverrides: {},
                parallelismEnabled: false,
                criticalDowngradeConfirmations: {},
                criticalDowngradeJustifications: {},
                approvedBy: 'operator',
            },
            ctx,
        );
        expect((approved.details as { snapshot: RunSnapshot }).snapshot).toMatchObject({
            state: 'running',
            tasks: { 'task-1': { state: 'awaiting_direct_agent', launches: 0 } },
        });
        expect(events.requests.map((request) => request.agent)).toEqual([
            'orchestration-assessor',
        ]);

        const completedRun = await execute(
            pi.tools,
            'sdd_direct_complete',
            {
                runId: draft.manifestId,
                taskId: 'task-1',
                changedFiles: ['src/task-1.ts'],
                tests: ['task-1 test'],
                commands: ['bun test task-1'],
                validationOutput: '1 pass, 0 fail',
                residualRisks: ['none identified'],
            },
            ctx,
        );
        expect((completedRun.details as { snapshot: RunSnapshot }).snapshot).toMatchObject({
            state: 'completed',
            tasks: {
                'task-1': {
                    state: 'verified',
                    launches: 0,
                    directEvidence: {
                        changedFiles: ['src/task-1.ts'],
                        commands: ['bun test task-1'],
                    },
                },
            },
        });
        expect(events.requests).toHaveLength(1);
    } finally {
        delegation.dispose();
        rmSync(agentDir, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
    }
});

test('Light, Standard, and Critical honor their exact correction-path ceilings', async () => {
    const light = await runProfile(
        'light',
        ['isolated_scope', 'clear_requirements', 'existing_test_pattern'],
        [acceptedWorker('light implementation')],
    );
    expect(light.snapshot).toMatchObject({
        state: 'completed',
        tasks: {
            'task-1': { state: 'verified', launches: 1, maxLaunches: 1 },
        },
    });
    expect(light.requests.slice(1).map((request) => request.agent)).toEqual([
        'worker',
    ]);

    const standard = await runProfile(
        'standard',
        ['public_contract'],
        [
            acceptedWorker('initial implementation'),
            review('task-1', 'combined', 'changes_required'),
            acceptedWorker('corrected implementation'),
            review('task-1', 'combined', 'pass'),
        ],
    );
    expect(standard.snapshot).toMatchObject({
        state: 'completed',
        tasks: {
            'task-1': { state: 'verified', launches: 4, maxLaunches: 4 },
        },
    });
    expect(standard.requests.slice(1).map((request) => request.agent)).toEqual([
        'worker',
        'sdd-combined-reviewer',
        'worker',
        'sdd-combined-reviewer',
    ]);

    const critical = await runProfile(
        'critical',
        ['concurrency_or_processes'],
        [
            acceptedWorker('initial implementation'),
            review('task-1', 'spec', 'changes_required'),
            acceptedWorker('spec correction'),
            review('task-1', 'spec', 'pass'),
            review('task-1', 'quality', 'changes_required'),
            acceptedWorker('quality correction'),
            review('task-1', 'quality', 'pass'),
            integrationPass(),
        ],
    );
    expect(critical.snapshot).toMatchObject({
        state: 'completed',
        tasks: {
            'task-1': { state: 'verified', launches: 7, maxLaunches: 7 },
        },
    });
    expect(critical.requests.slice(1).map((request) => request.agent)).toEqual([
        'worker',
        'sdd-spec-reviewer',
        'worker',
        'sdd-spec-reviewer',
        'sdd-quality-reviewer',
        'worker',
        'sdd-quality-reviewer',
        'sdd-combined-reviewer',
    ]);
});

test('worker and reviewer restart boundaries require explicit public-tool attestation', async () => {
    for (const boundary of ['worker', 'reviewer'] as const) {
        const agentDir = mkdtempSync(join(tmpdir(), `sdd-${boundary}-agent-`));
        const cwd = mkdtempSync(join(tmpdir(), `sdd-${boundary}-cwd-`));
        const planPath = join(cwd, 'plan.md');
        const planContent = plan('task-1');
        const runId = `${boundary}-recovery-run`;
        const requestId = `${runId}:task-1:${boundary}:1`;
        const events = new ScriptedEventBus();
        const delegation = new DelegationClient(events);
        try {
            writeFileSync(planPath, planContent);
            const store = new SddStore(agentDir);
            const approved: ApprovedManifest = {
                manifestId: runId,
                manifestVersion: 1,
                ruleSetVersion: 1,
                state: 'approved',
                planTitle: 'Recovery plan',
                planPath,
                sourceDigest: createHash('sha256')
                    .update(planContent)
                    .digest('hex'),
                assessmentDigest: 'assessment',
                assessorModel: 'fake-assessor',
                globalProfile: 'standard',
                parallelismEnabled: false,
                maxConcurrentWriters: 2,
                finalIntegrationReview: false,
                maximumLaunches: 4,
                tasks: [
                    {
                        id: 'task-1',
                        title: 'Task one',
                        description: 'Implement task one.',
                        recommendedProfile: 'standard',
                        effectiveProfile: 'standard',
                        classificationRules: ['standard-boundary'],
                        signals: ['public_contract'],
                        dependencies: [],
                        files: ['src/task-1.ts'],
                        verify: [{ id: 'test', command: 'bun test task-1' }],
                        budgets: {
                            initialWorkers: 1,
                            correctionWorkers: 1,
                            reviewerAttempts: 2,
                            maxLaunches: 4,
                        },
                        parallelEligible: false,
                    },
                ],
                decision: {
                    globalProfile: 'standard',
                    taskOverrides: {},
                    parallelismEnabled: false,
                    criticalDowngradeConfirmations: {},
                    criticalDowngradeJustifications: {},
                    approvedBy: 'operator',
                    approvedAt: '2026-07-21T12:00:00.000Z',
                },
                approvalDigest: 'approval',
            };
            const {
                decision: _decision,
                approvalDigest: _approvalDigest,
                ...draftFields
            } = approved;
            const draft: DraftManifest = {
                ...draftFields,
                state: 'awaiting_approval',
            };
            store.createManifest(draft);
            store.approveManifest(draft, approved, {
                runId,
                revision: 1,
                state: 'running',
                terminalReason: undefined,
                tasks: {
                    'task-1': {
                        id: 'task-1',
                        state:
                            boundary === 'worker' ? 'implementing' : 'reviewing',
                        launches: boundary === 'worker' ? 1 : 2,
                        maxLaunches: 4,
                        activeRequestId: requestId,
                    },
                },
                consumedIdempotencyKeys: [requestId],
                plannedDelegations: {
                    [requestId]: {
                        idempotencyKey: requestId,
                        taskId: 'task-1',
                        requestId,
                        stage: boundary === 'worker' ? 'worker' : 'combined',
                        attempt: 1,
                        plannedAt: '2026-07-21T12:00:00.000Z',
                    },
                },
            });
            const workflow = new SddWorkflow(store, delegation, () => approved);
            const pi = createFakePi();
            registerSddExtension(pi.api as never, {
                agentDir,
                store,
                delegation,
                workflow,
                config: () => config,
            });
            const ctx = { cwd, mode: 'print' } as ExtensionContext;
            const start = pi.handlers.get('session_start')?.[0];
            if (!start) throw new Error('session_start was not registered.');

            await start(
                { type: 'session_start', reason: 'resume' } as never,
                ctx as never,
            );
            expect(events.requests).toHaveLength(0);
            expect(store.load(runId)).toMatchObject({
                state: 'needs_input',
                tasks: {
                    'task-1': {
                        state: 'needs_input',
                        terminalReason: 'uncertain_foreground_delegation',
                    },
                },
            });

            const evidence = {
                runId,
                taskId: 'task-1',
                changedFiles: ['src/task-1.ts'],
                tests: ['task-1 test'],
                commands: ['bun test task-1'],
                validationOutput: '1 pass, 0 fail',
                residualRisks: [`${boundary} response was attested`],
            };
            await expect(
                execute(
                    pi.tools,
                    'sdd_direct_complete',
                    evidence,
                    ctx,
                ),
            ).rejects.toThrow('Recovery attestation is required.');
            expect(store.load(runId)?.state).toBe('needs_input');

            if (boundary === 'worker') {
                events.enqueue(review('task-1', 'combined', 'pass'));
            }
            const result = await execute(
                pi.tools,
                'sdd_direct_complete',
                {
                    ...evidence,
                    recovery: {
                        action: 'attest',
                        confirmation: true,
                        authorizedBy: 'operator',
                        requestId,
                        stage: boundary === 'worker' ? 'worker' : 'combined',
                    },
                },
                ctx,
            );
            expect((result.details as { snapshot: RunSnapshot }).snapshot).toMatchObject({
                state: 'completed',
                tasks: {
                    'task-1': {
                        state: 'verified',
                        recoveryChoice: {
                            action: 'attest',
                            confirmation: true,
                            authorizedBy: 'operator',
                            requestId,
                            stage:
                                boundary === 'worker' ? 'worker' : 'combined',
                            priorReason: 'uncertain_foreground_delegation',
                        },
                    },
                },
            });
            expect(events.requests.map((request) => request.requestId)).toEqual(
                boundary === 'worker'
                    ? [`${runId}:task-1:combined:1`]
                    : [],
            );
        } finally {
            delegation.dispose();
            rmSync(agentDir, { recursive: true, force: true });
            rmSync(cwd, { recursive: true, force: true });
        }
    }
});

test('public recovery retries survive injected crashes after atomic save and continuation', async () => {
    for (const crashPoint of ['after-save', 'after-continuation'] as const) {
        const agentDir = mkdtempSync(
            join(tmpdir(), `sdd-recovery-${crashPoint}-agent-`),
        );
        const cwd = mkdtempSync(
            join(tmpdir(), `sdd-recovery-${crashPoint}-cwd-`),
        );
        const planPath = join(cwd, 'plan.md');
        const planContent = plan('task-1');
        const runId = `recovery-${crashPoint}`;
        const requestId = `${runId}:task-1:worker:1`;
        const events = new ScriptedEventBus();
        const delegation = new DelegationClient(events);
        try {
            writeFileSync(planPath, planContent);
            const store = new SddStore(agentDir);
            const approved = approvedStandardManifest(
                runId,
                planPath,
                planContent,
            );
            seedApproved(store, approved, {
                runId,
                revision: 4,
                state: 'needs_input',
                terminalReason: 'uncertain_foreground_delegation',
                tasks: {
                    'task-1': {
                        id: 'task-1',
                        state: 'needs_input',
                        launches: 1,
                        maxLaunches: 4,
                        activeRequestId: requestId,
                        terminalReason: 'uncertain_foreground_delegation',
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
            events.enqueue(review('task-1', 'combined', 'pass'));
            const workflow = new SddWorkflow(store, delegation, () => approved);
            const crashingPi = createFakePi();
            let injected = false;
            registerSddExtension(crashingPi.api as never, {
                agentDir,
                store,
                delegation,
                workflow: {
                    completeDirect: workflow.completeDirect.bind(workflow),
                    cancel: workflow.cancel.bind(workflow),
                    reconcile: workflow.reconcile.bind(workflow),
                    async run(id, ctx) {
                        if (crashPoint === 'after-save' && !injected) {
                            injected = true;
                            throw new Error('injected crash after atomic save');
                        }
                        const continued = await workflow.run(id, ctx);
                        if (!injected) {
                            injected = true;
                            throw new Error('injected crash after continuation');
                        }
                        return continued;
                    },
                },
                config: () => config,
            });
            const params = {
                runId,
                taskId: 'task-1',
                changedFiles: ['src/task-1.ts'],
                tests: ['task-1 test'],
                commands: ['bun test task-1'],
                validationOutput: '1 pass, 0 fail',
                residualRisks: ['worker response attested'],
                recovery: {
                    action: 'attest',
                    confirmation: true,
                    authorizedBy: 'operator',
                    requestId,
                    stage: 'worker',
                },
            };
            const ctx = { cwd, mode: 'print' } as ExtensionContext;

            await expect(
                execute(
                    crashingPi.tools,
                    'sdd_direct_complete',
                    params,
                    ctx,
                ),
            ).rejects.toThrow(`injected crash ${
                crashPoint === 'after-save'
                    ? 'after atomic save'
                    : 'after continuation'
            }`);

            const retryPi = createFakePi();
            registerSddExtension(retryPi.api as never, {
                agentDir,
                store,
                delegation,
                workflow,
                config: () => config,
            });
            const result = await execute(
                retryPi.tools,
                'sdd_direct_complete',
                params,
                ctx,
            );
            expect((result.details as { snapshot: RunSnapshot }).snapshot.state).toBe(
                'completed',
            );
            expect(events.requests.map((request) => request.requestId)).toEqual([
                `${runId}:task-1:combined:1`,
            ]);
            expect(store.load(runId)?.revision).toBe(
                (result.details as { snapshot: RunSnapshot }).snapshot.revision,
            );
        } finally {
            delegation.dispose();
            rmSync(agentDir, { recursive: true, force: true });
            rmSync(cwd, { recursive: true, force: true });
        }
    }
});

test('persisted terminal restart continues exactly once from the next transition', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'sdd-terminal-agent-'));
    const cwd = mkdtempSync(join(tmpdir(), 'sdd-terminal-cwd-'));
    const planPath = join(cwd, 'plan.md');
    const planContent = plan('task-1');
    const runId = 'persisted-terminal-run';
    const workerId = `${runId}:task-1:worker:1`;
    const events = new ScriptedEventBus();
    const delegation = new DelegationClient(events);
    try {
        writeFileSync(planPath, planContent);
        const store = new SddStore(agentDir);
        const approved = approvedStandardManifest(
            runId,
            planPath,
            planContent,
        );
        seedApproved(store, approved, {
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
                        [workerId]: acceptedWorker('persisted implementation')({
                            version: 1,
                            requestId: workerId,
                            agent: 'worker',
                            task: 'persisted',
                            context: 'fresh',
                            cwd,
                        }),
                    },
                },
            },
            consumedIdempotencyKeys: [workerId],
            plannedDelegations: {
                [workerId]: {
                    idempotencyKey: workerId,
                    taskId: 'task-1',
                    requestId: workerId,
                    stage: 'worker',
                    attempt: 1,
                    plannedAt: '2026-07-21T12:00:00.000Z',
                },
            },
        });
        events.enqueue(review('task-1', 'combined', 'pass'));
        const workflow = new SddWorkflow(store, delegation, () => approved);
        const pi = createFakePi();
        registerSddExtension(pi.api as never, {
            agentDir,
            store,
            delegation,
            workflow,
            config: () => config,
        });
        const start = pi.handlers.get('session_start')?.[0];
        if (!start) throw new Error('session_start was not registered.');
        const ctx = { cwd, mode: 'print' } as ExtensionContext;

        await start(
            { type: 'session_start', reason: 'resume' } as never,
            ctx as never,
        );
        expect(events.requests.map((request) => request.requestId)).toEqual([
            `${runId}:task-1:combined:1`,
        ]);
        expect(store.load(runId)).toMatchObject({
            state: 'completed',
            tasks: {
                'task-1': {
                    state: 'verified',
                    launches: 2,
                },
            },
        });
        expect(
            store.load(runId)?.tasks['task-1']?.appliedResponseRequestIds,
        ).toContain(workerId);
        expect(
            store.load(runId)?.tasks['task-1']?.appliedReviewRequestIds,
        ).toEqual([`${runId}:task-1:combined:1`]);

        await start(
            { type: 'session_start', reason: 'resume' } as never,
            ctx as never,
        );
        expect(events.requests).toHaveLength(1);
    } finally {
        delegation.dispose();
        rmSync(agentDir, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
    }
});

test('post-apply pre-run restart continues from the durable reconciled snapshot', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'sdd-post-apply-agent-'));
    const cwd = mkdtempSync(join(tmpdir(), 'sdd-post-apply-cwd-'));
    const planPath = join(cwd, 'plan.md');
    const planContent = plan('task-1');
    const runId = 'post-apply-pre-run-integration';
    const workerId = `${runId}:task-1:worker:1`;
    const events = new ScriptedEventBus();
    const delegation = new DelegationClient(events);
    try {
        writeFileSync(planPath, planContent);
        const store = new SddStore(agentDir);
        const approved = approvedStandardManifest(
            runId,
            planPath,
            planContent,
        );
        seedApproved(store, approved, {
            runId,
            revision: 5,
            state: 'running',
            tasks: {
                'task-1': {
                    id: 'task-1',
                    state: 'reviewing',
                    launches: 1,
                    maxLaunches: 4,
                    terminalResponses: {
                        [workerId]: acceptedWorker('persisted implementation')({
                            version: 1,
                            requestId: workerId,
                            agent: 'worker',
                            task: 'persisted',
                            context: 'fresh',
                            cwd,
                        }),
                    },
                    appliedResponseRequestIds: [workerId],
                },
            },
            consumedIdempotencyKeys: [workerId],
            plannedDelegations: {
                [workerId]: {
                    idempotencyKey: workerId,
                    taskId: 'task-1',
                    requestId: workerId,
                    stage: 'worker',
                    attempt: 1,
                    plannedAt: '2026-07-21T12:00:00.000Z',
                },
            },
        });
        events.enqueue(review('task-1', 'combined', 'pass'));
        const workflow = new SddWorkflow(store, delegation, () => approved);
        const pi = createFakePi();
        registerSddExtension(pi.api as never, {
            agentDir,
            store,
            delegation,
            workflow,
            config: () => config,
        });
        const start = pi.handlers.get('session_start')?.[0];
        if (!start) throw new Error('session_start was not registered.');

        await start(
            { type: 'session_start', reason: 'resume' } as never,
            { cwd, mode: 'print' } as never,
        );

        expect(events.requests.map((request) => request.requestId)).toEqual([
            `${runId}:task-1:combined:1`,
        ]);
        expect(store.load(runId)?.state).toBe('completed');
    } finally {
        delegation.dispose();
        rmSync(agentDir, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
    }
});

test('review JSON repair stays inside Standard ceiling and terminal statuses fail closed', async () => {
    const repaired = await runProfile(
        'standard',
        ['public_contract'],
        [
            acceptedWorker('implementation'),
            completed('not-json'),
            review('task-1', 'combined', 'pass'),
        ],
    );
    expect(repaired.snapshot).toMatchObject({
        state: 'completed',
        tasks: {
            'task-1': { state: 'verified', launches: 3, maxLaunches: 4 },
        },
    });
    expect(repaired.requests.slice(1).map((request) => request.agent)).toEqual([
        'worker',
        'sdd-combined-reviewer',
        'sdd-combined-reviewer',
    ]);
    expect(repaired.requests.at(-1)?.task).toContain(
        'Return only corrected JSON',
    );

    for (const status of [
        'unavailable_context',
        'timed_out',
        'acceptance_failed',
    ] as const) {
        const result = await runProfile(
            'light',
            ['isolated_scope', 'clear_requirements', 'existing_test_pattern'],
            [terminal(status)],
        );
        expect(result.snapshot).toMatchObject({
            state: status === 'unavailable_context' ? 'needs_input' : 'failed',
            tasks: {
                'task-1': {
                    state:
                        status === 'unavailable_context'
                            ? 'needs_input'
                            : 'failed',
                    terminalReason: status,
                    launches: 1,
                },
            },
        });
    }
});

test('assessor gets one repair and plan drift blocks public approval', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'sdd-stale-agent-'));
    const cwd = mkdtempSync(join(tmpdir(), 'sdd-stale-cwd-'));
    const planPath = join(cwd, 'plan.md');
    const events = new ScriptedEventBus();
    const delegation = new DelegationClient(events);
    try {
        writeFileSync(planPath, plan('task-1'));
        events.enqueue(
            completed('invalid assessment'),
            completed(assessment('task-1', ['public_contract'], 'standard')),
        );
        const store = new SddStore(agentDir);
        const workflow = new SddWorkflow(store, delegation, (runId) => {
            const manifest = store.loadManifest(runId);
            return manifest?.state === 'approved' ? manifest : null;
        });
        const pi = createFakePi();
        registerSddExtension(pi.api as never, {
            agentDir,
            store,
            delegation,
            workflow,
            config: () => config,
            now: () => '2026-07-21T12:00:00.000Z',
        });
        const ctx = { cwd, mode: 'print' } as ExtensionContext;
        const prepared = await execute(
            pi.tools,
            'sdd_prepare',
            { planPath: 'plan.md', globalProfile: 'standard' },
            ctx,
        );
        const draft = (prepared.details as { manifest: DraftManifest }).manifest;
        expect(events.requests).toHaveLength(2);
        expect(events.requests[1]?.task).toContain('Return only corrected JSON');

        writeFileSync(planPath, `${plan('task-1')}\nDrifted after assessment.\n`);
        await expect(
            execute(
                pi.tools,
                'sdd_approve',
                {
                    manifestId: draft.manifestId,
                    globalProfile: 'standard',
                    taskOverrides: {},
                    parallelismEnabled: false,
                    criticalDowngradeConfirmations: {},
                    criticalDowngradeJustifications: {},
                    approvedBy: 'operator',
                },
                ctx,
            ),
        ).rejects.toThrow('Source plan changed');
        expect(events.requests).toHaveLength(2);
        expect(store.loadManifest(draft.manifestId)?.state).toBe(
            'awaiting_approval',
        );
    } finally {
        delegation.dispose();
        rmSync(agentDir, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
    }
});

test('Critical downgrade gates only Light and Direct and persists the decision', async () => {
    for (const target of ['standard', 'light', 'direct'] as const) {
        const agentDir = mkdtempSync(join(tmpdir(), `sdd-${target}-agent-`));
        const cwd = mkdtempSync(join(tmpdir(), `sdd-${target}-cwd-`));
        const events = new ScriptedEventBus();
        const delegation = new DelegationClient(events);
        try {
            writeFileSync(join(cwd, 'plan.md'), plan('task-1'));
            events.enqueue(
                completed(
                    assessment(
                        'task-1',
                        ['concurrency_or_processes'],
                        'critical',
                    ),
                ),
            );
            const store = new SddStore(agentDir);
            const workflow = new SddWorkflow(store, delegation, (runId) => {
                const manifest = store.loadManifest(runId);
                return manifest?.state === 'approved' ? manifest : null;
            });
            const pi = createFakePi();
            registerSddExtension(pi.api as never, {
                agentDir,
                store,
                delegation,
                workflow,
                config: () => config,
                now: () => '2026-07-21T12:00:00.000Z',
            });
            const ctx = { cwd, mode: 'print' } as ExtensionContext;
            const prepared = await execute(
                pi.tools,
                'sdd_prepare',
                { planPath: 'plan.md', globalProfile: 'critical' },
                ctx,
            );
            const draft = (prepared.details as { manifest: DraftManifest })
                .manifest;
            const approval = {
                manifestId: draft.manifestId,
                globalProfile: 'critical',
                taskOverrides: { 'task-1': target },
                parallelismEnabled: false,
                criticalDowngradeConfirmations: {},
                criticalDowngradeJustifications: {},
                approvedBy: 'operator',
            };
            if (target !== 'standard') {
                await expect(
                    execute(pi.tools, 'sdd_approve', approval, ctx),
                ).rejects.toThrow('requires confirmation');
                Object.assign(approval, {
                    criticalDowngradeConfirmations: { 'task-1': true },
                    criticalDowngradeJustifications: {
                        'task-1': 'Operator accepts the reduced automation.',
                    },
                });
                if (target === 'light') {
                    events.enqueue(acceptedWorker('light implementation'));
                }
            } else {
                events.enqueue(
                    acceptedWorker('standard implementation'),
                    review('task-1', 'combined', 'pass'),
                );
            }

            const result = await execute(
                pi.tools,
                'sdd_approve',
                approval,
                ctx,
            );
            const persisted = store.loadManifest(draft.manifestId);
            expect(persisted).toMatchObject({
                state: 'approved',
                tasks: [{ effectiveProfile: target }],
                decision: {
                    taskOverrides: { 'task-1': target },
                    criticalDowngradeConfirmations:
                        target !== 'standard' ? { 'task-1': true } : {},
                    criticalDowngradeJustifications:
                        target !== 'standard'
                            ? {
                                  'task-1':
                                      'Operator accepts the reduced automation.',
                              }
                            : {},
                },
            });
            expect((result.details as { snapshot: RunSnapshot }).snapshot).toMatchObject(
                target === 'direct'
                    ? {
                          state: 'running',
                          tasks: {
                              'task-1': {
                                  state: 'awaiting_direct_agent',
                                  maxLaunches: 0,
                              },
                          },
                      }
                    : target === 'light'
                      ? {
                            state: 'completed',
                            tasks: {
                                'task-1': {
                                    state: 'verified',
                                    maxLaunches: 1,
                                    launches: 1,
                                },
                            },
                        }
                      : {
                          state: 'completed',
                          tasks: {
                              'task-1': {
                                  state: 'verified',
                                  maxLaunches: 4,
                                  launches: 2,
                              },
                          },
                      },
            );
        } finally {
            delegation.dispose();
            rmSync(agentDir, { recursive: true, force: true });
            rmSync(cwd, { recursive: true, force: true });
        }
    }
});

test('two disjoint roots overlap only with approval and gate their dependent task', async () => {
    for (const parallelismEnabled of [true, false]) {
        const agentDir = mkdtempSync(join(tmpdir(), 'sdd-parallel-agent-'));
        const cwd = mkdtempSync(join(tmpdir(), 'sdd-parallel-cwd-'));
        const events = new ScriptedEventBus();
        const delegation = new DelegationClient(events);
        try {
            writeFileSync(join(cwd, 'plan.md'), dependencyPlan());
            events.enqueue(
                completed(
                    lowRiskAssessment(['task-1', 'task-2', 'task-3']),
                ),
            );
            const store = new SddStore(agentDir);
            const workflow = new SddWorkflow(store, delegation, (runId) => {
                const manifest = store.loadManifest(runId);
                return manifest?.state === 'approved' ? manifest : null;
            });
            const pi = createFakePi();
            registerSddExtension(pi.api as never, {
                agentDir,
                store,
                delegation,
                workflow,
                config: () => config,
                now: () => '2026-07-21T12:00:00.000Z',
            });
            const ctx = { cwd, mode: 'print' } as ExtensionContext;
            const prepared = await execute(
                pi.tools,
                'sdd_prepare',
                { planPath: 'plan.md', globalProfile: 'light' },
                ctx,
            );
            const draft = (prepared.details as { manifest: DraftManifest })
                .manifest;
            events.enqueueHeld(2);
            events.enqueue(acceptedWorker('dependent implementation'));
            const approval = execute(
                pi.tools,
                'sdd_approve',
                {
                    manifestId: draft.manifestId,
                    globalProfile: 'light',
                    taskOverrides: {},
                    parallelismEnabled,
                    criticalDowngradeConfirmations: {},
                    criticalDowngradeJustifications: {},
                    approvedBy: 'operator',
                },
                ctx,
            );
            await waitForRequestCount(
                events,
                parallelismEnabled ? 3 : 2,
            );
            const executionRequests = () => events.requests.slice(1);
            expect(executionRequests().map((request) => request.requestId)).toEqual(
                parallelismEnabled
                    ? [
                          `${draft.manifestId}:task-1:worker:1`,
                          `${draft.manifestId}:task-2:worker:1`,
                      ]
                    : [`${draft.manifestId}:task-1:worker:1`],
            );
            events.respondHeld(
                `${draft.manifestId}:task-1:worker:1`,
                acceptedWorker('root one implementation'),
            );
            await waitForRequestCount(events, 3);
            if (!parallelismEnabled) {
                expect(executionRequests().map((request) => request.requestId)).toEqual([
                    `${draft.manifestId}:task-1:worker:1`,
                    `${draft.manifestId}:task-2:worker:1`,
                ]);
            }
            events.respondHeld(
                `${draft.manifestId}:task-2:worker:1`,
                acceptedWorker('root two implementation'),
            );
            const result = await approval;
            expect(executionRequests().map((request) => request.requestId)).toEqual([
                `${draft.manifestId}:task-1:worker:1`,
                `${draft.manifestId}:task-2:worker:1`,
                `${draft.manifestId}:task-3:worker:1`,
            ]);
            expect((result.details as { snapshot: RunSnapshot }).snapshot).toMatchObject({
                state: 'completed',
                tasks: {
                    'task-1': { state: 'verified' },
                    'task-2': { state: 'verified' },
                    'task-3': { state: 'verified' },
                },
            });
        } finally {
            delegation.dispose();
            rmSync(agentDir, { recursive: true, force: true });
            rmSync(cwd, { recursive: true, force: true });
        }
    }
});

test('duplicate and late terminal responses cannot change a cancelled public run', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'sdd-cancel-agent-'));
    const cwd = mkdtempSync(join(tmpdir(), 'sdd-cancel-cwd-'));
    const events = new ScriptedEventBus();
    const delegation = new DelegationClient(events);
    try {
        writeFileSync(join(cwd, 'plan.md'), plan('task-1'));
        events.enqueue(
            completed(
                assessment(
                    'task-1',
                    [
                        'isolated_scope',
                        'clear_requirements',
                        'existing_test_pattern',
                    ],
                    'light',
                ),
            ),
        );
        const store = new SddStore(agentDir);
        const workflow = new SddWorkflow(store, delegation, (runId) => {
            const manifest = store.loadManifest(runId);
            return manifest?.state === 'approved' ? manifest : null;
        });
        const pi = createFakePi();
        registerSddExtension(pi.api as never, {
            agentDir,
            store,
            delegation,
            workflow,
            config: () => config,
            now: () => '2026-07-21T12:00:00.000Z',
        });
        const ctx = { cwd, mode: 'print' } as ExtensionContext;
        const prepared = await execute(
            pi.tools,
            'sdd_prepare',
            { planPath: 'plan.md', globalProfile: 'light' },
            ctx,
        );
        const draft = (prepared.details as { manifest: DraftManifest }).manifest;
        events.enqueueHeld(1);
        const approval = execute(
            pi.tools,
            'sdd_approve',
            {
                manifestId: draft.manifestId,
                globalProfile: 'light',
                taskOverrides: {},
                parallelismEnabled: false,
                criticalDowngradeConfirmations: {},
                criticalDowngradeJustifications: {},
                approvedBy: 'operator',
            },
            ctx,
        );
        await waitForRequestCount(events, 2);
        const request = events.requests[1]!;
        await execute(
            pi.tools,
            'sdd_cancel',
            { runId: draft.manifestId },
            ctx,
        );
        expect(events.cancellations).toEqual([request.requestId]);

        events.respondHeld(request.requestId, cancelled());
        const result = await approval;
        expect((result.details as { snapshot: RunSnapshot }).snapshot).toMatchObject({
            state: 'cancelled',
            tasks: { 'task-1': { state: 'cancelled', launches: 1 } },
        });
        const settled = store.load(draft.manifestId);
        events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, cancelled()(request));
        events.emit(
            SUBAGENT_DELEGATION_RESPONSE_EVENT,
            acceptedWorker('late implementation')(request),
        );
        expect(store.load(draft.manifestId)).toEqual(settled);
        expect(events.requests).toHaveLength(2);
    } finally {
        delegation.dispose();
        rmSync(agentDir, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
    }
});

test('eight-task legacy shape previews exactly 36 launches without a polling agent', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'sdd-legacy-shape-agent-'));
    const cwd = mkdtempSync(join(tmpdir(), 'sdd-legacy-shape-cwd-'));
    const events = new ScriptedEventBus();
    const delegation = new DelegationClient(events);
    try {
        writeFileSync(join(cwd, 'plan.md'), legacyShapePlan());
        events.enqueue(completed(legacyShapeAssessment()));
        const store = new SddStore(agentDir);
        const workflow = new SddWorkflow(store, delegation, (runId) => {
            const manifest = store.loadManifest(runId);
            return manifest?.state === 'approved' ? manifest : null;
        });
        const pi = createFakePi();
        registerSddExtension(pi.api as never, {
            agentDir,
            store,
            delegation,
            workflow,
            config: () => config,
        });
        const prepared = await execute(
            pi.tools,
            'sdd_prepare',
            { planPath: 'plan.md', globalProfile: 'standard' },
            { cwd, mode: 'print' } as ExtensionContext,
        );
        const draft = (prepared.details as { manifest: DraftManifest }).manifest;

        expect(draft).toMatchObject({
            state: 'awaiting_approval',
            maximumLaunches: 36,
            finalIntegrationReview: true,
        });
        expect(draft.tasks).toHaveLength(8);
        expect(draft.tasks.map((task) => task.budgets.maxLaunches)).toEqual([
            7, 7, 4, 4, 4, 4, 4, 1,
        ]);
        expect(events.requests.map((request) => request.agent)).toEqual([
            'orchestration-assessor',
        ]);
        expect(
            events.requests.some((request) =>
                /poll|orchestrator/i.test(request.agent),
            ),
        ).toBe(false);
    } finally {
        delegation.dispose();
        rmSync(agentDir, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
    }
});
