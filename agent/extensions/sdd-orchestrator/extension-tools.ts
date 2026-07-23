import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { StringEnum } from '@earendil-works/pi-ai';
import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
    resolveRuntimePath,
    toPortableHomePath,
} from '../_shared/home-path.ts';
import { AssessmentCache, assessmentCacheKey } from './assessment-cache.ts';
import { loadSddConfig, type SddConfig } from './config.ts';
import type { DelegationClient } from './delegation-client.ts';
import {
    applyApproval,
    approvalDecisionDigest,
    compileManifest,
    type ApprovedManifest,
    type DraftManifest,
    type ManifestDecision,
} from './manifest.ts';
import { parseSddPlan } from './plan-parser.ts';
import { buildAssessmentRequest, parseAssessmentResponse } from './prompts.ts';
import {
    estimateQualitativeDuration,
    type ManifestReviewOutcome,
    openManifestReview,
} from './review-ui.ts';
import {
    RECOVERY_STAGES,
    type DirectEvidence,
    type RecoveryAttestation,
    type RunSnapshot,
    type TaskSnapshot,
} from './state-machine.ts';
import type { SddStore } from './store.ts';
import { PROFILES, type Profile } from './types.ts';
import type { SddWorkflow } from './workflow.ts';

type ExtensionStore = Pick<
    SddStore,
    | 'create'
    | 'load'
    | 'list'
    | 'loadManifest'
    | 'createManifest'
    | 'approveManifest'
    | 'listManifests'
>;
type ExtensionDelegation = Pick<DelegationClient, 'run' | 'dispose'>;
type ExtensionWorkflow = Pick<
    SddWorkflow,
    'run' | 'cancel' | 'completeDirect' | 'reconcile'
>;

export interface SddRuntime {
    readonly agentDir: string;
    readonly store: ExtensionStore;
    readonly delegation: ExtensionDelegation;
    readonly workflow: ExtensionWorkflow;
    readonly config?: (cwd: string) => SddConfig;
    readonly now?: () => string;
    readonly openReview?: (
        ctx: ExtensionContext,
        draft: DraftManifest,
    ) => Promise<ManifestReviewOutcome>;
}

export interface LegacyQueuedRun {
    readonly runId: string;
    readonly status: 'legacy_queued';
    readonly planPath: string;
    readonly planTitle?: string;
    readonly queuedAt?: string;
}

type ObservableRun = RunSnapshot | LegacyQueuedRun;

const ProfileSchema = StringEnum(PROFILES);
const PrepareSchema = Type.Object(
    {
        planPath: Type.String({ minLength: 1 }),
        globalProfile: ProfileSchema,
    },
    { additionalProperties: false },
);
const SubmitSchema = Type.Object(
    { planPath: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
);
const ApproveSchema = Type.Object(
    {
        manifestId: Type.String({ minLength: 1 }),
        globalProfile: ProfileSchema,
        taskOverrides: Type.Record(Type.String(), ProfileSchema),
        parallelismEnabled: Type.Boolean(),
        finalIntegrationReview: Type.Optional(Type.Boolean()),
        criticalDowngradeConfirmations: Type.Record(
            Type.String(),
            Type.Boolean(),
        ),
        criticalDowngradeJustifications: Type.Record(
            Type.String(),
            Type.String(),
        ),
        approvedBy: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
);
const StatusSchema = Type.Object(
    { runId: Type.Optional(Type.String({ minLength: 1 })) },
    { additionalProperties: false },
);
const RunSchema = Type.Object(
    { runId: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
);
const RecoveryAttestationSchema = Type.Object(
    {
        action: Type.Literal('attest'),
        confirmation: Type.Literal(true),
        authorizedBy: Type.String({ minLength: 1 }),
        requestId: Type.String({ minLength: 1 }),
        stage: StringEnum(RECOVERY_STAGES),
    },
    { additionalProperties: false },
);
const DirectCompleteSchema = Type.Object(
    {
        runId: Type.String({ minLength: 1 }),
        taskId: Type.String({ minLength: 1 }),
        changedFiles: Type.Array(Type.String({ minLength: 1 })),
        tests: Type.Array(Type.String({ minLength: 1 })),
        commands: Type.Array(Type.String({ minLength: 1 })),
        validationOutput: Type.String({ minLength: 1 }),
        residualRisks: Type.Array(Type.String({ minLength: 1 })),
        recovery: Type.Optional(RecoveryAttestationSchema),
    },
    { additionalProperties: false },
);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLegacyRun(path: string): LegacyQueuedRun | null {
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return null;
    }
    if (
        !isRecord(value) ||
        typeof value.runId !== 'string' ||
        !value.runId ||
        typeof value.planPath !== 'string' ||
        !value.planPath ||
        (value.planTitle !== undefined &&
            typeof value.planTitle !== 'string') ||
        (value.queuedAt !== undefined && typeof value.queuedAt !== 'string')
    ) {
        return null;
    }
    return {
        runId: value.runId,
        status: 'legacy_queued',
        planPath: value.planPath,
        ...(value.planTitle === undefined
            ? {}
            : { planTitle: value.planTitle }),
        ...(value.queuedAt === undefined ? {} : { queuedAt: value.queuedAt }),
    };
}

export function collectRunStatuses(
    store: Pick<SddStore, 'list'>,
    agentDir: string,
): ObservableRun[] {
    const snapshots = store.list();
    const known = new Set(snapshots.map((snapshot) => snapshot.runId));
    const queueDir = join(agentDir, '.sdd', 'queue');
    if (!existsSync(queueDir)) return snapshots;
    const legacy: LegacyQueuedRun[] = [];
    for (const name of readdirSync(queueDir)
        .filter((entry) => entry.endsWith('.json'))
        .toSorted()) {
        const entry = readLegacyRun(join(queueDir, name));
        if (!entry || known.has(entry.runId)) continue;
        known.add(entry.runId);
        legacy.push(entry);
    }
    return [...snapshots, ...legacy];
}

function textResult(text: string, details: unknown) {
    return { content: [{ type: 'text' as const, text }], details };
}

function requireDraft(
    store: ExtensionStore,
    manifestId: string,
): DraftManifest {
    const manifest = store.loadManifest(manifestId);
    if (!manifest) throw new Error(`Manifest not found: ${manifestId}.`);
    if (manifest.state !== 'awaiting_approval') {
        throw new Error(`Manifest ${manifestId} is already approved.`);
    }
    return manifest;
}

function requireSnapshot(store: ExtensionStore, runId: string): RunSnapshot {
    const snapshot = store.load(runId);
    if (!snapshot) throw new Error(`Run not found: ${runId}.`);
    return snapshot;
}

function isTerminalSnapshot(snapshot: RunSnapshot): boolean {
    return (
        snapshot.state === 'completed' ||
        snapshot.state === 'failed' ||
        snapshot.state === 'cancelled'
    );
}

function hasActiveDelegation(snapshot: RunSnapshot): boolean {
    return (
        Object.values(snapshot.tasks).some(
            (task) => task.activeRequestId !== undefined,
        ) || snapshot.integrationReview?.activeRequestId !== undefined
    );
}

function isDurablyResumableTask(task: TaskSnapshot): boolean {
    if (task.state === 'pending') return true;
    if (
        task.state !== 'reviewing' &&
        task.state !== 'fixing' &&
        task.state !== 'verified'
    ) {
        return false;
    }
    if (task.state === 'verified' && task.directEvidence) return true;
    return (task.appliedResponseRequestIds?.length ?? 0) > 0;
}

export function shouldContinueAfterReconcile(snapshot: RunSnapshot): boolean {
    return (
        snapshot.state === 'running' &&
        snapshot.cancellation === undefined &&
        !hasActiveDelegation(snapshot) &&
        Object.values(snapshot.tasks).every(isDurablyResumableTask)
    );
}

function hasApprovalEntry(
    ctx: ExtensionContext,
    approvalDigest: string,
): boolean {
    return (
        ctx.sessionManager
            ?.getEntries?.()
            .some(
                (entry) =>
                    entry.type === 'custom' &&
                    entry.customType === 'sdd:manifest-approved' &&
                    isRecord(entry.data) &&
                    entry.data.approvalDigest === approvalDigest,
            ) ?? false
    );
}

function ensureApprovalEntry(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    manifest: ApprovedManifest,
    recordedApprovalEntries: Set<string>,
): void {
    if (
        recordedApprovalEntries.has(manifest.approvalDigest) ||
        hasApprovalEntry(ctx, manifest.approvalDigest)
    ) {
        recordedApprovalEntries.add(manifest.approvalDigest);
        return;
    }
    pi.appendEntry('sdd:manifest-approved', {
        manifestId: manifest.manifestId,
        runId: manifest.manifestId,
        approvalDigest: manifest.approvalDigest,
    });
    recordedApprovalEntries.add(manifest.approvalDigest);
}

function initialSnapshot(
    runId: string,
    manifest: ApprovedManifest,
): RunSnapshot {
    return {
        runId,
        revision: 0,
        state: 'approved',
        tasks: Object.fromEntries(
            manifest.tasks.map((task) => [
                task.id,
                {
                    id: task.id,
                    state: 'pending' as const,
                    launches: 0,
                    maxLaunches: task.budgets.maxLaunches,
                },
            ]),
        ),
        consumedIdempotencyKeys: [],
        plannedDelegations: {},
    };
}

function runtimeConfig(runtime: SddRuntime, cwd: string): SddConfig {
    return runtime.config?.(cwd) ?? loadSddConfig(cwd);
}

const assessmentCaches = new WeakMap<SddRuntime, AssessmentCache>();

function assessmentCache(runtime: SddRuntime): AssessmentCache {
    const existing = assessmentCaches.get(runtime);
    if (existing) return existing;
    const created = new AssessmentCache(runtime.agentDir);
    assessmentCaches.set(runtime, created);
    return created;
}

function assessorContract(
    runtime: SddRuntime,
    cwd: string,
    agent: string,
): string | undefined {
    if (!/^[A-Za-z0-9._-]+$/.test(agent)) return undefined;
    for (const path of [
        join(cwd, '.pi', 'agents', `${agent}.md`),
        join(runtime.agentDir, 'agents', `${agent}.md`),
    ]) {
        if (existsSync(path)) return readFileSync(path, 'utf8');
    }
    return undefined;
}

function now(runtime: SddRuntime): string {
    return runtime.now?.() ?? new Date().toISOString();
}

async function assess(
    runtime: SddRuntime,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    planPath: string,
    planContent: string,
    config: SddConfig,
) {
    const plan = parseSddPlan(planContent);
    const digest = createHash('sha256').update(planContent).digest('hex');
    const logicalJobId = `sdd:${digest}:assessment`;
    const expectedTaskIds = plan.tasks.map((task) => task.id);
    const key = assessmentCacheKey({
        planContent,
        assessorAgent: config.agents.assessor,
        assessorModel: config.models.assessor,
        assessorContract: assessorContract(
            runtime,
            ctx.cwd,
            config.agents.assessor,
        ),
    });
    const assessment = await assessmentCache(runtime).resolve(
        key,
        expectedTaskIds,
        async () => {
            let originalOutput = '';
            let validationError = '';
            for (
                let attempt = 0;
                attempt <= config.structuredOutputRetries;
                attempt++
            ) {
                const request = buildAssessmentRequest({
                    requestId: `${logicalJobId}:${attempt + 1}`,
                    logicalJobId,
                    cwd: ctx.cwd,
                    config,
                    planPath,
                    plan,
                    ...(attempt === 0
                        ? {}
                        : {
                              repair: {
                                  attempt,
                                  validationError,
                                  originalOutput,
                              },
                          }),
                });
                // oxlint-disable-next-line no-await-in-loop -- a repair uses the previous validation failure and must remain sequential.
                const response = await runtime.delegation.run(request, {
                    signal,
                    deadlineMs: config.timeoutsMs.assessor,
                });
                if (
                    response.status !== 'completed' ||
                    response.output === undefined
                ) {
                    throw new Error(
                        `Assessment delegation failed: ${response.status}${response.error ? `: ${response.error}` : ''}.`,
                    );
                }
                try {
                    return parseAssessmentResponse(
                        response.output,
                        expectedTaskIds,
                    );
                } catch (error) {
                    originalOutput = response.output;
                    validationError =
                        error instanceof Error ? error.message : String(error);
                    if (attempt === config.structuredOutputRetries) throw error;
                }
            }
            throw new Error('Assessment retry ceiling exhausted.');
        },
    );
    return { plan, assessment };
}

async function approveDraft(
    pi: ExtensionAPI,
    runtime: SddRuntime,
    ctx: ExtensionContext,
    manifest: DraftManifest | ApprovedManifest,
    decision: ManifestDecision,
    recordedApprovalEntries: Set<string>,
    signal?: AbortSignal,
) {
    let approved: ApprovedManifest;
    let snapshot: RunSnapshot;
    if (manifest.state === 'approved') {
        if (
            approvalDecisionDigest(manifest.decision) !==
            approvalDecisionDigest(decision)
        ) {
            throw new Error(
                `Manifest approval conflict: ${manifest.manifestId}.`,
            );
        }
        approved = manifest;
        snapshot = requireSnapshot(runtime.store, manifest.manifestId);
    } else {
        const currentPlanContent = readFileSync(
            resolveRuntimePath(manifest.planPath, ctx.cwd),
            'utf8',
        );
        const candidate = applyApproval(manifest, decision, currentPlanContent);
        const persisted = runtime.store.approveManifest(
            manifest,
            candidate,
            initialSnapshot(candidate.manifestId, candidate),
        );
        approved = persisted.manifest;
        snapshot = persisted.snapshot;
    }
    const runId = approved.manifestId;
    ensureApprovalEntry(pi, ctx, approved, recordedApprovalEntries);
    if (!isTerminalSnapshot(snapshot)) {
        snapshot = await runtime.workflow.run(runId, ctx, signal);
    }
    const direct = approved.tasks.some(
        (task) => task.effectiveProfile === 'direct',
    );
    return textResult(
        [
            `SDD run ${runId} started.`,
            direct
                ? `Direct tasks require sdd_direct_complete({ runId: "${runId}", ... }).`
                : 'The approved workflow has started.',
        ].join('\n'),
        { snapshot, manifest: approved },
    );
}

async function prepare(
    pi: ExtensionAPI,
    runtime: SddRuntime,
    ctx: ExtensionContext,
    planPathInput: string,
    globalProfile: Profile,
    recordedApprovalEntries: Set<string>,
    signal?: AbortSignal,
) {
    const planPath = resolveRuntimePath(planPathInput, ctx.cwd);
    const planContent = readFileSync(planPath, 'utf8');
    const config = runtimeConfig(runtime, ctx.cwd);
    const { plan, assessment } = await assess(
        runtime,
        ctx,
        signal,
        planPath,
        planContent,
        config,
    );
    const draft = compileManifest({
        planPath: toPortableHomePath(planPath),
        planContent,
        parsedPlan: plan,
        assessment,
        globalProfile,
        parallelismEnabled: true,
        config,
    });
    runtime.store.createManifest(draft);
    if (ctx.mode === 'tui') {
        const outcome = await (runtime.openReview ?? openManifestReview)(
            ctx,
            draft,
        );
        if (outcome.type === 'approve') {
            return approveDraft(
                pi,
                runtime,
                ctx,
                draft,
                outcome.decision,
                recordedApprovalEntries,
                signal,
            );
        }
        return textResult(
            outcome.type === 'return_to_planning'
                ? 'Manifest returned to planning.'
                : 'Manifest review cancelled.',
            { manifest: draft, outcome },
        );
    }
    return textResult(
        [
            JSON.stringify(draft, null, 2),
            '',
            `Approve with sdd_approve({ manifestId: "${draft.manifestId}", ... }).`,
        ].join('\n'),
        { manifest: draft },
    );
}

function renderObservable(entry: ObservableRun): string {
    return 'status' in entry
        ? `${entry.runId}: legacy_queued (${entry.planPath})`
        : `${entry.runId}: ${entry.state}`;
}

function observeRun(
    manifest: ApprovedManifest,
    snapshot: RunSnapshot,
    observedAt: string,
) {
    const effectiveProfiles = Object.fromEntries(
        manifest.tasks.map((task) => [task.id, task.effectiveProfile]),
    );
    const qualitativeEstimate = estimateQualitativeDuration(
        manifest.tasks,
        effectiveProfiles,
        {
            maximumLaunches: manifest.maximumLaunches,
            finalIntegrationReview: manifest.finalIntegrationReview,
            profileLaunches: manifest.profileLaunches ?? manifest.maximumLaunches,
            qaLaunches: manifest.qaLaunches ?? 0,
            browserLaunches: manifest.browserLaunches ?? 0,
            validationLaunches: manifest.validationLaunches ?? 0,
        },
    );
    const approvedAtMs = Date.parse(manifest.decision.approvedAt);
    const observedAtMs = Date.parse(observedAt);
    const elapsedMs =
        Number.isFinite(approvedAtMs) && Number.isFinite(observedAtMs)
            ? Math.max(0, observedAtMs - approvedAtMs)
            : undefined;
    const estimateLimitsMs = {
        'manual-only': 0,
        short: 15 * 60_000,
        moderate: 60 * 60_000,
        extended: 3 * 60 * 60_000,
    } as const;
    const activeRequests = Object.values(snapshot.plannedDelegations)
        .filter(
            (delegation) =>
                snapshot.tasks[delegation.taskId]?.activeRequestId ===
                delegation.requestId,
        )
        .map((delegation) => ({
            taskId: delegation.taskId,
            requestId: delegation.requestId,
            stage: delegation.stage,
            plannedAt: delegation.plannedAt,
        }));
    if (snapshot.integrationReview?.activeRequestId) {
        const planned = snapshot.integrationReview.plannedDelegation;
        activeRequests.push({
            taskId: planned?.taskId ?? `manifest:${manifest.manifestId}`,
            requestId: snapshot.integrationReview.activeRequestId,
            stage: planned?.stage ?? 'integration',
            plannedAt: planned?.plannedAt ?? manifest.decision.approvedAt,
        });
    }
    const blockedOutput = Object.values(snapshot.tasks)
        .filter((task) => task.terminalReason === 'worker_blocked')
        .flatMap((task) => Object.values(task.terminalResponses ?? {}))
        .findLast((response) =>
            /^BLOCKED:\s+\S/.test(response.output?.trimStart() ?? ''),
        )?.output;
    return {
        manifest,
        snapshot,
        observedAt,
        elapsedMs,
        qualitativeEstimate,
        estimateDrift:
            elapsedMs === undefined
                ? 'unknown'
                : elapsedMs > estimateLimitsMs[qualitativeEstimate]
                  ? 'overdue'
                  : 'on_track',
        selectedProfiles: manifest.tasks.map((task) => ({
            taskId: task.id,
            profile: task.effectiveProfile,
            rules: task.classificationRules,
            signals: task.signals,
            parallelEligible: task.parallelEligible,
        })),
        activeRequests,
        budgets: manifest.tasks.map((task) => {
            const taskSnapshot = snapshot.tasks[task.id];
            const correctionsConsumed = Object.values(
                snapshot.plannedDelegations,
            ).filter(
                (delegation) =>
                    delegation.taskId === task.id &&
                    delegation.stage === 'correction',
            ).length;
            return {
                taskId: task.id,
                launchesConsumed: taskSnapshot?.launches ?? 0,
                launchesRemaining: Math.max(
                    0,
                    task.budgets.maxLaunches - (taskSnapshot?.launches ?? 0),
                ),
                correctionsConsumed,
                correctionsRemaining: Math.max(
                    0,
                    task.budgets.correctionWorkers - correctionsConsumed,
                ),
            };
        }),
        reviewerVerdicts: manifest.tasks.flatMap((task) =>
            Object.entries(snapshot.tasks[task.id]?.reviewResults ?? {}).map(
                ([requestId, review]) => ({
                    requestId,
                    version: review.version,
                    taskId: review.taskId,
                    stage: review.stage,
                    verdict: review.verdict,
                    findings: review.findings,
                    evidence: review.evidence,
                }),
            ),
        ),
        acceptanceEvidence: manifest.tasks.flatMap((task) =>
            Object.values(snapshot.tasks[task.id]?.terminalResponses ?? {}).map(
                (response) => ({
                    taskId: task.id,
                    requestId: response.requestId,
                    status: response.status,
                    childRunId: response.runId,
                    acceptance: response.acceptance,
                    outputPath: response.outputPath,
                    sessionFile: response.sessionFile,
                }),
            ),
        ),
        blockedDecision: snapshot.terminalReason,
        ...(blockedOutput ? { blockedOutput } : {}),
        recoveryActions: manifest.tasks.flatMap((task) => {
            const choice = snapshot.tasks[task.id]?.recoveryChoice;
            return choice ? [{ taskId: task.id, choice }] : [];
        }),
    };
}

export function registerSddExtension(
    pi: ExtensionAPI,
    runtime: SddRuntime,
): void {
    const recordedApprovalEntries = new Set<string>();
    pi.registerTool({
        name: 'sdd_prepare',
        label: 'Prepare SDD Manifest',
        description:
            'Compile, assess, store, and review a deterministic SDD manifest.',
        parameters: PrepareSchema,
        execute: async (_id, params, signal, _update, ctx) =>
            prepare(
                pi,
                runtime,
                ctx,
                params.planPath,
                params.globalProfile,
                recordedApprovalEntries,
                signal,
            ),
    });

    pi.registerTool({
        name: 'sdd_submit',
        label: 'Submit SDD Plan (Deprecated)',
        description:
            'Compatibility alias for sdd_prepare with the Standard profile.',
        parameters: SubmitSchema,
        async execute(_id, params, signal, _update, ctx) {
            const result = await prepare(
                pi,
                runtime,
                ctx,
                params.planPath,
                'standard',
                recordedApprovalEntries,
                signal,
            );
            result.content[0].text = `Deprecated: use sdd_prepare.\n${result.content[0].text}`;
            return result;
        },
    });

    pi.registerTool({
        name: 'sdd_approve',
        label: 'Approve SDD Manifest',
        description: 'Apply one typed approval and start the stored manifest.',
        parameters: ApproveSchema,
        execute: async (_id, params, signal, _update, ctx) => {
            const manifest = runtime.store.loadManifest(params.manifestId);
            if (!manifest) {
                throw new Error(`Manifest not found: ${params.manifestId}.`);
            }
            return approveDraft(
                pi,
                runtime,
                ctx,
                manifest,
                {
                    globalProfile: params.globalProfile,
                    taskOverrides: params.taskOverrides,
                    parallelismEnabled: params.parallelismEnabled,
                    ...(params.finalIntegrationReview === undefined
                        ? {}
                        : {
                              finalIntegrationReview:
                                  params.finalIntegrationReview,
                          }),
                    criticalDowngradeConfirmations:
                        params.criticalDowngradeConfirmations,
                    criticalDowngradeJustifications:
                        params.criticalDowngradeJustifications,
                    approvedBy: params.approvedBy,
                    approvedAt: now(runtime),
                },
                recordedApprovalEntries,
                signal,
            );
        },
    });

    pi.registerTool({
        name: 'sdd_status',
        label: 'SDD Status',
        description:
            'Read durable SDD status, including untouched legacy queued runs.',
        parameters: StatusSchema,
        async execute(_id, params) {
            const entries = collectRunStatuses(runtime.store, runtime.agentDir);
            if (params.runId) {
                const entry = entries.find(
                    (candidate) => candidate.runId === params.runId,
                );
                if (!entry) throw new Error(`Run not found: ${params.runId}.`);
                const manifest =
                    'status' in entry
                        ? null
                        : runtime.store.loadManifest(entry.runId);
                const observation =
                    !('status' in entry) && manifest?.state === 'approved'
                        ? observeRun(manifest, entry, now(runtime))
                        : undefined;
                return textResult(renderObservable(entry), {
                    snapshot: entry,
                    observation,
                });
            }
            const runs = entries.flatMap((entry) => {
                if ('status' in entry) return [];
                const manifest = runtime.store.loadManifest(entry.runId);
                return manifest?.state === 'approved'
                    ? [observeRun(manifest, entry, now(runtime))]
                    : [];
            });
            return textResult(
                entries.map(renderObservable).join('\n') || 'No SDD runs.',
                {
                    snapshots: entries,
                    runs,
                },
            );
        },
    });

    pi.registerTool({
        name: 'sdd_result',
        label: 'SDD Result',
        description: 'Return the durable snapshot for an SDD run.',
        parameters: RunSchema,
        async execute(_id, params) {
            const snapshot = requireSnapshot(runtime.store, params.runId);
            const manifest = runtime.store.loadManifest(params.runId);
            if (!manifest || manifest.state !== 'approved') {
                throw new Error(
                    `Approved manifest not found: ${params.runId}.`,
                );
            }
            return textResult(`${snapshot.runId}: ${snapshot.state}`, {
                snapshot,
                observation: observeRun(manifest, snapshot, now(runtime)),
            });
        },
    });

    pi.registerTool({
        name: 'sdd_cancel',
        label: 'Cancel SDD Run',
        description: 'Persist and request cancellation for an SDD run.',
        parameters: RunSchema,
        async execute(_id, params) {
            requireSnapshot(runtime.store, params.runId);
            const snapshot = runtime.workflow.cancel(params.runId);
            return textResult(`Cancellation requested for ${params.runId}.`, {
                snapshot,
            });
        },
    });

    pi.registerTool({
        name: 'sdd_direct_complete',
        label: 'Complete Direct SDD Task',
        description:
            'Record exact Direct-task evidence or explicitly attest uncertain work, then continue the run.',
        parameters: DirectCompleteSchema,
        async execute(_id, params, signal, _onUpdate, ctx) {
            const manifest = runtime.store.loadManifest(params.runId);
            if (!manifest || manifest.state !== 'approved') {
                throw new Error(
                    `Approved manifest not found: ${params.runId}.`,
                );
            }
            const evidence: DirectEvidence = {
                changedFiles: params.changedFiles,
                tests: params.tests,
                commands: params.commands,
                validationOutput: params.validationOutput,
                residualRisks: params.residualRisks,
            };
            runtime.workflow.completeDirect(
                params.runId,
                params.taskId,
                evidence,
                readFileSync(
                    resolveRuntimePath(manifest.planPath, ctx.cwd),
                    'utf8',
                ),
                params.recovery as RecoveryAttestation | undefined,
            );
            const snapshot = await runtime.workflow.run(
                params.runId,
                ctx,
                signal,
            );
            return textResult(
                `Direct evidence recorded for ${params.taskId}.`,
                {
                    snapshot,
                },
            );
        },
    });

    pi.registerCommand('sdd-review', {
        description: 'Review a stored SDD manifest in one native overlay.',
        async handler(args, ctx) {
            const manifestId = args.trim();
            if (!manifestId)
                throw new Error('sdd-review requires a manifest ID.');
            if (ctx.mode !== 'tui') {
                throw new Error('sdd-review requires TUI mode.');
            }
            const draft = requireDraft(runtime.store, manifestId);
            const outcome = await (runtime.openReview ?? openManifestReview)(
                ctx,
                draft,
            );
            if (outcome.type === 'approve') {
                const result = await approveDraft(
                    pi,
                    runtime,
                    ctx,
                    draft,
                    outcome.decision,
                    recordedApprovalEntries,
                );
                ctx.ui.notify(result.content[0].text, 'info');
            } else {
                ctx.ui.notify(
                    outcome.type === 'return_to_planning'
                        ? 'Manifest returned to planning.'
                        : 'Manifest review cancelled.',
                    'info',
                );
            }
        },
    });

    pi.on('session_start', async (event, ctx) => {
        // Delegated Pi children share the controller's agent directory but must
        // not passively reconcile runs that are still owned by that controller.
        if (process.env.PI_SUBAGENT_CHILD === '1') return;
        if (
            event.reason !== 'startup' &&
            event.reason !== 'reload' &&
            event.reason !== 'resume'
        ) {
            return;
        }
        for (const snapshot of runtime.store.list()) {
            if (
                snapshot.state === 'completed' ||
                snapshot.state === 'failed' ||
                snapshot.state === 'cancelled'
            ) {
                continue;
            }
            const reconciled = runtime.workflow.reconcile(snapshot.runId);
            if (shouldContinueAfterReconcile(reconciled)) {
                // oxlint-disable-next-line no-await-in-loop -- persisted runs resume in durable store order and must not overlap writers across manifests.
                await runtime.workflow.run(snapshot.runId, ctx);
            }
        }
    });

    pi.on('session_shutdown', () => {
        runtime.delegation.dispose();
    });
}
