import { createHash } from "node:crypto";
import type { Review } from "./prompts.ts";
import type { Profile } from "./types.ts";

export type RunState =
    | "draft"
    | "assessed"
    | "awaiting_approval"
    | "approved"
    | "running"
    | "needs_input"
    | "failed"
    | "cancelled"
    | "completed";

export type TaskState =
    | "pending"
    | "awaiting_direct_agent"
    | "implementing"
    | "reviewing"
    | "fixing"
    | "verified"
    | "needs_input"
    | "failed"
    | "cancelled";

export interface TaskSnapshot {
    id: string;
    state: TaskState;
    launches: number;
    maxLaunches: number;
    activeRequestId?: string;
    terminalResponses?: Record<string, DelegationTerminalResponse>;
    appliedResponseRequestIds?: string[];
    reviewResults?: Record<string, Review>;
    appliedReviewRequestIds?: string[];
    directEvidence?: DirectEvidence;
    recoveryChoice?: RecoveryChoice;
    terminalReason?: string;
}

export interface DelegationTerminalResponse {
    version: 1;
    requestId: string;
    status:
        | "completed"
        | "failed"
        | "timed_out"
        | "cancelled"
        | "interrupted"
        | "turn_budget_exhausted"
        | "tool_budget_exhausted"
        | "structured_output_failed"
        | "acceptance_failed"
        | "invalid_request"
        | "unavailable_context";
    error?: string;
    runId?: string;
    childIndex?: number;
    agent?: string;
    model?: string;
    exitCode?: number;
    output?: string;
    outputPath?: string;
    sessionFile?: string;
    acceptance?: {
        status:
            | "pending"
            | "not-required"
            | "claimed"
            | "attested"
            | "checked"
            | "verified"
            | "review-required"
            | "reviewed"
            | "accepted"
            | "rejected";
        evidenceStatus:
            | "pending"
            | "not-required"
            | "claimed"
            | "attested"
            | "checked"
            | "verified"
            | "rejected";
        explicit: boolean;
    };
    turns?: number;
    toolCount?: number;
    durationMs?: number;
    tokens?: number;
    warnings?: string[];
}

export interface DirectEvidence {
    changedFiles: readonly string[];
    tests: readonly string[];
    commands: readonly string[];
    validationOutput: string;
    residualRisks: readonly string[];
}

export const RECOVERY_STAGES = [
    "worker",
    "correction",
    "combined",
    "spec",
    "quality",
] as const;
export type RecoveryStage = (typeof RECOVERY_STAGES)[number];

function isRecoveryReviewStage(
    stage: RecoveryStage,
): stage is Extract<RecoveryStage, Review["stage"]> {
    return stage === "combined" || stage === "spec" || stage === "quality";
}

export interface RecoveryAttestation {
    action: "attest";
    confirmation: true;
    authorizedBy: string;
    requestId: string;
    stage: RecoveryStage;
}

export interface RecoveryChoice {
    action: "attest";
    confirmation: true;
    authorizedBy: string;
    requestId: string;
    stage: RecoveryStage;
    priorReason: "uncertain_foreground_delegation";
    evidence: DirectEvidence;
    digest: string;
}

export function recoveryAttestationDigest(
    attestation: RecoveryAttestation,
    evidence: DirectEvidence,
): string {
    const canonicalBinding = JSON.stringify({
        action: attestation.action,
        confirmation: attestation.confirmation,
        authorizedBy: attestation.authorizedBy,
        requestId: attestation.requestId,
        stage: attestation.stage,
        evidence: {
            changedFiles: [...evidence.changedFiles],
            tests: [...evidence.tests],
            commands: [...evidence.commands],
            validationOutput: evidence.validationOutput,
            residualRisks: [...evidence.residualRisks],
        },
    });
    return createHash("sha256").update(canonicalBinding).digest("hex");
}

export interface PlannedDelegation {
    idempotencyKey: string;
    taskId: string;
    requestId: string;
    stage: string;
    attempt: number;
    plannedAt: string;
}

export interface IsolatedWorkspace {
    readonly mode: "isolated";
    readonly sourceRoot: string;
    readonly baseCommit: string;
    readonly worktreePath: string;
    readonly delivery: {
        readonly status: "pending" | "applied";
        readonly patchDigest?: string;
        readonly appliedAt?: string;
    };
}

export interface RunSnapshot {
    runId: string;
    revision: number;
    state: RunState;
    tasks: Record<string, TaskSnapshot>;
    consumedIdempotencyKeys: string[];
    plannedDelegations: Record<string, PlannedDelegation>;
    workspace?: IsolatedWorkspace;
    terminalReason?: string;
    integrationReview?: {
        launches: number;
        activeRequestId?: string;
        plannedDelegation?: PlannedDelegation;
        terminalResponse?: DelegationTerminalResponse;
        review?: Review;
        applied?: boolean;
    };
    cancellation?: {
        requestedAt: string;
        requestIds: string[];
    };
}

export type RunEvent =
    | {
          type: "run-transition";
          expectedRevision: number;
          to: RunState;
      }
    | {
          type: "task-transition";
          expectedRevision: number;
          taskId: string;
          to: TaskState;
      }
    | ({
          type: "delegation-planned";
          expectedRevision: number;
      } & PlannedDelegation)
    | {
          type: "delegation-response-recorded";
          expectedRevision: number;
          taskId: string;
          response: DelegationTerminalResponse;
      }
    | {
          type: "cancellation-requested";
          expectedRevision: number;
          requestedAt: string;
          requestIds: string[];
      }
    | {
          type: "review-recorded";
          expectedRevision: number;
          taskId: string;
          requestId: string;
          review: Review;
      }
    | {
          type: "review-applied";
          expectedRevision: number;
          taskId: string;
          requestId: string;
      }
    | {
          type: "delegation-response-applied";
          expectedRevision: number;
          taskId: string;
          requestId: string;
      }
    | {
          type: "integration-delegation-planned";
          expectedRevision: number;
          delegation: PlannedDelegation;
      }
    | {
          type: "integration-delegation-response-recorded";
          expectedRevision: number;
          response: DelegationTerminalResponse;
      }
    | {
          type: "integration-review-recorded";
          expectedRevision: number;
          requestId: string;
          review: Review;
      }
    | {
          type: "integration-review-applied";
          expectedRevision: number;
          requestId: string;
      }
    | {
          type: "direct-evidence-recorded";
          expectedRevision: number;
          taskId: string;
          evidence: DirectEvidence;
      }
    | {
          type: "recovery-attestation-applied";
          expectedRevision: number;
          taskId: string;
          profile: Profile;
          choice: RecoveryChoice;
      }
    | {
          type: "terminal-reason-recorded";
          expectedRevision: number;
          taskId: string;
          reason: string;
      }
    | {
          type: "run-terminal-reason-recorded";
          expectedRevision: number;
          reason: string;
      }
    | {
          type: "workspace-delivery-applied";
          expectedRevision: number;
          patchDigest: string;
          appliedAt: string;
      };

const RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
    draft: ["assessed"],
    assessed: ["awaiting_approval"],
    awaiting_approval: ["approved"],
    approved: ["running"],
    running: ["needs_input", "failed", "cancelled", "completed"],
    needs_input: [],
    failed: [],
    cancelled: [],
    completed: [],
};

const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
    pending: ["implementing", "awaiting_direct_agent"],
    awaiting_direct_agent: ["verified", "needs_input", "failed", "cancelled"],
    implementing: ["reviewing", "needs_input", "failed", "cancelled"],
    reviewing: ["fixing", "verified", "needs_input", "failed", "cancelled"],
    fixing: ["reviewing", "needs_input", "failed", "cancelled"],
    verified: [],
    needs_input: [],
    failed: [],
    cancelled: [],
};

export function transition(
    snapshot: RunSnapshot,
    event: RunEvent,
): RunSnapshot {
    if (event.type === "delegation-response-recorded") {
        const existing =
            snapshot.tasks[event.taskId]?.terminalResponses?.[
                event.response.requestId
            ];
        if (existing) {
            if (JSON.stringify(existing) !== JSON.stringify(event.response)) {
                throw new Error(
                    `Terminal response conflict: ${event.response.requestId}.`,
                );
            }
            return snapshot;
        }
    }
    if (event.type === "cancellation-requested" && snapshot.cancellation) {
        if (
            snapshot.cancellation.requestedAt !== event.requestedAt ||
            JSON.stringify(snapshot.cancellation.requestIds) !==
                JSON.stringify(event.requestIds)
        ) {
            throw new Error("Cancellation intent conflict.");
        }
        return snapshot;
    }
    if (event.type === "review-recorded") {
        const existing =
            snapshot.tasks[event.taskId]?.reviewResults?.[event.requestId];
        if (existing) {
            if (JSON.stringify(existing) !== JSON.stringify(event.review)) {
                throw new Error(`Review result conflict: ${event.requestId}.`);
            }
            return snapshot;
        }
    }
    if (
        event.type === "review-applied" &&
        snapshot.tasks[event.taskId]?.appliedReviewRequestIds?.includes(
            event.requestId,
        )
    ) {
        return snapshot;
    }
    if (
        event.type === "delegation-response-applied" &&
        snapshot.tasks[event.taskId]?.appliedResponseRequestIds?.includes(
            event.requestId,
        )
    ) {
        return snapshot;
    }
    if (
        event.type === "integration-delegation-planned" &&
        snapshot.integrationReview?.plannedDelegation
    ) {
        const existing = snapshot.integrationReview.plannedDelegation;
        if (JSON.stringify(existing) !== JSON.stringify(event.delegation)) {
            throw new Error("Integration delegation plan conflict.");
        }
        return snapshot;
    }
    if (
        event.type === "integration-delegation-response-recorded" &&
        snapshot.integrationReview?.terminalResponse
    ) {
        if (
            JSON.stringify(snapshot.integrationReview.terminalResponse) !==
            JSON.stringify(event.response)
        ) {
            throw new Error("Integration terminal response conflict.");
        }
        return snapshot;
    }
    if (
        event.type === "integration-review-recorded" &&
        snapshot.integrationReview?.review
    ) {
        if (
            JSON.stringify(snapshot.integrationReview.review) !==
            JSON.stringify(event.review)
        ) {
            throw new Error("Integration review conflict.");
        }
        return snapshot;
    }
    if (
        event.type === "integration-review-applied" &&
        snapshot.integrationReview?.applied
    ) {
        return snapshot;
    }
    if (
        event.type === "run-terminal-reason-recorded" &&
        snapshot.terminalReason === event.reason
    ) {
        return snapshot;
    }
    if (event.type === "workspace-delivery-applied") {
        const delivery = snapshot.workspace?.delivery;
        if (delivery?.status === "applied") {
            if (delivery.patchDigest !== event.patchDigest) {
                throw new Error("SDD workspace delivery digest conflict.");
            }
            return snapshot;
        }
    }
    if (
        event.type === "recovery-attestation-applied" &&
        snapshot.tasks[event.taskId]?.recoveryChoice
    ) {
        const existing = snapshot.tasks[event.taskId]?.recoveryChoice;
        if (JSON.stringify(existing) !== JSON.stringify(event.choice)) {
            throw new Error(`Recovery attestation conflict: ${event.taskId}.`);
        }
        return snapshot;
    }
    if (
        event.type === "delegation-planned" &&
        snapshot.consumedIdempotencyKeys.includes(event.idempotencyKey)
    ) {
        const planned = snapshot.plannedDelegations[event.idempotencyKey];
        if (
            !planned ||
            planned.idempotencyKey !== event.idempotencyKey ||
            planned.taskId !== event.taskId ||
            planned.requestId !== event.requestId ||
            planned.stage !== event.stage ||
            planned.attempt !== event.attempt ||
            planned.plannedAt !== event.plannedAt
        ) {
            throw new Error(`Idempotency conflict: ${event.idempotencyKey}.`);
        }
        return snapshot;
    }
    if (event.expectedRevision !== snapshot.revision) {
        throw new Error(
            `Stale revision: expected ${event.expectedRevision}, current ${snapshot.revision}.`,
        );
    }

    if (event.type === "run-transition") {
        if (!RUN_TRANSITIONS[snapshot.state].includes(event.to)) {
            throw new Error(
                `Illegal run transition: ${snapshot.state} -> ${event.to}.`,
            );
        }
        return {
            ...snapshot,
            revision: snapshot.revision + 1,
            state: event.to,
        };
    }

    if (event.type === "run-terminal-reason-recorded") {
        return {
            ...snapshot,
            revision: snapshot.revision + 1,
            terminalReason: event.reason,
        };
    }

    if (event.type === "workspace-delivery-applied") {
        if (snapshot.state !== "completed") {
            throw new Error("SDD workspace delivery requires a completed run.");
        }
        if (
            !snapshot.workspace ||
            snapshot.workspace.delivery.status !== "pending"
        ) {
            throw new Error("SDD workspace delivery is not pending.");
        }
        return {
            ...snapshot,
            revision: snapshot.revision + 1,
            workspace: {
                ...snapshot.workspace,
                delivery: {
                    status: "applied",
                    patchDigest: event.patchDigest,
                    appliedAt: event.appliedAt,
                },
            },
        };
    }

    if (event.type === "review-applied") {
        const task = snapshot.tasks[event.taskId];
        if (!task) throw new Error(`Unknown task: ${event.taskId}.`);
        if (!task.reviewResults?.[event.requestId]) {
            throw new Error(`Unknown review result: ${event.requestId}.`);
        }
        return {
            ...snapshot,
            revision: snapshot.revision + 1,
            tasks: {
                ...snapshot.tasks,
                [event.taskId]: {
                    ...task,
                    appliedReviewRequestIds: [
                        ...(task.appliedReviewRequestIds ?? []),
                        event.requestId,
                    ],
                },
            },
        };
    }

    if (event.type === "delegation-response-applied") {
        const task = snapshot.tasks[event.taskId];
        if (!task) throw new Error(`Unknown task: ${event.taskId}.`);
        if (!task.terminalResponses?.[event.requestId]) {
            throw new Error(`Unknown terminal response: ${event.requestId}.`);
        }
        return {
            ...snapshot,
            revision: snapshot.revision + 1,
            tasks: {
                ...snapshot.tasks,
                [event.taskId]: {
                    ...task,
                    appliedResponseRequestIds: [
                        ...(task.appliedResponseRequestIds ?? []),
                        event.requestId,
                    ],
                },
            },
        };
    }

    if (event.type === "integration-delegation-planned") {
        if (snapshot.integrationReview?.launches) {
            throw new Error("Integration review launch ceiling reached.");
        }
        return {
            ...snapshot,
            revision: snapshot.revision + 1,
            integrationReview: {
                launches: 1,
                activeRequestId: event.delegation.requestId,
                plannedDelegation: event.delegation,
            },
        };
    }

    if (event.type === "integration-delegation-response-recorded") {
        const integration = snapshot.integrationReview;
        if (
            !integration?.plannedDelegation ||
            integration.activeRequestId !== event.response.requestId ||
            integration.plannedDelegation.requestId !== event.response.requestId
        ) {
            throw new Error(
                `Uncorrelated integration terminal response: ${event.response.requestId}.`,
            );
        }
        return {
            ...snapshot,
            revision: snapshot.revision + 1,
            integrationReview: {
                ...integration,
                activeRequestId: undefined,
                terminalResponse: event.response,
            },
        };
    }

    if (event.type === "integration-review-recorded") {
        const integration = snapshot.integrationReview;
        if (
            !integration?.terminalResponse ||
            integration.terminalResponse.requestId !== event.requestId ||
            !event.review.taskId.startsWith("manifest:")
        ) {
            throw new Error(`Integration review mismatch: ${event.requestId}.`);
        }
        return {
            ...snapshot,
            revision: snapshot.revision + 1,
            integrationReview: { ...integration, review: event.review },
        };
    }

    if (event.type === "integration-review-applied") {
        const integration = snapshot.integrationReview;
        if (
            !integration?.review ||
            integration.terminalResponse?.requestId !== event.requestId
        ) {
            throw new Error(`Unknown integration review: ${event.requestId}.`);
        }
        return {
            ...snapshot,
            revision: snapshot.revision + 1,
            integrationReview: { ...integration, applied: true },
        };
    }

    if (event.type === "task-transition") {
        const task = snapshot.tasks[event.taskId];
        if (!task) throw new Error(`Unknown task: ${event.taskId}.`);
        if (!TASK_TRANSITIONS[task.state].includes(event.to)) {
            throw new Error(
                `Illegal task transition: ${task.state} -> ${event.to}.`,
            );
        }
        return {
            ...snapshot,
            revision: snapshot.revision + 1,
            tasks: {
                ...snapshot.tasks,
                [event.taskId]: { ...task, state: event.to },
            },
        };
    }

    if (event.type === "delegation-response-recorded") {
        const task = snapshot.tasks[event.taskId];
        if (!task) throw new Error(`Unknown task: ${event.taskId}.`);
        const planned = Object.values(snapshot.plannedDelegations).find(
            (delegation) =>
                delegation.taskId === event.taskId &&
                delegation.requestId === event.response.requestId,
        );
        if (!planned || task.activeRequestId !== event.response.requestId) {
            throw new Error(
                `Uncorrelated terminal response: ${event.response.requestId}.`,
            );
        }
        return {
            ...snapshot,
            revision: snapshot.revision + 1,
            tasks: {
                ...snapshot.tasks,
                [event.taskId]: {
                    ...task,
                    activeRequestId: undefined,
                    terminalResponses: {
                        ...task.terminalResponses,
                        [event.response.requestId]: event.response,
                    },
                },
            },
        };
    }

    if (event.type === "cancellation-requested") {
        return {
            ...snapshot,
            revision: snapshot.revision + 1,
            cancellation: {
                requestedAt: event.requestedAt,
                requestIds: [...event.requestIds],
            },
        };
    }

    if (event.type === "review-recorded") {
        const task = snapshot.tasks[event.taskId];
        if (!task) throw new Error(`Unknown task: ${event.taskId}.`);
        if (event.review.taskId !== event.taskId) {
            throw new Error(`Review task mismatch: ${event.requestId}.`);
        }
        return {
            ...snapshot,
            revision: snapshot.revision + 1,
            tasks: {
                ...snapshot.tasks,
                [event.taskId]: {
                    ...task,
                    reviewResults: {
                        ...task.reviewResults,
                        [event.requestId]: event.review,
                    },
                },
            },
        };
    }

    if (event.type === "direct-evidence-recorded") {
        const task = snapshot.tasks[event.taskId];
        if (!task) throw new Error(`Unknown task: ${event.taskId}.`);
        return {
            ...snapshot,
            revision: snapshot.revision + 1,
            tasks: {
                ...snapshot.tasks,
                [event.taskId]: { ...task, directEvidence: event.evidence },
            },
        };
    }

    if (event.type === "recovery-attestation-applied") {
        const task = snapshot.tasks[event.taskId];
        if (!task) throw new Error(`Unknown task: ${event.taskId}.`);
        if (
            snapshot.state !== "needs_input" ||
            task.state !== "needs_input" ||
            task.terminalReason !== event.choice.priorReason
        ) {
            throw new Error(
                `Task ${event.taskId} is not awaiting uncertain-work attestation.`,
            );
        }
        const planned = snapshot.plannedDelegations[event.choice.requestId];
        if (
            !planned ||
            planned.taskId !== event.taskId ||
            planned.requestId !== event.choice.requestId ||
            planned.stage !== event.choice.stage ||
            task.activeRequestId !== event.choice.requestId
        ) {
            throw new Error(
                `Recovery attestation does not match the uncertain delegation for ${event.taskId}.`,
            );
        }
        if (
            event.choice.digest !==
            recoveryAttestationDigest(event.choice, event.choice.evidence)
        ) {
            throw new Error(
                `Recovery attestation digest mismatch: ${event.taskId}.`,
            );
        }
        const validStage =
            (event.profile === "light" && event.choice.stage === "worker") ||
            (event.profile === "standard" &&
                (event.choice.stage === "worker" ||
                    event.choice.stage === "correction" ||
                    event.choice.stage === "combined")) ||
            (event.profile === "critical" &&
                (event.choice.stage === "worker" ||
                    event.choice.stage === "correction" ||
                    event.choice.stage === "spec" ||
                    event.choice.stage === "quality"));
        if (!validStage) {
            throw new Error(
                `Recovery stage ${event.choice.stage} is invalid for ${event.profile}.`,
            );
        }
        const taskState: TaskState =
            event.choice.stage === "combined" ||
            event.choice.stage === "quality" ||
            event.profile === "light"
                ? "verified"
                : "reviewing";
        const recoveryEvidence = [
            `Recovery attested by ${event.choice.authorizedBy}; binding ${event.choice.digest}.`,
        ];
        let review: Review | undefined;
        if (isRecoveryReviewStage(event.choice.stage)) {
            review = {
                version: 1,
                taskId: event.taskId,
                stage: event.choice.stage,
                verdict: "pass",
                findings: [],
                evidence: recoveryEvidence,
            };
        }
        const response: DelegationTerminalResponse = {
            version: 1,
            requestId: event.choice.requestId,
            status: "completed",
            output: review
                ? JSON.stringify(review)
                : `Recovery attested by ${event.choice.authorizedBy}; binding ${event.choice.digest}.`,
            acceptance: {
                status: "accepted",
                evidenceStatus: "verified",
                explicit: true,
            },
        };
        return {
            ...snapshot,
            revision: snapshot.revision + 1,
            state: "running",
            terminalReason: undefined,
            tasks: {
                ...snapshot.tasks,
                [event.taskId]: {
                    ...task,
                    state: taskState,
                    activeRequestId: undefined,
                    terminalReason: undefined,
                    recoveryChoice: event.choice,
                    terminalResponses: {
                        ...task.terminalResponses,
                        [event.choice.requestId]: response,
                    },
                    appliedResponseRequestIds: [
                        ...new Set([
                            ...(task.appliedResponseRequestIds ?? []),
                            event.choice.requestId,
                        ]),
                    ],
                    ...(review
                        ? {
                              reviewResults: {
                                  ...task.reviewResults,
                                  [event.choice.requestId]: review,
                              },
                              appliedReviewRequestIds: [
                                  ...new Set([
                                      ...(task.appliedReviewRequestIds ?? []),
                                      event.choice.requestId,
                                  ]),
                              ],
                          }
                        : {}),
                },
            },
        };
    }

    if (event.type === "terminal-reason-recorded") {
        const task = snapshot.tasks[event.taskId];
        if (!task) throw new Error(`Unknown task: ${event.taskId}.`);
        return {
            ...snapshot,
            revision: snapshot.revision + 1,
            tasks: {
                ...snapshot.tasks,
                [event.taskId]: { ...task, terminalReason: event.reason },
            },
        };
    }

    const task = snapshot.tasks[event.taskId];
    if (!task) throw new Error(`Unknown task: ${event.taskId}.`);
    if (task.launches >= task.maxLaunches) {
        throw new Error(
            `Task ${event.taskId} launch ceiling reached: ${task.launches}/${task.maxLaunches}.`,
        );
    }
    const delegation: PlannedDelegation = {
        idempotencyKey: event.idempotencyKey,
        taskId: event.taskId,
        requestId: event.requestId,
        stage: event.stage,
        attempt: event.attempt,
        plannedAt: event.plannedAt,
    };
    return {
        ...snapshot,
        revision: snapshot.revision + 1,
        tasks: {
            ...snapshot.tasks,
            [event.taskId]: {
                ...task,
                launches: task.launches + 1,
                activeRequestId: event.requestId,
            },
        },
        consumedIdempotencyKeys: [
            ...snapshot.consumedIdempotencyKeys,
            event.idempotencyKey,
        ],
        plannedDelegations: {
            ...snapshot.plannedDelegations,
            [event.idempotencyKey]: delegation,
        },
    };
}
