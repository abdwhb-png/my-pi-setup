import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { SubagentDelegationResponse } from 'pi-subagents/delegation';
import { loadSddConfig } from './config.ts';
import type { DelegationClient } from './delegation-client.ts';
import type { ApprovedManifest, ApprovedManifestTask } from './manifest.ts';
import {
    buildCorrectionRequest,
    buildReviewRequest,
    buildWorkerRequest,
    parseReviewResponse,
    type Review,
    type ReviewStage,
} from './prompts.ts';
import {
    recoveryAttestationDigest,
    transition,
    type DirectEvidence,
    type RecoveryAttestation,
    type RecoveryChoice,
    type RunEvent,
    type RunSnapshot,
    type TaskState,
} from './state-machine.ts';
import { snapshotDigest, type SddStore } from './store.ts';

type WorkflowStore = Pick<SddStore, 'load' | 'save' | 'appendTransition'>;
type WorkflowDelegation = Pick<DelegationClient, 'run' | 'cancel'>;
export type ManifestResolver = (
    runId: string,
) => ApprovedManifest | null | undefined;

function accepted(response: SubagentDelegationResponse): boolean {
    return (
        response.status === 'completed' &&
        (response.acceptance?.status === 'verified' ||
            response.acceptance?.status === 'accepted')
    );
}

const SHARED_CONTRACT_SIGNALS = [
    'shared_infrastructure',
    'pi_core_behavior',
    'inter_extension_protocol',
] as const;

function filesOverlap(
    left: ApprovedManifestTask,
    right: ApprovedManifestTask,
): boolean {
    const leftFiles = new Set(left.files);
    return right.files.some((file) => leftFiles.has(file));
}

function mustRunSequentially(task: ApprovedManifestTask): boolean {
    return (
        task.effectiveProfile === 'direct' ||
        !task.parallelEligible ||
        SHARED_CONTRACT_SIGNALS.some((signal) => task.signals.includes(signal))
    );
}

export function selectRunnableBatch(
    manifest: ApprovedManifest,
    snapshot: RunSnapshot,
): ApprovedManifestTask[] {
    const runnable = manifest.tasks.filter(
        (task) =>
            snapshot.tasks[task.id]?.state === 'pending' &&
            task.dependencies.every(
                (dependency) =>
                    snapshot.tasks[dependency]?.state === 'verified',
            ),
    );
    const first = runnable[0];
    if (!first) return [];
    if (!manifest.parallelismEnabled || mustRunSequentially(first)) {
        return [first];
    }
    if (
        runnable.some(
            (candidate) =>
                candidate !== first && filesOverlap(first, candidate),
        )
    ) {
        return [first];
    }

    const batch = [first];
    for (const candidate of runnable.slice(1)) {
        if (batch.length >= manifest.maxConcurrentWriters) break;
        if (
            mustRunSequentially(candidate) ||
            runnable.some(
                (other) =>
                    other !== candidate && filesOverlap(candidate, other),
            )
        ) {
            break;
        }
        if (!batch.some((selected) => filesOverlap(selected, candidate))) {
            batch.push(candidate);
        }
    }
    return batch;
}

export class SddWorkflow {
    private readonly activeRuns = new Map<string, Promise<RunSnapshot>>();

    constructor(
        private readonly store: WorkflowStore,
        private readonly delegation: WorkflowDelegation,
        private readonly loadManifest: ManifestResolver,
    ) {}

    run(
        runId: string,
        ctx: ExtensionContext,
        signal?: AbortSignal,
    ): Promise<RunSnapshot> {
        const active = this.activeRuns.get(runId);
        if (active) return active;

        const onAbort = () => {
            this.cancel(runId);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        const execution = this.runExclusive(runId, ctx);
        this.activeRuns.set(runId, execution);
        const release = () => {
            signal?.removeEventListener('abort', onAbort);
            if (this.activeRuns.get(runId) === execution) {
                this.activeRuns.delete(runId);
            }
        };
        void execution.then(release, release);
        return execution;
    }

    private async runExclusive(
        runId: string,
        ctx: ExtensionContext,
    ): Promise<RunSnapshot> {
        const manifest = this.requireManifest(runId);
        let snapshot = this.requireSnapshot(runId);
        this.validateSnapshot(snapshot, manifest);
        if (snapshot.state === 'approved') {
            snapshot = this.persist(runId, {
                type: 'run-transition',
                expectedRevision: snapshot.revision,
                to: 'running',
            });
        }
        if (snapshot.state !== 'running') return snapshot;

        if (!this.sourceDigestMatches(manifest)) {
            return this.failRun(runId, 'source_digest_changed', 'needs_input');
        }

        if (snapshot.cancellation) {
            return this.hasActiveRequest(snapshot)
                ? snapshot
                : this.finishRun(runId, 'cancelled');
        }

        snapshot = this.reconcile(runId);
        if (snapshot.state !== 'running') return snapshot;

        const config = loadSddConfig(ctx.cwd);
        while (true) {
            snapshot = this.requireSnapshot(runId);
            if (snapshot.state !== 'running') break;
            if (snapshot.cancellation) {
                return this.hasActiveRequest(snapshot)
                    ? snapshot
                    : this.finishRun(runId, 'cancelled');
            }
            const resumable = manifest.tasks.find((task) => {
                const state = snapshot.tasks[task.id]?.state;
                return state === 'reviewing' || state === 'fixing';
            });
            if (resumable) {
                // oxlint-disable-next-line no-await-in-loop -- persisted task boundaries resume in manifest order.
                await this.resumeTask(runId, ctx.cwd, config, resumable);
                continue;
            }
            const batch = selectRunnableBatch(manifest, snapshot);
            if (batch.length === 0) break;
            // oxlint-disable-next-line no-await-in-loop -- dependency batches must finish before the next batch is selected.
            await Promise.all(
                batch.map((task) => this.runTask(runId, ctx.cwd, config, task)),
            );
            if (batch[0]?.effectiveProfile === 'direct') break;
        }

        snapshot = this.requireSnapshot(runId);
        if (
            manifest.tasks.every(
                (task) => snapshot.tasks[task.id]?.state === 'verified',
            )
        ) {
            if (manifest.finalIntegrationReview) {
                return this.runIntegrationReview(runId, ctx.cwd, config);
            }
            return this.finishRun(runId, 'completed');
        }
        return snapshot;
    }

    private async runTask(
        runId: string,
        cwd: string,
        config: ReturnType<typeof loadSddConfig>,
        task: ApprovedManifestTask,
    ): Promise<RunSnapshot> {
        if (task.effectiveProfile === 'direct') {
            return this.taskTransition(runId, task.id, 'awaiting_direct_agent');
        }

        this.taskTransition(runId, task.id, 'implementing');
        let implementationResponse = await this.launch(
            runId,
            task,
            'worker',
            1,
            buildWorkerRequest({
                requestId: `${runId}:${task.id}:worker:1`,
                cwd,
                config,
                task,
            }),
        );
        if (!accepted(implementationResponse)) {
            return this.settleFailedResponse(
                runId,
                task.id,
                implementationResponse,
            );
        }
        this.taskTransition(runId, task.id, 'reviewing');
        if (task.effectiveProfile === 'light') {
            this.taskTransition(runId, task.id, 'verified');
        }
        this.markResponseApplied(
            runId,
            task.id,
            implementationResponse.requestId,
        );
        if (task.effectiveProfile === 'light') {
            return this.requireSnapshot(runId);
        }

        if (task.effectiveProfile === 'critical') {
            let corrections = 0;
            let reviewerAttempts = 0;
            for (const stage of ['spec', 'quality'] as const) {
                let stageAttempt = 0;
                while (true) {
                    // oxlint-disable-next-line no-await-in-loop -- each review result deterministically selects the next stage.
                    const reviewed = await this.review(
                        runId,
                        cwd,
                        config,
                        task,
                        stage,
                        stageAttempt + 1,
                        implementationResponse,
                        task.budgets.reviewerAttempts - reviewerAttempts,
                    );
                    reviewerAttempts += reviewed.attempts;
                    stageAttempt += reviewed.attempts;
                    if (reviewed.response.status !== 'completed') {
                        return this.settleFailedResponse(
                            runId,
                            task.id,
                            reviewed.response,
                        );
                    }
                    if (!reviewed.review) {
                        this.failTask(
                            runId,
                            task.id,
                            'invalid_review_output',
                            'failed',
                        );
                        return this.finishRun(runId, 'failed');
                    }
                    const review = reviewed.review;
                    if (review.verdict === 'pass') {
                        if (stage === 'quality') {
                            this.taskTransition(runId, task.id, 'verified');
                        }
                        this.markReviewApplied(
                            runId,
                            task.id,
                            reviewed.response.requestId,
                        );
                        if (stage === 'quality') {
                            return this.requireSnapshot(runId);
                        }
                        break;
                    }
                    if (review.verdict === 'blocked') {
                        this.failTask(
                            runId,
                            task.id,
                            'reviewer_blocked',
                            'needs_input',
                        );
                        this.markReviewApplied(
                            runId,
                            task.id,
                            reviewed.response.requestId,
                        );
                        return this.finishRun(runId, 'needs_input');
                    }
                    if (
                        corrections >= task.budgets.correctionWorkers ||
                        reviewerAttempts >= task.budgets.reviewerAttempts
                    ) {
                        this.failTask(
                            runId,
                            task.id,
                            'budget_exhausted',
                            'failed',
                        );
                        this.markReviewApplied(
                            runId,
                            task.id,
                            reviewed.response.requestId,
                        );
                        return this.finishRun(runId, 'failed');
                    }
                    corrections++;
                    // oxlint-disable-next-line no-await-in-loop -- a correction consumes the rejecting review before re-review.
                    implementationResponse = await this.correct(
                        runId,
                        cwd,
                        config,
                        task,
                        implementationResponse,
                        review,
                        corrections,
                        reviewed.response.requestId,
                    );
                    if (!accepted(implementationResponse)) {
                        return this.settleFailedResponse(
                            runId,
                            task.id,
                            implementationResponse,
                        );
                    }
                }
            }
            return this.taskTransition(runId, task.id, 'verified');
        }

        let corrections = 0;
        let reviewAttempt = 0;
        while (reviewAttempt < task.budgets.reviewerAttempts) {
            // oxlint-disable-next-line no-await-in-loop -- review verdicts deterministically gate correction or completion.
            const reviewed = await this.review(
                runId,
                cwd,
                config,
                task,
                'combined',
                reviewAttempt + 1,
                implementationResponse,
                task.budgets.reviewerAttempts - reviewAttempt,
            );
            reviewAttempt += reviewed.attempts;
            if (reviewed.response.status !== 'completed') {
                return this.settleFailedResponse(
                    runId,
                    task.id,
                    reviewed.response,
                );
            }
            if (!reviewed.review) {
                this.failTask(
                    runId,
                    task.id,
                    'invalid_review_output',
                    'failed',
                );
                return this.finishRun(runId, 'failed');
            }
            const review = reviewed.review;
            if (review.verdict === 'pass') {
                this.taskTransition(runId, task.id, 'verified');
                this.markReviewApplied(
                    runId,
                    task.id,
                    reviewed.response.requestId,
                );
                return this.requireSnapshot(runId);
            }
            if (review.verdict === 'blocked') {
                this.failTask(
                    runId,
                    task.id,
                    'reviewer_blocked',
                    'needs_input',
                );
                this.markReviewApplied(
                    runId,
                    task.id,
                    reviewed.response.requestId,
                );
                return this.finishRun(runId, 'needs_input');
            }
            if (
                corrections >= task.budgets.correctionWorkers ||
                reviewAttempt >= task.budgets.reviewerAttempts
            ) {
                this.failTask(runId, task.id, 'budget_exhausted', 'failed');
                this.markReviewApplied(
                    runId,
                    task.id,
                    reviewed.response.requestId,
                );
                return this.finishRun(runId, 'failed');
            }
            corrections++;
            // oxlint-disable-next-line no-await-in-loop -- Standard permits one ordered correction before re-review.
            implementationResponse = await this.correct(
                runId,
                cwd,
                config,
                task,
                implementationResponse,
                review,
                corrections,
                reviewed.response.requestId,
            );
            if (!accepted(implementationResponse)) {
                return this.settleFailedResponse(
                    runId,
                    task.id,
                    implementationResponse,
                );
            }
        }
        return this.requireSnapshot(runId);
    }

    private taskDelegations(runId: string, taskId: string) {
        return Object.values(
            this.requireSnapshot(runId).plannedDelegations,
        ).filter((delegation) => delegation.taskId === taskId);
    }

    private latestImplementationResponse(
        runId: string,
        taskId: string,
    ): SubagentDelegationResponse {
        const snapshot = this.requireSnapshot(runId);
        const planned = Object.values(snapshot.plannedDelegations).findLast(
            (delegation) =>
                delegation.taskId === taskId &&
                (delegation.stage === 'worker' ||
                    delegation.stage === 'correction') &&
                snapshot.tasks[taskId]?.terminalResponses?.[
                    delegation.requestId
                ] !== undefined,
        );
        const response = planned
            ? snapshot.tasks[taskId]?.terminalResponses?.[planned.requestId]
            : undefined;
        if (!response || !accepted(response)) {
            throw new Error(
                `No accepted implementation response for ${taskId}.`,
            );
        }
        return response;
    }

    private latestTaskReview(
        runId: string,
        taskId: string,
    ): {
        requestId: string;
        review: Review;
    } | null {
        const snapshot = this.requireSnapshot(runId);
        const planned = Object.values(snapshot.plannedDelegations).findLast(
            (delegation) =>
                delegation.taskId === taskId &&
                snapshot.tasks[taskId]?.reviewResults?.[
                    delegation.requestId
                ] !== undefined,
        );
        const review = planned
            ? snapshot.tasks[taskId]?.reviewResults?.[planned.requestId]
            : undefined;
        return planned && review
            ? { requestId: planned.requestId, review }
            : null;
    }

    private async resumeTask(
        runId: string,
        cwd: string,
        config: ReturnType<typeof loadSddConfig>,
        task: ApprovedManifestTask,
    ): Promise<RunSnapshot> {
        if (task.effectiveProfile === 'standard') {
            return this.resumeStandard(runId, cwd, config, task);
        }
        if (task.effectiveProfile === 'critical') {
            return this.resumeCritical(runId, cwd, config, task);
        }
        return this.requireSnapshot(runId);
    }

    private async resumeStandard(
        runId: string,
        cwd: string,
        config: ReturnType<typeof loadSddConfig>,
        task: ApprovedManifestTask,
    ): Promise<RunSnapshot> {
        let implementationResponse = this.latestImplementationResponse(
            runId,
            task.id,
        );
        let plans = this.taskDelegations(runId, task.id);
        let corrections = plans.filter(
            (delegation) => delegation.stage === 'correction',
        ).length;
        if (this.requireSnapshot(runId).tasks[task.id]?.state === 'fixing') {
            const rejecting = this.latestTaskReview(runId, task.id);
            if (!rejecting || rejecting.review.verdict !== 'changes_required') {
                return this.failRun(
                    runId,
                    'missing_rejecting_review',
                    'needs_input',
                );
            }
            corrections++;
            implementationResponse = await this.launchCorrection(
                runId,
                cwd,
                config,
                task,
                implementationResponse,
                rejecting.review,
                corrections,
            );
            if (!accepted(implementationResponse)) {
                return this.settleFailedResponse(
                    runId,
                    task.id,
                    implementationResponse,
                );
            }
            this.taskTransition(runId, task.id, 'reviewing');
        }
        plans = this.taskDelegations(runId, task.id);
        let reviewAttempt = plans.filter(
            (delegation) => delegation.stage === 'combined',
        ).length;
        while (reviewAttempt < task.budgets.reviewerAttempts) {
            // oxlint-disable-next-line no-await-in-loop -- persisted Standard verdicts deterministically select the next boundary.
            const reviewed = await this.review(
                runId,
                cwd,
                config,
                task,
                'combined',
                reviewAttempt + 1,
                implementationResponse,
                task.budgets.reviewerAttempts - reviewAttempt,
            );
            reviewAttempt += reviewed.attempts;
            if (reviewed.response.status !== 'completed') {
                return this.settleFailedResponse(
                    runId,
                    task.id,
                    reviewed.response,
                );
            }
            if (!reviewed.review) {
                this.failTask(
                    runId,
                    task.id,
                    'invalid_review_output',
                    'failed',
                );
                return this.finishRun(runId, 'failed');
            }
            if (reviewed.review.verdict === 'pass') {
                this.taskTransition(runId, task.id, 'verified');
                this.markReviewApplied(
                    runId,
                    task.id,
                    reviewed.response.requestId,
                );
                return this.requireSnapshot(runId);
            }
            if (reviewed.review.verdict === 'blocked') {
                this.failTask(
                    runId,
                    task.id,
                    'reviewer_blocked',
                    'needs_input',
                );
                this.markReviewApplied(
                    runId,
                    task.id,
                    reviewed.response.requestId,
                );
                return this.finishRun(runId, 'needs_input');
            }
            if (
                corrections >= task.budgets.correctionWorkers ||
                reviewAttempt >= task.budgets.reviewerAttempts
            ) {
                this.failTask(runId, task.id, 'budget_exhausted', 'failed');
                this.markReviewApplied(
                    runId,
                    task.id,
                    reviewed.response.requestId,
                );
                return this.finishRun(runId, 'failed');
            }
            corrections++;
            // oxlint-disable-next-line no-await-in-loop -- a persisted rejection must be corrected before its ordered re-review.
            implementationResponse = await this.correct(
                runId,
                cwd,
                config,
                task,
                implementationResponse,
                reviewed.review,
                corrections,
                reviewed.response.requestId,
            );
            if (!accepted(implementationResponse)) {
                return this.settleFailedResponse(
                    runId,
                    task.id,
                    implementationResponse,
                );
            }
        }
        return this.requireSnapshot(runId);
    }

    private async resumeCritical(
        runId: string,
        cwd: string,
        config: ReturnType<typeof loadSddConfig>,
        task: ApprovedManifestTask,
    ): Promise<RunSnapshot> {
        let implementationResponse = this.latestImplementationResponse(
            runId,
            task.id,
        );
        let plans = this.taskDelegations(runId, task.id);
        let corrections = plans.filter(
            (delegation) => delegation.stage === 'correction',
        ).length;
        let forcedStage: 'spec' | 'quality' | undefined;
        if (this.requireSnapshot(runId).tasks[task.id]?.state === 'fixing') {
            const rejecting = this.latestTaskReview(runId, task.id);
            if (
                !rejecting ||
                rejecting.review.verdict !== 'changes_required' ||
                (rejecting.review.stage !== 'spec' &&
                    rejecting.review.stage !== 'quality')
            ) {
                return this.failRun(
                    runId,
                    'missing_rejecting_review',
                    'needs_input',
                );
            }
            forcedStage = rejecting.review.stage;
            corrections++;
            implementationResponse = await this.launchCorrection(
                runId,
                cwd,
                config,
                task,
                implementationResponse,
                rejecting.review,
                corrections,
            );
            if (!accepted(implementationResponse)) {
                return this.settleFailedResponse(
                    runId,
                    task.id,
                    implementationResponse,
                );
            }
            this.taskTransition(runId, task.id, 'reviewing');
        }
        plans = this.taskDelegations(runId, task.id);
        let reviewerAttempts = plans.filter((delegation) =>
            ['spec', 'quality'].includes(delegation.stage),
        ).length;
        const taskSnapshot = this.requireSnapshot(runId).tasks[task.id];
        const appliedReviews = Object.entries(taskSnapshot.reviewResults ?? {})
            .filter(([requestId]) =>
                taskSnapshot.appliedReviewRequestIds?.includes(requestId),
            )
            .map(([, review]) => review);
        const specPassed = appliedReviews.some(
            (review) => review.stage === 'spec' && review.verdict === 'pass',
        );
        const stages: Array<'spec' | 'quality'> = forcedStage
            ? [
                  forcedStage,
                  ...(forcedStage === 'spec' ? ['quality' as const] : []),
              ]
            : specPassed
              ? ['quality']
              : ['spec', 'quality'];
        for (const stage of stages) {
            let stageAttempt = plans.filter(
                (delegation) => delegation.stage === stage,
            ).length;
            while (true) {
                // oxlint-disable-next-line no-await-in-loop -- persisted Critical stage verdicts determine the next bounded review.
                const reviewed = await this.review(
                    runId,
                    cwd,
                    config,
                    task,
                    stage,
                    stageAttempt + 1,
                    implementationResponse,
                    task.budgets.reviewerAttempts - reviewerAttempts,
                );
                reviewerAttempts += reviewed.attempts;
                stageAttempt += reviewed.attempts;
                if (reviewed.response.status !== 'completed') {
                    return this.settleFailedResponse(
                        runId,
                        task.id,
                        reviewed.response,
                    );
                }
                if (!reviewed.review) {
                    this.failTask(
                        runId,
                        task.id,
                        'invalid_review_output',
                        'failed',
                    );
                    return this.finishRun(runId, 'failed');
                }
                if (reviewed.review.verdict === 'pass') {
                    if (stage === 'quality') {
                        this.taskTransition(runId, task.id, 'verified');
                    }
                    this.markReviewApplied(
                        runId,
                        task.id,
                        reviewed.response.requestId,
                    );
                    if (stage === 'quality') return this.requireSnapshot(runId);
                    break;
                }
                if (reviewed.review.verdict === 'blocked') {
                    this.failTask(
                        runId,
                        task.id,
                        'reviewer_blocked',
                        'needs_input',
                    );
                    this.markReviewApplied(
                        runId,
                        task.id,
                        reviewed.response.requestId,
                    );
                    return this.finishRun(runId, 'needs_input');
                }
                if (
                    corrections >= task.budgets.correctionWorkers ||
                    reviewerAttempts >= task.budgets.reviewerAttempts
                ) {
                    this.failTask(runId, task.id, 'budget_exhausted', 'failed');
                    this.markReviewApplied(
                        runId,
                        task.id,
                        reviewed.response.requestId,
                    );
                    return this.finishRun(runId, 'failed');
                }
                corrections++;
                // oxlint-disable-next-line no-await-in-loop -- Critical corrections precede re-review of the rejecting stage.
                implementationResponse = await this.correct(
                    runId,
                    cwd,
                    config,
                    task,
                    implementationResponse,
                    reviewed.review,
                    corrections,
                    reviewed.response.requestId,
                );
                if (!accepted(implementationResponse)) {
                    return this.settleFailedResponse(
                        runId,
                        task.id,
                        implementationResponse,
                    );
                }
            }
        }
        return this.requireSnapshot(runId);
    }

    completeDirect(
        runId: string,
        taskId: string,
        evidence: DirectEvidence,
        _currentPlanContent: string,
        recovery?: RecoveryAttestation,
    ): RunSnapshot {
        const manifest = this.requireManifest(runId);
        const task = manifest.tasks.find(
            (candidate) => candidate.id === taskId,
        );
        if (!task) throw new Error(`Unknown task: ${taskId}.`);
        const snapshot = this.requireSnapshot(runId);
        const taskSnapshot = snapshot.tasks[taskId];
        this.validateDirectEvidence(evidence);
        const choice = recovery
            ? this.buildRecoveryChoice(recovery, evidence)
            : undefined;
        if (taskSnapshot?.recoveryChoice) {
            if (
                !choice ||
                JSON.stringify(choice) !==
                    JSON.stringify(taskSnapshot.recoveryChoice)
            ) {
                throw new Error(`Recovery attestation conflict: ${taskId}.`);
            }
            return snapshot;
        }
        const uncertainRecovery =
            snapshot.state === 'needs_input' &&
            taskSnapshot?.state === 'needs_input' &&
            taskSnapshot.terminalReason === 'uncertain_foreground_delegation';
        if (task.effectiveProfile !== 'direct' && !uncertainRecovery) {
            throw new Error(`Task ${taskId} is not a Direct task.`);
        }
        if (
            !uncertainRecovery &&
            snapshot.tasks[taskId]?.state !== 'awaiting_direct_agent'
        ) {
            throw new Error(`Task ${taskId} is not awaiting Direct evidence.`);
        }
        if (!this.sourceDigestMatches(manifest)) {
            throw new Error('Source plan changed after approval.');
        }

        if (uncertainRecovery) {
            if (!choice) throw new Error('Recovery attestation is required.');
            const planned = snapshot.plannedDelegations[choice.requestId];
            if (!planned || planned.taskId !== taskId) {
                throw new Error(
                    `Recovery attestation request does not match the uncertain delegation for ${taskId}.`,
                );
            }
            if (planned.stage !== choice.stage) {
                throw new Error(
                    `Recovery attestation stage does not match persisted stage ${planned.stage}.`,
                );
            }
            if (taskSnapshot.activeRequestId !== choice.requestId) {
                throw new Error(
                    `Recovery attestation request does not match active request for ${taskId}.`,
                );
            }
            return this.persist(runId, {
                type: 'recovery-attestation-applied',
                expectedRevision: snapshot.revision,
                taskId,
                profile: task.effectiveProfile,
                choice,
            });
        }
        if (recovery) {
            throw new Error(
                'Recovery attestation is only valid for uncertain needs_input tasks.',
            );
        }

        this.persist(runId, {
            type: 'direct-evidence-recorded',
            expectedRevision: snapshot.revision,
            taskId,
            evidence,
        });
        this.taskTransition(runId, taskId, 'verified');
        const verified = this.requireSnapshot(runId);
        if (
            manifest.tasks.every(
                (candidate) =>
                    verified.tasks[candidate.id]?.state === 'verified',
            )
        ) {
            if (manifest.finalIntegrationReview) return verified;
            return this.finishRun(runId, 'completed');
        }
        return verified;
    }

    private buildRecoveryChoice(
        recovery: RecoveryAttestation,
        evidence: DirectEvidence,
    ): RecoveryChoice {
        if (recovery.action !== 'attest' || !recovery.confirmation) {
            throw new Error(
                'Recovery attestation requires explicit confirmation.',
            );
        }
        const authorizedBy = recovery.authorizedBy.trim();
        if (!authorizedBy) {
            throw new Error(
                'Recovery attestation authorizedBy must not be empty.',
            );
        }
        const attestation: RecoveryAttestation = {
            action: 'attest',
            confirmation: true,
            authorizedBy,
            requestId: recovery.requestId,
            stage: recovery.stage,
        };
        const boundEvidence: DirectEvidence = {
            changedFiles: [...evidence.changedFiles],
            tests: [...evidence.tests],
            commands: [...evidence.commands],
            validationOutput: evidence.validationOutput,
            residualRisks: [...evidence.residualRisks],
        };
        return {
            ...attestation,
            priorReason: 'uncertain_foreground_delegation',
            evidence: boundEvidence,
            digest: recoveryAttestationDigest(attestation, boundEvidence),
        };
    }

    reconcile(runId: string): RunSnapshot {
        const manifest = this.requireManifest(runId);
        let snapshot = this.requireSnapshot(runId);
        this.validateSnapshot(snapshot, manifest);
        if (snapshot.state !== 'running') return snapshot;

        for (const task of manifest.tasks) {
            snapshot = this.requireSnapshot(runId);
            const taskSnapshot = snapshot.tasks[task.id];
            if (!taskSnapshot) continue;
            if (
                ['verified', 'needs_input', 'failed', 'cancelled'].includes(
                    taskSnapshot.state,
                )
            ) {
                continue;
            }
            const plannedDelegations = Object.values(
                snapshot.plannedDelegations,
            ).filter((delegation) => delegation.taskId === task.id);
            if (
                taskSnapshot.state === 'implementing' &&
                plannedDelegations.length === 0
            ) {
                this.failTask(
                    runId,
                    task.id,
                    'missing_delegation_plan',
                    'needs_input',
                );
                continue;
            }
            if (taskSnapshot.activeRequestId) {
                this.failTask(
                    runId,
                    task.id,
                    'uncertain_foreground_delegation',
                    'needs_input',
                );
                continue;
            }
            for (const [
                plannedIndex,
                planned,
            ] of plannedDelegations.entries()) {
                snapshot = this.requireSnapshot(runId);
                const currentTask = snapshot.tasks[task.id];
                const response =
                    currentTask?.terminalResponses?.[planned.requestId];
                if (!currentTask || !response) continue;
                if (
                    currentTask.appliedResponseRequestIds?.includes(
                        planned.requestId,
                    )
                ) {
                    continue;
                }
                if (response.status !== 'completed') {
                    if (
                        ['implementing', 'reviewing', 'fixing'].includes(
                            currentTask.state,
                        )
                    ) {
                        this.settleFailedResponse(runId, task.id, response);
                    }
                    this.markResponseApplied(runId, task.id, planned.requestId);
                    break;
                }
                if (
                    planned.stage === 'worker' ||
                    planned.stage === 'correction'
                ) {
                    if (!accepted(response)) {
                        if (
                            ['implementing', 'reviewing', 'fixing'].includes(
                                currentTask.state,
                            )
                        ) {
                            this.settleFailedResponse(runId, task.id, response);
                        }
                        break;
                    }
                    if (
                        planned.stage === 'worker' &&
                        currentTask.state === 'implementing'
                    ) {
                        this.taskTransition(runId, task.id, 'reviewing');
                    } else if (
                        planned.stage === 'correction' &&
                        currentTask.state === 'fixing'
                    ) {
                        this.taskTransition(runId, task.id, 'reviewing');
                    }
                    if (
                        planned.stage === 'worker' &&
                        task.effectiveProfile === 'light' &&
                        this.requireSnapshot(runId).tasks[task.id]?.state ===
                            'reviewing'
                    ) {
                        this.taskTransition(runId, task.id, 'verified');
                    }
                    this.markResponseApplied(runId, task.id, planned.requestId);
                    continue;
                }
                if (
                    planned.stage !== 'combined' &&
                    planned.stage !== 'spec' &&
                    planned.stage !== 'quality'
                ) {
                    this.markResponseApplied(runId, task.id, planned.requestId);
                    continue;
                }
                if (
                    currentTask.appliedReviewRequestIds?.includes(
                        planned.requestId,
                    )
                ) {
                    this.markResponseApplied(runId, task.id, planned.requestId);
                    continue;
                }
                let review = currentTask.reviewResults?.[planned.requestId];
                if (!review) {
                    const laterRepairExists = plannedDelegations
                        .slice(plannedIndex + 1)
                        .some(
                            (later) =>
                                later.stage === planned.stage &&
                                currentTask.terminalResponses?.[
                                    later.requestId
                                ] !== undefined,
                        );
                    if (laterRepairExists) {
                        this.markResponseApplied(
                            runId,
                            task.id,
                            planned.requestId,
                        );
                        continue;
                    }
                    try {
                        review = this.parseAndRecordReview(
                            runId,
                            task.id,
                            response,
                            planned.stage,
                        );
                    } catch {
                        this.failTask(
                            runId,
                            task.id,
                            'invalid_review_output',
                            'failed',
                        );
                        break;
                    }
                }
                snapshot = this.requireSnapshot(runId);
                const refreshed = snapshot.tasks[task.id];
                const corrections = plannedDelegations.filter(
                    (delegation) => delegation.stage === 'correction',
                ).length;
                const reviewerAttempts = plannedDelegations.filter(
                    (delegation) =>
                        delegation.stage === 'combined' ||
                        delegation.stage === 'spec' ||
                        delegation.stage === 'quality',
                ).length;
                if (review.verdict === 'blocked') {
                    if (refreshed.state === 'reviewing') {
                        this.failTask(
                            runId,
                            task.id,
                            'reviewer_blocked',
                            'needs_input',
                        );
                    }
                    this.markReviewApplied(runId, task.id, planned.requestId);
                    break;
                }
                if (review.verdict === 'pass') {
                    if (
                        planned.stage !== 'spec' &&
                        refreshed.state === 'reviewing'
                    ) {
                        this.taskTransition(runId, task.id, 'verified');
                    }
                    this.markReviewApplied(runId, task.id, planned.requestId);
                    continue;
                }
                if (
                    corrections >= task.budgets.correctionWorkers ||
                    reviewerAttempts >= task.budgets.reviewerAttempts
                ) {
                    if (refreshed.state === 'reviewing') {
                        this.failTask(
                            runId,
                            task.id,
                            'budget_exhausted',
                            'failed',
                        );
                    }
                } else if (refreshed.state === 'reviewing') {
                    this.taskTransition(runId, task.id, 'fixing');
                }
                this.markReviewApplied(runId, task.id, planned.requestId);
                break;
            }
        }

        snapshot = this.requireSnapshot(runId);
        if (
            Object.values(snapshot.tasks).some(
                (task) => task.state === 'needs_input',
            )
        ) {
            return this.finishRun(runId, 'needs_input');
        }
        if (
            Object.values(snapshot.tasks).some(
                (task) => task.state === 'failed',
            )
        ) {
            return this.finishRun(runId, 'failed');
        }
        if (
            manifest.tasks.every(
                (task) => snapshot.tasks[task.id]?.state === 'verified',
            ) &&
            !manifest.finalIntegrationReview
        ) {
            return this.finishRun(runId, 'completed');
        }
        if (
            manifest.finalIntegrationReview &&
            manifest.tasks.every(
                (task) => snapshot.tasks[task.id]?.state === 'verified',
            )
        ) {
            if (snapshot.integrationReview?.activeRequestId) {
                return this.failRun(
                    runId,
                    'uncertain_foreground_delegation',
                    'needs_input',
                );
            }
            if (snapshot.integrationReview?.terminalResponse) {
                return this.applyIntegrationResponse(runId);
            }
        }
        return snapshot;
    }

    cancel(runId: string): RunSnapshot {
        const manifest = this.requireManifest(runId);
        let snapshot = this.requireSnapshot(runId);
        if (snapshot.cancellation) {
            return snapshot.state === 'running' &&
                !this.hasActiveRequest(snapshot)
                ? this.finishRun(runId, 'cancelled')
                : snapshot;
        }
        if (snapshot.state === 'approved') {
            snapshot = this.persist(runId, {
                type: 'run-transition',
                expectedRevision: snapshot.revision,
                to: 'running',
            });
        }
        if (snapshot.state !== 'running') return snapshot;
        const requestIds = manifest.tasks
            .map((task) => snapshot.tasks[task.id]?.activeRequestId)
            .filter(
                (requestId): requestId is string => requestId !== undefined,
            );
        if (snapshot.integrationReview?.activeRequestId) {
            requestIds.push(snapshot.integrationReview.activeRequestId);
        }
        snapshot = this.persist(runId, {
            type: 'cancellation-requested',
            expectedRevision: snapshot.revision,
            requestedAt: new Date().toISOString(),
            requestIds,
        });
        for (const requestId of requestIds) {
            this.delegation.cancel(requestId);
        }
        return requestIds.length === 0
            ? this.finishRun(runId, 'cancelled')
            : snapshot;
    }

    private requireManifest(runId: string): ApprovedManifest {
        const manifest = this.loadManifest(runId);
        if (!manifest)
            throw new Error(`Approved manifest not found: ${runId}.`);
        return manifest;
    }

    private requireSnapshot(runId: string): RunSnapshot {
        const snapshot = this.store.load(runId);
        if (!snapshot) throw new Error(`SDD run not found: ${runId}.`);
        return snapshot;
    }

    private validateSnapshot(
        snapshot: RunSnapshot,
        manifest: ApprovedManifest,
    ): void {
        for (const task of manifest.tasks) {
            if (!snapshot.tasks[task.id]) {
                throw new Error(`Run snapshot is missing task ${task.id}.`);
            }
            if (
                snapshot.tasks[task.id].maxLaunches !== task.budgets.maxLaunches
            ) {
                throw new Error(`Run snapshot budget mismatch for ${task.id}.`);
            }
        }
    }

    private sourceDigestMatches(manifest: ApprovedManifest): boolean {
        try {
            const source = readFileSync(manifest.planPath);
            return (
                createHash('sha256').update(source).digest('hex') ===
                manifest.sourceDigest
            );
        } catch {
            return false;
        }
    }

    private hasActiveRequest(snapshot: RunSnapshot): boolean {
        return (
            snapshot.integrationReview?.activeRequestId !== undefined ||
            Object.values(snapshot.tasks).some(
                (task) => task.activeRequestId !== undefined,
            )
        );
    }

    private integrationTask(
        manifest: ApprovedManifest,
        snapshot: RunSnapshot,
    ): ApprovedManifestTask {
        const files = [
            ...new Set(manifest.tasks.flatMap((task) => task.files)),
        ];
        const verify = manifest.tasks.flatMap((task) => task.verify);
        const evidence = manifest.tasks.map((task) => {
            const taskSnapshot = snapshot.tasks[task.id];
            return {
                taskId: task.id,
                scope: {
                    title: task.title,
                    description: task.description,
                    files: task.files,
                    verify: task.verify,
                },
                directEvidence: taskSnapshot?.directEvidence,
                terminalResponses: taskSnapshot?.terminalResponses,
                reviewResults: taskSnapshot?.reviewResults,
            };
        });
        return {
            id: `manifest:${manifest.manifestId}`,
            title: `Final integration review for ${manifest.manifestId}`,
            description: JSON.stringify({
                manifestId: manifest.manifestId,
                approvalDigest: manifest.approvalDigest,
                sourceDigest: manifest.sourceDigest,
                approvedTasksAndEvidence: evidence,
            }),
            recommendedProfile: 'standard',
            effectiveProfile: 'standard',
            classificationRules: [],
            signals: [],
            dependencies: manifest.tasks.map((task) => task.id),
            files,
            verify,
            budgets: {
                initialWorkers: 0,
                correctionWorkers: 0,
                reviewerAttempts: 1,
                maxLaunches: 1,
            },
            parallelEligible: false,
        };
    }

    private async runIntegrationReview(
        runId: string,
        cwd: string,
        config: ReturnType<typeof loadSddConfig>,
    ): Promise<RunSnapshot> {
        const manifest = this.requireManifest(runId);
        let snapshot = this.requireSnapshot(runId);
        if (snapshot.integrationReview?.applied) {
            return this.finishRun(runId, 'completed');
        }
        if (snapshot.integrationReview?.activeRequestId) {
            return this.failRun(
                runId,
                'uncertain_foreground_delegation',
                'needs_input',
            );
        }
        if (snapshot.integrationReview?.terminalResponse) {
            return this.applyIntegrationResponse(runId);
        }
        const taskLaunches = Object.values(snapshot.tasks).reduce(
            (total, task) => total + task.launches,
            0,
        );
        if (taskLaunches >= manifest.maximumLaunches) {
            return this.failRun(
                runId,
                'manifest_launch_budget_exhausted',
                'failed',
            );
        }
        const requestId = `${runId}:manifest:integration:1`;
        const task = this.integrationTask(manifest, snapshot);
        const request = buildReviewRequest({
            requestId,
            logicalJobId: `${runId}:manifest:integration`,
            cwd,
            config,
            task,
            stage: 'integration',
            implementationResponse: {
                version: 1,
                requestId: `${runId}:manifest:evidence`,
                status: 'completed',
                output: task.description,
            },
        });
        if (snapshot.cancellation) {
            return this.finishRun(runId, 'cancelled');
        }
        if (!this.sourceDigestMatches(manifest)) {
            return this.failRun(runId, 'source_digest_changed', 'needs_input');
        }
        snapshot = this.persist(runId, {
            type: 'integration-delegation-planned',
            expectedRevision: snapshot.revision,
            delegation: {
                idempotencyKey: requestId,
                taskId: task.id,
                requestId,
                stage: 'integration',
                attempt: 1,
                plannedAt: new Date().toISOString(),
            },
        });
        const response = await this.delegation.run(request);
        snapshot = this.persist(runId, {
            type: 'integration-delegation-response-recorded',
            expectedRevision: snapshot.revision,
            response,
        });
        return this.applyIntegrationResponse(runId);
    }

    private applyIntegrationResponse(runId: string): RunSnapshot {
        const manifest = this.requireManifest(runId);
        let snapshot = this.requireSnapshot(runId);
        const response = snapshot.integrationReview?.terminalResponse;
        if (!response) return snapshot;
        if (
            response.status === 'cancelled' &&
            snapshot.cancellation?.requestIds.includes(response.requestId)
        ) {
            return this.finishRun(runId, 'cancelled');
        }
        if (response.status !== 'completed') {
            return this.failRun(
                runId,
                response.status === 'unavailable_context'
                    ? 'integration_unavailable_context'
                    : `integration_${response.status}`,
                response.status === 'unavailable_context'
                    ? 'needs_input'
                    : 'failed',
            );
        }
        let review = snapshot.integrationReview?.review;
        if (!review) {
            try {
                review = parseReviewResponse(
                    response.output ?? '',
                    `manifest:${manifest.manifestId}`,
                    'integration',
                );
            } catch {
                return this.failRun(
                    runId,
                    'invalid_integration_review_output',
                    'needs_input',
                );
            }
            snapshot = this.persist(runId, {
                type: 'integration-review-recorded',
                expectedRevision: snapshot.revision,
                requestId: response.requestId,
                review,
            });
        }
        if (!snapshot.integrationReview?.applied) {
            snapshot = this.persist(runId, {
                type: 'integration-review-applied',
                expectedRevision: snapshot.revision,
                requestId: response.requestId,
            });
        }
        if (review.verdict === 'pass') {
            return this.finishRun(runId, 'completed');
        }
        return this.failRun(
            runId,
            review.verdict === 'blocked'
                ? 'integration_reviewer_blocked'
                : 'integration_changes_required',
            review.verdict === 'blocked' ? 'needs_input' : 'failed',
        );
    }

    private validateDirectEvidence(evidence: DirectEvidence): void {
        for (const field of [
            'changedFiles',
            'tests',
            'commands',
            'residualRisks',
        ] as const) {
            if (
                evidence[field].length === 0 ||
                evidence[field].some((value) => !value.trim())
            ) {
                throw new Error(`Direct evidence ${field} must not be empty.`);
            }
        }
        if (!evidence.validationOutput.trim()) {
            throw new Error(
                'Direct evidence validationOutput must not be empty.',
            );
        }
    }

    private persist(runId: string, event: RunEvent): RunSnapshot {
        const next = transition(this.requireSnapshot(runId), event);
        this.store.save(next);
        this.store.appendTransition({
            runId,
            revision: next.revision,
            event,
            timestamp: new Date().toISOString(),
            snapshotDigest: snapshotDigest(next),
        });
        return next;
    }

    private taskTransition(
        runId: string,
        taskId: string,
        to: TaskState,
    ): RunSnapshot {
        const snapshot = this.requireSnapshot(runId);
        return this.persist(runId, {
            type: 'task-transition',
            expectedRevision: snapshot.revision,
            taskId,
            to,
        });
    }

    private finishRun(
        runId: string,
        to: 'needs_input' | 'failed' | 'cancelled' | 'completed',
    ): RunSnapshot {
        const snapshot = this.requireSnapshot(runId);
        if (snapshot.state !== 'running') return snapshot;
        return this.persist(runId, {
            type: 'run-transition',
            expectedRevision: snapshot.revision,
            to,
        });
    }

    private failRun(
        runId: string,
        reason: string,
        state: 'needs_input' | 'failed' | 'cancelled',
    ): RunSnapshot {
        let snapshot = this.requireSnapshot(runId);
        this.persist(runId, {
            type: 'run-terminal-reason-recorded',
            expectedRevision: snapshot.revision,
            reason,
        });
        return this.finishRun(runId, state);
    }

    private planDelegation(
        runId: string,
        taskId: string,
        requestId: string,
        stage: string,
        attempt: number,
    ): RunSnapshot {
        const snapshot = this.requireSnapshot(runId);
        return this.persist(runId, {
            type: 'delegation-planned',
            expectedRevision: snapshot.revision,
            idempotencyKey: requestId,
            taskId,
            requestId,
            stage,
            attempt,
            plannedAt: new Date().toISOString(),
        });
    }

    private recordResponse(
        runId: string,
        taskId: string,
        response: SubagentDelegationResponse,
    ): RunSnapshot {
        const snapshot = this.requireSnapshot(runId);
        return this.persist(runId, {
            type: 'delegation-response-recorded',
            expectedRevision: snapshot.revision,
            taskId,
            response,
        });
    }

    private async launch(
        runId: string,
        task: ApprovedManifestTask,
        stage: string,
        attempt: number,
        request: Parameters<WorkflowDelegation['run']>[0],
    ): Promise<SubagentDelegationResponse> {
        const snapshot = this.requireSnapshot(runId);
        if (snapshot.cancellation) {
            this.finishRun(runId, 'cancelled');
            return {
                version: 1,
                requestId: request.requestId,
                status: 'cancelled',
                error: 'cancellation_requested',
            };
        }
        if (!this.sourceDigestMatches(this.requireManifest(runId))) {
            this.failRun(runId, 'source_digest_changed', 'needs_input');
            return {
                version: 1,
                requestId: request.requestId,
                status: 'unavailable_context',
                error: 'source_digest_changed',
            };
        }
        this.planDelegation(runId, task.id, request.requestId, stage, attempt);
        const response = await this.delegation.run(request);
        this.recordResponse(runId, task.id, response);
        return response;
    }

    private async review(
        runId: string,
        cwd: string,
        config: ReturnType<typeof loadSddConfig>,
        task: ApprovedManifestTask,
        stage: ReviewStage,
        firstAttempt: number,
        implementationResponse: SubagentDelegationResponse,
        remainingReviewerAttempts: number,
    ): Promise<{
        response: SubagentDelegationResponse;
        review?: Review;
        attempts: number;
    }> {
        const launch = (
            attempt: number,
            repair?: {
                attempt: number;
                validationError: string;
                originalOutput: string;
                remainingReviewerAttempts: number;
                remainingLaunches: number;
            },
        ) =>
            this.launch(
                runId,
                task,
                stage,
                attempt,
                buildReviewRequest({
                    requestId: `${runId}:${task.id}:${stage}:${attempt}`,
                    logicalJobId: `${runId}:${task.id}:${stage}`,
                    cwd,
                    config,
                    task,
                    stage,
                    implementationResponse,
                    ...(repair ? { repair } : {}),
                }),
            );
        let response = await launch(firstAttempt);
        if (response.status !== 'completed') {
            return { response, attempts: 1 };
        }
        try {
            return {
                response,
                review: this.parseAndRecordReview(
                    runId,
                    task.id,
                    response,
                    stage,
                ),
                attempts: 1,
            };
        } catch (error) {
            const taskSnapshot = this.requireSnapshot(runId).tasks[task.id];
            const remainingLaunches =
                task.budgets.maxLaunches - taskSnapshot.launches;
            if (
                config.structuredOutputRetries < 1 ||
                remainingReviewerAttempts < 2 ||
                remainingLaunches < 1
            ) {
                return { response, attempts: 1 };
            }
            this.markResponseApplied(runId, task.id, response.requestId);
            response = await launch(firstAttempt + 1, {
                attempt: 1,
                validationError:
                    error instanceof Error ? error.message : String(error),
                originalOutput: response.output ?? '',
                remainingReviewerAttempts: remainingReviewerAttempts - 1,
                remainingLaunches,
            });
            if (response.status !== 'completed') {
                return { response, attempts: 2 };
            }
            try {
                return {
                    response,
                    review: this.parseAndRecordReview(
                        runId,
                        task.id,
                        response,
                        stage,
                    ),
                    attempts: 2,
                };
            } catch {
                return { response, attempts: 2 };
            }
        }
    }

    private parseAndRecordReview(
        runId: string,
        taskId: string,
        response: SubagentDelegationResponse,
        stage: ReviewStage,
    ): Review {
        const review = parseReviewResponse(
            response.output ?? '',
            taskId,
            stage,
        );
        const snapshot = this.requireSnapshot(runId);
        this.persist(runId, {
            type: 'review-recorded',
            expectedRevision: snapshot.revision,
            taskId,
            requestId: response.requestId,
            review,
        });
        return review;
    }

    private markReviewApplied(
        runId: string,
        taskId: string,
        requestId: string,
    ): RunSnapshot {
        const snapshot = this.requireSnapshot(runId);
        this.persist(runId, {
            type: 'review-applied',
            expectedRevision: snapshot.revision,
            taskId,
            requestId,
        });
        return this.markResponseApplied(runId, taskId, requestId);
    }

    private markResponseApplied(
        runId: string,
        taskId: string,
        requestId: string,
    ): RunSnapshot {
        const snapshot = this.requireSnapshot(runId);
        return this.persist(runId, {
            type: 'delegation-response-applied',
            expectedRevision: snapshot.revision,
            taskId,
            requestId,
        });
    }

    private settleFailedResponse(
        runId: string,
        taskId: string,
        response: SubagentDelegationResponse,
    ): RunSnapshot {
        const snapshot = this.requireSnapshot(runId);
        if (/^BLOCKED:\s+\S/.test(response.output?.trimStart() ?? '')) {
            this.failTask(runId, taskId, 'worker_blocked', 'needs_input');
            return this.finishRun(runId, 'needs_input');
        }
        if (response.error === 'source_digest_changed') {
            this.failTask(
                runId,
                taskId,
                'source_digest_changed',
                'needs_input',
            );
            return this.finishRun(runId, 'needs_input');
        }
        if (response.error === 'cancellation_requested') {
            this.failTask(runId, taskId, 'cancelled', 'cancelled');
            return this.finishRun(runId, 'cancelled');
        }
        if (
            response.status === 'cancelled' &&
            snapshot.cancellation?.requestIds.includes(response.requestId)
        ) {
            this.failTask(runId, taskId, 'cancelled', 'cancelled');
            return this.finishRun(runId, 'cancelled');
        }
        const needsInput = response.status === 'unavailable_context';
        const reason = needsInput
            ? 'unavailable_context'
            : response.status === 'completed'
              ? 'acceptance_not_verified'
              : response.status;
        this.failTask(
            runId,
            taskId,
            reason,
            needsInput ? 'needs_input' : 'failed',
        );
        return this.finishRun(runId, needsInput ? 'needs_input' : 'failed');
    }

    private async correct(
        runId: string,
        cwd: string,
        config: ReturnType<typeof loadSddConfig>,
        task: ApprovedManifestTask,
        priorResponse: SubagentDelegationResponse,
        review: Review,
        correction: number,
        rejectingRequestId: string,
    ): Promise<SubagentDelegationResponse> {
        this.taskTransition(runId, task.id, 'fixing');
        this.markReviewApplied(runId, task.id, rejectingRequestId);
        return this.launchCorrection(
            runId,
            cwd,
            config,
            task,
            priorResponse,
            review,
            correction,
        );
    }

    private async launchCorrection(
        runId: string,
        cwd: string,
        config: ReturnType<typeof loadSddConfig>,
        task: ApprovedManifestTask,
        priorResponse: SubagentDelegationResponse,
        review: Review,
        correction: number,
    ): Promise<SubagentDelegationResponse> {
        const response = await this.launch(
            runId,
            task,
            'correction',
            correction,
            buildCorrectionRequest({
                requestId: `${runId}:${task.id}:correction:${correction}`,
                cwd,
                config,
                task,
                priorResponse,
                findings: review.findings,
                reportedChangedFiles: [],
                reportedCommandResults: [],
                remainingCorrections:
                    task.budgets.correctionWorkers - correction,
            }),
        );
        if (accepted(response)) {
            this.taskTransition(runId, task.id, 'reviewing');
            this.markResponseApplied(runId, task.id, response.requestId);
        }
        return response;
    }

    private failTask(
        runId: string,
        taskId: string,
        reason: string,
        state: 'needs_input' | 'failed' | 'cancelled',
    ): void {
        let snapshot = this.requireSnapshot(runId);
        this.persist(runId, {
            type: 'terminal-reason-recorded',
            expectedRevision: snapshot.revision,
            taskId,
            reason,
        });
        snapshot = this.requireSnapshot(runId);
        this.persist(runId, {
            type: 'task-transition',
            expectedRevision: snapshot.revision,
            taskId,
            to: state,
        });
    }
}

export function completeDirect(
    workflow: SddWorkflow,
    runId: string,
    taskId: string,
    evidence: DirectEvidence,
    currentPlanContent: string,
    recovery?: RecoveryAttestation,
): RunSnapshot {
    return workflow.completeDirect(
        runId,
        taskId,
        evidence,
        currentPlanContent,
        recovery,
    );
}
