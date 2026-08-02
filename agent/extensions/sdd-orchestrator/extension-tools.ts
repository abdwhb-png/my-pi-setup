import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
    AgentToolUpdateCallback,
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
    resolveRuntimePath,
    toPortableHomePath,
} from "../_shared/home-path.ts";
import type { SddActivityStore } from "./activity-store.ts";
import {
    openSddLive,
    renderSddActivityWidget,
    type SddActivitySource,
} from "./activity-ui.ts";
import {
    AssessmentCache,
    assessmentCacheKey,
    type AssessmentProgressHooks,
    type AssessmentProgressUpdate,
} from "./assessment-cache.ts";
import { loadSddConfig, type SddConfig } from "./config.ts";
import type { DelegationClient } from "./delegation-client.ts";
import {
    applyApproval,
    approvalDecisionDigest,
    compileManifest,
    type ApprovedManifest,
    type DraftManifest,
    type ManifestDecision,
} from "./manifest.ts";
import { parseSddPlan } from "./plan-parser.ts";
import { buildAssessmentRequest, parseAssessmentResponse } from "./prompts.ts";
import {
    profileSeverity,
    taskStateGlyph,
    verdictColor,
} from "./review-render.ts";
import {
    estimateQualitativeDuration,
    type ManifestReviewOutcome,
    openManifestReview,
    type ReviewProgressStorage,
} from "./review-ui.ts";
import {
    RECOVERY_STAGES,
    type DirectEvidence,
    type IsolatedWorkspace,
    type RecoveryAttestation,
    type RunSnapshot,
    type TaskSnapshot,
    type TaskState,
} from "./state-machine.ts";
import {
    ReviewProgressConflictError,
    type ManifestApprovalResult,
    type SddStore,
} from "./store.ts";
import { PROFILES, type Profile } from "./types.ts";
import type { SddWorkflow } from "./workflow.ts";
import type { SddWorkspaceDelivery } from "./workspace.ts";

type ExtensionStore = Pick<
    SddStore,
    | "create"
    | "load"
    | "list"
    | "loadManifest"
    | "createManifest"
    | "approveManifest"
    | "listManifests"
    | "loadReviewProgress"
    | "saveReviewProgress"
    | "deleteReviewProgress"
>;
type ExtensionDelegation = Pick<DelegationClient, "run" | "dispose">;
type ExtensionWorkflow = Pick<
    SddWorkflow,
    "run" | "cancel" | "completeDirect" | "reconcile" | "recordWorkspaceApplied"
>;

export interface SddWorkspacePreflight {
    prepare(
        runId: string,
        sourceCwd: string,
    ): IsolatedWorkspace | Promise<IsolatedWorkspace>;
    apply(
        workspace: IsolatedWorkspace,
        sourceCwd: string,
    ): SddWorkspaceDelivery | Promise<SddWorkspaceDelivery>;
}

export interface SddRuntime {
    readonly agentDir: string;
    readonly store: ExtensionStore;
    readonly delegation: ExtensionDelegation;
    readonly workflow: ExtensionWorkflow;
    readonly workspace?: SddWorkspacePreflight;
    readonly activity?: SddActivityStore;
    readonly config?: (cwd: string) => SddConfig;
    readonly now?: () => string;
    readonly openReview?: (
        ctx: ExtensionContext,
        draft: DraftManifest,
        progressStorage: ReviewProgressStorage,
    ) => Promise<ManifestReviewOutcome>;
    readonly openLive?: (
        ctx: ExtensionContext,
        source: SddActivitySource,
        runId: string,
    ) => Promise<void>;
}

const LIVE_WIDGET_ID = "sdd-orchestrator-live";
const TERMINAL_WIDGET_LINGER_MS = 5_000;

interface SddLiveUiCoordinator {
    track(
        ctx: ExtensionContext,
        manifest: ApprovedManifest,
        snapshot: RunSnapshot,
        live: boolean,
    ): void;
    dispose(ctx?: ExtensionContext): void;
}

function createLiveUiCoordinator(runtime: SddRuntime): SddLiveUiCoordinator {
    const activity = runtime.activity;
    let currentContext: ExtensionContext | undefined;
    const terminalTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const syncWidget = (): void => {
        const ctx = currentContext;
        if (!activity || !ctx || ctx.mode !== "tui") return;
        const runs = activity.getLiveRuns();
        if (runs.length === 0) {
            ctx.ui.setWidget?.(LIVE_WIDGET_ID, undefined);
            return;
        }
        ctx.ui.setWidget?.(
            LIVE_WIDGET_ID,
            (_tui, theme) => ({
                render(width: number) {
                    const visibleRuns = activity.getLiveRuns();
                    const selected =
                        visibleRuns.find((run) => !run.presentationTerminal) ??
                        visibleRuns.at(-1);
                    return selected
                        ? renderSddActivityWidget(
                              selected,
                              width,
                              theme,
                              Date.now(),
                          )
                        : [];
                },
                invalidate() {},
            }),
            { placement: "belowEditor" },
        );

        for (const run of runs) {
            const existing = terminalTimers.get(run.runId);
            if (!run.presentationTerminal) {
                if (existing) clearTimeout(existing);
                terminalTimers.delete(run.runId);
                continue;
            }
            if (existing) continue;
            const timer = setTimeout(() => {
                terminalTimers.delete(run.runId);
                activity.setLive(run.runId, false);
            }, TERMINAL_WIDGET_LINGER_MS);
            timer.unref?.();
            terminalTimers.set(run.runId, timer);
        }
    };
    const unsubscribe = activity?.subscribe(syncWidget);

    return {
        track(ctx, manifest, snapshot, live) {
            if (!activity) return;
            if (ctx.mode === "tui") currentContext = ctx;
            activity.trackRun(manifest, snapshot, { live });
        },
        dispose(ctx) {
            for (const timer of terminalTimers.values()) clearTimeout(timer);
            terminalTimers.clear();
            unsubscribe?.();
            const target = ctx ?? currentContext;
            if (target?.mode === "tui") {
                target.ui.setWidget?.(LIVE_WIDGET_ID, undefined);
            }
            currentContext = undefined;
        },
    };
}

export function createReviewProgressStorage(
    store: Pick<SddStore, "loadReviewProgress" | "saveReviewProgress">,
): ReviewProgressStorage {
    return {
        loadReviewProgress: (manifestId) =>
            store.loadReviewProgress(manifestId),
        saveReviewProgress: (manifestId, expectedRevision, state) => {
            try {
                const persisted = store.saveReviewProgress(
                    manifestId,
                    expectedRevision,
                    state,
                );
                return { type: "ok", revision: persisted.revision };
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                if (error instanceof ReviewProgressConflictError) {
                    try {
                        const current = store.loadReviewProgress(manifestId);
                        if (current) return { type: "conflict", current };
                    } catch (reloadError) {
                        return {
                            type: "error",
                            error:
                                reloadError instanceof Error
                                    ? reloadError.message
                                    : String(reloadError),
                        };
                    }
                }
                return { type: "error", error: message };
            }
        },
    };
}

export interface LegacyQueuedRun {
    readonly runId: string;
    readonly status: "legacy_queued";
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
const ApplySchema = Type.Object(
    { runId: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
);
const RecoveryAttestationSchema = Type.Object(
    {
        action: Type.Literal("attest"),
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
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLegacyRun(path: string): LegacyQueuedRun | null {
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return null;
    }
    if (
        !isRecord(value) ||
        typeof value.runId !== "string" ||
        !value.runId ||
        typeof value.planPath !== "string" ||
        !value.planPath ||
        (value.planTitle !== undefined &&
            typeof value.planTitle !== "string") ||
        (value.queuedAt !== undefined && typeof value.queuedAt !== "string")
    ) {
        return null;
    }
    return {
        runId: value.runId,
        status: "legacy_queued",
        planPath: value.planPath,
        ...(value.planTitle === undefined
            ? {}
            : { planTitle: value.planTitle }),
        ...(value.queuedAt === undefined ? {} : { queuedAt: value.queuedAt }),
    };
}

export function collectRunStatuses(
    store: Pick<SddStore, "list">,
    agentDir: string,
): ObservableRun[] {
    const snapshots = store.list();
    const known = new Set(snapshots.map((snapshot) => snapshot.runId));
    const queueDir = join(agentDir, ".sdd", "queue");
    if (!existsSync(queueDir)) return snapshots;
    const legacy: LegacyQueuedRun[] = [];
    for (const name of readdirSync(queueDir)
        .filter((entry) => entry.endsWith(".json"))
        .toSorted()) {
        const entry = readLegacyRun(join(queueDir, name));
        if (!entry || known.has(entry.runId)) continue;
        known.add(entry.runId);
        legacy.push(entry);
    }
    return [...snapshots, ...legacy];
}

function textResult(text: string, details: unknown) {
    return { content: [{ type: "text" as const, text }], details };
}

function requireDraft(
    store: ExtensionStore,
    manifestId: string,
): DraftManifest {
    const manifest = store.loadManifest(manifestId);
    if (!manifest) throw new Error(`Manifest not found: ${manifestId}.`);
    if (manifest.state !== "awaiting_approval") {
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
        snapshot.state === "completed" ||
        snapshot.state === "failed" ||
        snapshot.state === "cancelled" ||
        snapshot.state === "needs_input"
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
    if (task.state === "pending") return true;
    if (
        task.state !== "reviewing" &&
        task.state !== "fixing" &&
        task.state !== "verified"
    ) {
        return false;
    }
    if (task.state === "verified" && task.directEvidence) return true;
    return (task.appliedResponseRequestIds?.length ?? 0) > 0;
}

export function shouldContinueAfterReconcile(snapshot: RunSnapshot): boolean {
    return (
        snapshot.state === "running" &&
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
                    entry.type === "custom" &&
                    entry.customType === "sdd:manifest-approved" &&
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
    pi.appendEntry("sdd:manifest-approved", {
        manifestId: manifest.manifestId,
        runId: manifest.manifestId,
        approvalDigest: manifest.approvalDigest,
    });
    recordedApprovalEntries.add(manifest.approvalDigest);
}

function initialSnapshot(
    runId: string,
    manifest: ApprovedManifest,
    workspace?: IsolatedWorkspace,
): RunSnapshot {
    return {
        runId,
        revision: 0,
        state: "approved",
        tasks: Object.fromEntries(
            manifest.tasks.map((task) => [
                task.id,
                {
                    id: task.id,
                    state: "pending" as const,
                    launches: 0,
                    maxLaunches: task.budgets.maxLaunches,
                },
            ]),
        ),
        consumedIdempotencyKeys: [],
        plannedDelegations: {},
        ...(workspace ? { workspace } : {}),
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
        join(cwd, ".pi", "agents", `${agent}.md`),
        join(runtime.agentDir, "agents", `${agent}.md`),
    ]) {
        if (existsSync(path)) return readFileSync(path, "utf8");
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
    onProgress?: (
        ctx: ExtensionContext,
        update: AssessmentProgressUpdate,
    ) => void,
) {
    const plan = parseSddPlan(planContent);
    const digest = createHash("sha256").update(planContent).digest("hex");
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
            let originalOutput = "";
            let validationError = "";
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
                // Per-attempt progress hooks: re-bind for each requestId so the
                // status line reflects the current attempt number.
                const progressHooks: AssessmentProgressHooks = {
                    onStarted: (event) =>
                        onProgress?.(ctx, {
                            requestId: event.requestId,
                            currentTool: "starting",
                        }),
                    onUpdate: (update) =>
                        onProgress?.(ctx, {
                            ...update,
                            currentTool: update.currentTool,
                        }),
                };
                // oxlint-disable-next-line no-await-in-loop -- a repair uses the previous validation failure and must remain sequential.
                const response = await runtime.delegation.run(request, {
                    signal,
                    deadlineMs: config.timeoutsMs.assessor,
                    onStarted: progressHooks.onStarted,
                    onUpdate: progressHooks.onUpdate,
                });
                if (
                    response.status !== "completed" ||
                    response.output === undefined
                ) {
                    throw new Error(
                        `Assessment delegation failed: ${response.status}${response.error ? `: ${response.error}` : ""}.`,
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
            throw new Error("Assessment retry ceiling exhausted.");
        },
        onProgress
            ? {
                  onUpdate: (update) => onProgress(ctx, update),
              }
            : undefined,
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
    liveUi: SddLiveUiCoordinator,
    signal?: AbortSignal,
) {
    let approved: ApprovedManifest;
    let snapshot: RunSnapshot;
    let approval: ManifestApprovalResult;
    let workspace: IsolatedWorkspace | undefined;
    if (manifest.state === "approved") {
        if (
            approvalDecisionDigest(manifest.decision) !==
            approvalDecisionDigest(decision)
        ) {
            throw new Error(
                `Manifest approval conflict: ${manifest.manifestId}.`,
            );
        }
        const {
            decision: _decision,
            approvalDigest: _approvalDigest,
            ...approvedFields
        } = manifest;
        const expectedDraft: DraftManifest = {
            ...approvedFields,
            state: "awaiting_approval",
        };
        approval = runtime.store.approveManifest(
            expectedDraft,
            manifest,
            requireSnapshot(runtime.store, manifest.manifestId),
        );
        approved = approval.manifest;
        snapshot = approval.snapshot;
    } else {
        const currentPlanContent = readFileSync(
            resolveRuntimePath(manifest.planPath, ctx.cwd),
            "utf8",
        );
        const candidate = applyApproval(manifest, decision, currentPlanContent);
        const hasDirectTask = candidate.tasks.some(
            (task) => task.effectiveProfile === "direct",
        );
        const hasDelegatedTask = candidate.tasks.some(
            (task) => task.effectiveProfile !== "direct",
        );
        if (hasDirectTask && hasDelegatedTask) {
            throw new Error(
                "SDD approval cannot mix Direct and delegated tasks. Use Direct for every task or select a delegated profile for every task.",
            );
        }
        if (hasDelegatedTask) {
            if (!runtime.workspace) {
                throw new Error(
                    "SDD isolated workspace support is unavailable.",
                );
            }
            workspace = await runtime.workspace.prepare(
                candidate.manifestId,
                ctx.cwd,
            );
        }
        approval = runtime.store.approveManifest(
            manifest,
            candidate,
            initialSnapshot(candidate.manifestId, candidate, workspace),
        );
        approved = approval.manifest;
        snapshot = approval.snapshot;
    }
    const reviewCleanupError = approval.reviewCleanupPending
        ? (approval.reviewCleanupError ?? "unspecified cleanup error")
        : undefined;
    if (reviewCleanupError && ctx.hasUI) {
        ctx.ui.notify(
            `SDD review progress cleanup is pending: ${reviewCleanupError}`,
            "warning",
        );
    }
    const runId = approved.manifestId;
    ensureApprovalEntry(pi, ctx, approved, recordedApprovalEntries);
    if (!isTerminalSnapshot(snapshot)) {
        liveUi.track(ctx, approved, snapshot, true);
        if (ctx.mode === "tui") {
            ctx.ui.setWorkingMessage("running SDD workflow");
        }
        try {
            snapshot = await runtime.workflow.run(runId, ctx, signal);
            runtime.activity?.onSnapshot(snapshot);
        } finally {
            if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
        }
    }
    const direct = approved.tasks.some(
        (task) => task.effectiveProfile === "direct",
    );
    const terminalSummary = isTerminalSnapshot(snapshot)
        ? renderRunObservation(
              observeRun(approved, snapshot, now(runtime)),
              ctx.mode === "tui" ? ctx.ui.theme : undefined,
          )
        : undefined;
    return textResult(
        [
            terminalSummary ?? `SDD run ${runId} started.`,
            ...(terminalSummary
                ? []
                : [
                      direct
                          ? `Direct tasks require sdd_direct_complete({ runId: "${runId}", ... }).`
                          : "The approved workflow has started.",
                  ]),
            ...(reviewCleanupError
                ? [
                      `Review progress cleanup pending (reviewCleanupPending: true, reviewCleanupError: ${reviewCleanupError}).`,
                  ]
                : []),
        ].join("\n"),
        {
            snapshot,
            manifest: approved,
            reviewCleanupPending: approval.reviewCleanupPending,
            ...(reviewCleanupError ? { reviewCleanupError } : {}),
        },
    );
}

function formatAssessStatusLine(
    attempt: number,
    update: AssessmentProgressUpdate,
): string {
    const tool = update.currentTool ?? "working";
    const elapsed =
        update.durationMs !== undefined
            ? ` · ${(update.durationMs / 1000).toFixed(1)}s`
            : "";
    return `assessing · attempt ${attempt} · ${tool}${elapsed}`;
}

function extractAttemptNumber(requestId: string): number {
    const match = requestId.match(/:(\d+)$/);
    return match ? Number(match[1]) : 1;
}

function partialLine(text: string): {
    content: Array<{ type: "text"; text: string }>;
    details: undefined;
} {
    return { content: [{ type: "text", text }], details: undefined };
}

function renderDraftSummary(draft: DraftManifest): string {
    const lines: string[] = [
        `SDD manifest prepared: ${draft.planTitle}`,
        `  source: ${draft.sourceDigest.slice(0, 12)}  assessment: ${draft.assessmentDigest.slice(0, 12)}`,
        `  globalProfile: ${draft.globalProfile}  parallel: ${draft.parallelismEnabled}  integration: ${draft.finalIntegrationReview}`,
        `  maximumLaunches: ${draft.maximumLaunches}  tasks: ${draft.tasks.length}`,
        "Tasks:",
    ];
    for (const task of draft.tasks) {
        lines.push(
            `  - ${task.id}: ${task.title} [${task.recommendedProfile}] parallel=${task.parallelEligible ? "yes" : "no"} deps=${task.dependencies.join(",") || "none"}`,
        );
    }
    lines.push(
        `Approve with sdd_approve({ manifestId: "${draft.manifestId}", ... }).`,
    );
    return lines.join("\n");
}

async function prepare(
    pi: ExtensionAPI,
    runtime: SddRuntime,
    ctx: ExtensionContext,
    planPathInput: string,
    globalProfile: Profile,
    recordedApprovalEntries: Set<string>,
    liveUi: SddLiveUiCoordinator,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback,
) {
    const planPath = resolveRuntimePath(planPathInput, ctx.cwd);
    const isTui = ctx.mode === "tui";
    const emitStage = (stage: string) => {
        if (isTui) ctx.ui.setWorkingMessage(stage);
        else onUpdate?.(partialLine(stage));
    };
    const emitAssessUpdate = (update: AssessmentProgressUpdate) => {
        // Cache hit: surface a single stage, not a misleading "attempt 1 · cached" status line.
        if (update.requestId === "cached") {
            emitStage("assessment cached");
            return;
        }
        const attempt = extractAttemptNumber(update.requestId);
        const line = formatAssessStatusLine(attempt, update);
        if (isTui)
            ctx.ui.setStatus("sdd-prepare", ctx.ui.theme.fg("muted", line));
        else onUpdate?.(partialLine(line));
    };
    const clearProgress = () => {
        if (!isTui) return;
        ctx.ui.setStatus("sdd-prepare", undefined);
        ctx.ui.setWorkingMessage();
    };

    try {
        emitStage("reading plan");
        const planContent = readFileSync(planPath, "utf8");
        const config = runtimeConfig(runtime, ctx.cwd);
        emitStage("assessing (attempt 1)");
        const { plan, assessment } = await assess(
            runtime,
            ctx,
            signal,
            planPath,
            planContent,
            config,
            (_ctx, update) => emitAssessUpdate(update),
        );
        emitStage("parsing assessment");
        emitStage("compiling manifest");
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
        if (isTui) {
            emitStage("opening review");
            const outcome = await (runtime.openReview ?? openManifestReview)(
                ctx,
                draft,
                createReviewProgressStorage(runtime.store),
            );
            if (outcome.type === "approve") {
                return approveDraft(
                    pi,
                    runtime,
                    ctx,
                    draft,
                    outcome.decision,
                    recordedApprovalEntries,
                    liveUi,
                    signal,
                );
            }
            return textResult(
                outcome.type === "return_to_planning"
                    ? "Manifest returned to planning."
                    : "Manifest review cancelled.",
                { manifest: draft, outcome },
            );
        }
        return textResult(renderDraftSummary(draft), { manifest: draft });
    } finally {
        clearProgress();
    }
}

function renderObservable(entry: ObservableRun): string {
    return "status" in entry
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
            profileLaunches:
                manifest.profileLaunches ?? manifest.maximumLaunches,
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
        "manual-only": 0,
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
            stage: planned?.stage ?? "integration",
            plannedAt: planned?.plannedAt ?? manifest.decision.approvedAt,
        });
    }
    const blockedOutput = Object.values(snapshot.tasks)
        .filter((task) => task.terminalReason === "worker_blocked")
        .flatMap((task) => Object.values(task.terminalResponses ?? {}))
        .findLast((response) =>
            /^BLOCKED:\s+\S/.test(response.output?.trimStart() ?? ""),
        )?.output;
    return {
        manifest,
        snapshot,
        observedAt,
        elapsedMs,
        qualitativeEstimate,
        estimateDrift:
            elapsedMs === undefined
                ? "unknown"
                : elapsedMs > estimateLimitsMs[qualitativeEstimate]
                  ? "overdue"
                  : "on_track",
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
                    delegation.stage === "correction",
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
                    error: response.error,
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

type ObservationTheme = ExtensionContext["ui"]["theme"] | undefined;

const RUN_STATE_GLYPH: Record<
    RunSnapshot["state"],
    {
        glyph: string;
        color: "muted" | "accent" | "success" | "warning" | "error";
    }
> = {
    draft: { glyph: "◦", color: "muted" },
    assessed: { glyph: "●", color: "accent" },
    awaiting_approval: { glyph: "■", color: "warning" },
    approved: { glyph: "●", color: "accent" },
    running: { glyph: "●", color: "accent" },
    needs_input: { glyph: "■", color: "warning" },
    failed: { glyph: "✗", color: "error" },
    cancelled: { glyph: "✗", color: "error" },
    completed: { glyph: "✓", color: "success" },
};

function runStateGlyph(
    theme: ObservationTheme,
    state: RunSnapshot["state"],
): string {
    const { glyph, color } = RUN_STATE_GLYPH[state];
    return theme ? theme.fg(color, glyph) : glyph;
}

function boundedDisplay(value: string, maximum = 160): string {
    return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

export function renderRunObservation(
    observation: ReturnType<typeof observeRun>,
    theme?: ObservationTheme,
): string {
    const lines = [
        `${runStateGlyph(theme, observation.snapshot.state)} ${observation.snapshot.runId}: ${observation.snapshot.state}`,
        `estimate: ${observation.qualitativeEstimate} (${observation.estimateDrift})`,
        ...(observation.snapshot.workspace
            ? [
                  `workspace: isolated (${boundedDisplay(observation.snapshot.workspace.worktreePath)})`,
                  `delivery: ${observation.snapshot.workspace.delivery.status}${observation.snapshot.workspace.delivery.patchDigest ? ` (${observation.snapshot.workspace.delivery.patchDigest.slice(0, 12)})` : ""}`,
              ]
            : []),
        "tasks:",
        ...observation.selectedProfiles.map((task) => {
            const taskSnapshot = observation.snapshot.tasks[task.taskId];
            const state: TaskState = taskSnapshot?.state ?? "pending";
            const glyph = taskStateGlyph(theme, state);
            const prof = profileSeverity(theme, task.profile);
            const terminalReason = taskSnapshot?.terminalReason
                ? `, reason ${taskSnapshot.terminalReason}`
                : "";
            return `- ${glyph} ${task.taskId}: ${state} [${prof}], launches ${taskSnapshot?.launches ?? 0}/${taskSnapshot?.maxLaunches ?? 0}${terminalReason}`;
        }),
        `active requests: ${
            observation.activeRequests.length
                ? observation.activeRequests
                      .map(
                          (request) =>
                              `${request.taskId}/${request.stage} (${request.requestId})`,
                      )
                      .join(", ")
                : "none"
        }`,
        "reviewers:",
        ...(observation.reviewerVerdicts.length
            ? observation.reviewerVerdicts.map(
                  (review) =>
                      `- ${review.taskId}/${review.stage}: ${verdictColor(theme, review.verdict, review.verdict)}, findings ${review.findings.length}, evidence ${review.evidence.length}`,
              )
            : ["- none"]),
        "acceptance:",
        ...(observation.acceptanceEvidence.length
            ? observation.acceptanceEvidence.map(
                  (evidence) =>
                      `- ${evidence.taskId}: ${evidence.status}, acceptance ${evidence.acceptance?.status ?? "not_reported"}, child ${evidence.childRunId ?? "not_reported"}${evidence.error ? `, error ${boundedDisplay(evidence.error)}` : ""}`,
              )
            : ["- none"]),
    ];
    if (observation.blockedDecision) {
        lines.push(
            `blocked: ${theme ? theme.fg("error", observation.blockedDecision) : observation.blockedDecision}`,
        );
    }
    if (observation.blockedOutput) {
        lines.push(`blocked output: ${observation.blockedOutput}`);
    }
    return lines.join("\n");
}

export function registerSddExtension(
    pi: ExtensionAPI,
    runtime: SddRuntime,
): void {
    const recordedApprovalEntries = new Set<string>();
    const liveUi = createLiveUiCoordinator(runtime);
    pi.registerTool({
        name: "sdd_prepare",
        label: "Prepare SDD Manifest",
        description:
            "Compile, assess, store, and review a deterministic SDD manifest.",
        parameters: PrepareSchema,
        execute: async (_id, params, signal, update, ctx) =>
            prepare(
                pi,
                runtime,
                ctx,
                params.planPath,
                params.globalProfile,
                recordedApprovalEntries,
                liveUi,
                signal,
                update,
            ),
    });

    pi.registerTool({
        name: "sdd_submit",
        label: "Submit SDD Plan (Deprecated)",
        description:
            "Compatibility alias for sdd_prepare with the Standard profile.",
        parameters: SubmitSchema,
        async execute(_id, params, signal, update, ctx) {
            const result = await prepare(
                pi,
                runtime,
                ctx,
                params.planPath,
                "standard",
                recordedApprovalEntries,
                liveUi,
                signal,
                update,
            );
            result.content[0].text = `Deprecated: use sdd_prepare.\n${result.content[0].text}`;
            return result;
        },
    });

    pi.registerTool({
        name: "sdd_approve",
        label: "Approve SDD Manifest",
        description: "Apply one typed approval and start the stored manifest.",
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
                liveUi,
                signal,
            );
        },
    });

    pi.registerTool({
        name: "sdd_status",
        label: "SDD Status",
        description:
            "Read durable SDD status, including untouched legacy queued runs.",
        parameters: StatusSchema,
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const entries = collectRunStatuses(runtime.store, runtime.agentDir);
            if (params.runId) {
                const entry = entries.find(
                    (candidate) => candidate.runId === params.runId,
                );
                if (!entry) throw new Error(`Run not found: ${params.runId}.`);
                const manifest =
                    "status" in entry
                        ? null
                        : runtime.store.loadManifest(entry.runId);
                const observation =
                    !("status" in entry) && manifest?.state === "approved"
                        ? observeRun(manifest, entry, now(runtime))
                        : undefined;
                return textResult(
                    observation
                        ? renderRunObservation(
                              observation,
                              ctx.mode === "tui" ? ctx.ui.theme : undefined,
                          )
                        : renderObservable(entry),
                    {
                        snapshot: entry,
                        observation,
                    },
                );
            }
            const theme = ctx.mode === "tui" ? ctx.ui.theme : undefined;
            const observations = new Map<
                string,
                ReturnType<typeof observeRun>
            >();
            for (const entry of entries) {
                if ("status" in entry) continue;
                const manifest = runtime.store.loadManifest(entry.runId);
                if (manifest?.state === "approved") {
                    observations.set(
                        entry.runId,
                        observeRun(manifest, entry, now(runtime)),
                    );
                }
            }
            const runs = [...observations.values()];
            const body =
                entries
                    .map((entry) =>
                        observations.has(entry.runId)
                            ? renderRunObservation(
                                  observations.get(entry.runId)!,
                                  theme,
                              )
                            : renderObservable(entry),
                    )
                    .join("\n") || "No SDD runs.";
            return textResult(body, {
                snapshots: entries,
                runs,
            });
        },
    });

    pi.registerTool({
        name: "sdd_result",
        label: "SDD Result",
        description: "Return the durable snapshot for an SDD run.",
        parameters: RunSchema,
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const snapshot = requireSnapshot(runtime.store, params.runId);
            const manifest = runtime.store.loadManifest(params.runId);
            if (!manifest || manifest.state !== "approved") {
                throw new Error(
                    `Approved manifest not found: ${params.runId}.`,
                );
            }
            const observation = observeRun(manifest, snapshot, now(runtime));
            return textResult(
                renderRunObservation(
                    observation,
                    ctx.mode === "tui" ? ctx.ui.theme : undefined,
                ),
                {
                    snapshot,
                    observation,
                },
            );
        },
    });

    pi.registerTool({
        name: "sdd_apply",
        label: "Apply Isolated SDD Run",
        description:
            "After native confirmation, apply a completed isolated SDD worktree without staging, committing, or pushing.",
        parameters: ApplySchema,
        async execute(_id, params, _signal, _onUpdate, ctx) {
            if (!ctx.hasUI) {
                throw new Error(
                    "sdd_apply requires a native Pi confirmation UI.",
                );
            }
            const snapshot = requireSnapshot(runtime.store, params.runId);
            const manifest = runtime.store.loadManifest(params.runId);
            if (!manifest || manifest.state !== "approved") {
                throw new Error(
                    `Approved manifest not found: ${params.runId}.`,
                );
            }
            if (snapshot.state !== "completed") {
                throw new Error(
                    `sdd_apply is only available for completed runs: ${params.runId}.`,
                );
            }
            if (!snapshot.workspace || snapshot.workspace.mode !== "isolated") {
                throw new Error(
                    `sdd_apply requires an isolated workspace: ${params.runId}.`,
                );
            }
            if (snapshot.workspace.delivery.status === "applied") {
                const observation = observeRun(
                    manifest,
                    snapshot,
                    now(runtime),
                );
                return textResult(
                    `SDD apply already applied for ${params.runId}.\n${renderRunObservation(
                        observation,
                        ctx.mode === "tui" ? ctx.ui.theme : undefined,
                    )}`,
                    { snapshot, observation },
                );
            }
            if (!runtime.workspace) {
                throw new Error(
                    "SDD isolated workspace support is unavailable.",
                );
            }
            const confirmed = await ctx.ui.confirm(
                "Apply isolated SDD changes",
                `Apply the validated changes from SDD run ${params.runId} to the current source worktree? This does not commit or push.`,
            );
            if (!confirmed) {
                return textResult(
                    `SDD apply cancelled for ${params.runId}; source unchanged.`,
                    { snapshot },
                );
            }
            const currentSnapshot = requireSnapshot(
                runtime.store,
                params.runId,
            );
            if (currentSnapshot.state !== "completed") {
                throw new Error(
                    `sdd_apply is only available for completed runs: ${params.runId}.`,
                );
            }
            if (
                !currentSnapshot.workspace ||
                currentSnapshot.workspace.mode !== "isolated"
            ) {
                throw new Error(
                    `sdd_apply requires an isolated workspace: ${params.runId}.`,
                );
            }
            if (currentSnapshot.workspace.delivery.status === "applied") {
                const observation = observeRun(
                    manifest,
                    currentSnapshot,
                    now(runtime),
                );
                return textResult(
                    `SDD apply already applied for ${params.runId}.\n${renderRunObservation(
                        observation,
                        ctx.mode === "tui" ? ctx.ui.theme : undefined,
                    )}`,
                    { snapshot: currentSnapshot, observation },
                );
            }
            const delivery = await runtime.workspace.apply(
                currentSnapshot.workspace,
                ctx.cwd,
            );
            const applied = runtime.workflow.recordWorkspaceApplied(
                params.runId,
                delivery.patchDigest,
                now(runtime),
            );
            const observation = observeRun(manifest, applied, now(runtime));
            return textResult(
                `SDD isolated workspace applied for ${params.runId}.\n${renderRunObservation(
                    observation,
                    ctx.mode === "tui" ? ctx.ui.theme : undefined,
                )}`,
                { snapshot: applied, observation },
            );
        },
    });

    pi.registerTool({
        name: "sdd_cancel",
        label: "Cancel SDD Run",
        description: "Persist and request cancellation for an SDD run.",
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
        name: "sdd_direct_complete",
        label: "Complete Direct SDD Task",
        description:
            "Record exact Direct-task evidence or explicitly attest uncertain work, then continue the run.",
        parameters: DirectCompleteSchema,
        async execute(_id, params, signal, _onUpdate, ctx) {
            const manifest = runtime.store.loadManifest(params.runId);
            if (!manifest || manifest.state !== "approved") {
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
            const directSnapshot = runtime.workflow.completeDirect(
                params.runId,
                params.taskId,
                evidence,
                readFileSync(
                    resolveRuntimePath(manifest.planPath, ctx.cwd),
                    "utf8",
                ),
                params.recovery as RecoveryAttestation | undefined,
                ctx.cwd,
            );
            liveUi.track(ctx, manifest, directSnapshot, true);
            if (ctx.mode === "tui") {
                ctx.ui.setWorkingMessage("running SDD workflow");
            }
            let snapshot: RunSnapshot;
            try {
                snapshot = await runtime.workflow.run(
                    params.runId,
                    ctx,
                    signal,
                );
                runtime.activity?.onSnapshot(snapshot);
            } finally {
                if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
            }
            return textResult(
                `Direct evidence recorded for ${params.taskId}.`,
                {
                    snapshot,
                },
            );
        },
    });

    pi.registerCommand("sdd-review", {
        description: "Review a stored SDD manifest in one native overlay.",
        async handler(args, ctx) {
            const manifestId = args.trim();
            if (!manifestId)
                throw new Error("sdd-review requires a manifest ID.");
            if (ctx.mode !== "tui") {
                throw new Error("sdd-review requires TUI mode.");
            }
            const draft = requireDraft(runtime.store, manifestId);
            const outcome = await (runtime.openReview ?? openManifestReview)(
                ctx,
                draft,
                createReviewProgressStorage(runtime.store),
            );
            if (outcome.type === "approve") {
                const result = await approveDraft(
                    pi,
                    runtime,
                    ctx,
                    draft,
                    outcome.decision,
                    recordedApprovalEntries,
                    liveUi,
                );
                ctx.ui.notify(result.content[0].text, "info");
            } else {
                ctx.ui.notify(
                    outcome.type === "return_to_planning"
                        ? "Manifest returned to planning."
                        : "Manifest review cancelled.",
                    "info",
                );
            }
        },
    });

    pi.registerCommand("sdd-live", {
        description: "Inspect live or durable SDD run activity.",
        async handler(args, ctx) {
            if (ctx.mode !== "tui") {
                throw new Error("sdd-live requires TUI mode.");
            }
            const activity = runtime.activity;
            if (!activity) {
                throw new Error("SDD live activity is unavailable.");
            }
            let runId = args.trim();
            if (!runId) {
                const candidates = runtime.store
                    .list()
                    .filter(
                        (snapshot) =>
                            snapshot.state === "approved" ||
                            snapshot.state === "running",
                    )
                    .map((snapshot) => {
                        const manifest = runtime.store.loadManifest(
                            snapshot.runId,
                        );
                        return manifest?.state === "approved"
                            ? { snapshot, manifest }
                            : null;
                    })
                    .filter(
                        (
                            candidate,
                        ): candidate is {
                            snapshot: RunSnapshot;
                            manifest: ApprovedManifest;
                        } => candidate !== null,
                    );
                if (candidates.length === 0) {
                    ctx.ui.notify(
                        "No active SDD runs. Use /sdd-live <runId>.",
                        "warning",
                    );
                    return;
                }
                if (candidates.length === 1) {
                    runId = candidates[0].snapshot.runId;
                } else {
                    const labels = candidates.map(
                        ({ snapshot, manifest }) =>
                            `${snapshot.runId} · ${snapshot.state} · ${manifest.planTitle}`,
                    );
                    const selected = await ctx.ui.select(
                        "Select an active SDD run",
                        labels,
                    );
                    if (!selected) return;
                    const selectedIndex = labels.indexOf(selected);
                    if (selectedIndex < 0) {
                        throw new Error(
                            "Selected SDD run could not be resolved.",
                        );
                    }
                    const selectedRun = candidates[selectedIndex];
                    if (!selectedRun) {
                        throw new Error(
                            "Selected SDD run could not be resolved.",
                        );
                    }
                    runId = selectedRun.snapshot.runId;
                }
            }

            const snapshot = runtime.store.load(runId);
            const manifest = runtime.store.loadManifest(runId);
            if (!snapshot || !manifest || manifest.state !== "approved") {
                throw new Error(`SDD run not found: ${runId}.`);
            }
            activity.trackRun(manifest, snapshot, {
                live: activity.getRun(runId)?.live ?? false,
            });
            await (runtime.openLive ?? openSddLive)(ctx, activity, runId);
        },
    });

    pi.on("session_start", async (event, ctx) => {
        // Delegated Pi children share the controller's agent directory but must
        // not passively reconcile runs that are still owned by that controller.
        if (process.env.PI_SUBAGENT_CHILD === "1") return;
        if (
            event.reason !== "startup" &&
            event.reason !== "reload" &&
            event.reason !== "resume"
        ) {
            return;
        }
        for (const snapshot of runtime.store.list()) {
            if (
                snapshot.state === "completed" ||
                snapshot.state === "failed" ||
                snapshot.state === "cancelled"
            ) {
                continue;
            }
            const reconciled = runtime.workflow.reconcile(snapshot.runId);
            const manifest = runtime.store.loadManifest(snapshot.runId);
            if (manifest?.state === "approved") {
                liveUi.track(ctx, manifest, reconciled, true);
                runtime.activity?.onSnapshot(reconciled);
            }
            if (shouldContinueAfterReconcile(reconciled)) {
                if (ctx.mode === "tui") {
                    ctx.ui.setWorkingMessage("running SDD workflow");
                }
                try {
                    // oxlint-disable-next-line no-await-in-loop -- persisted runs resume in durable store order and must not overlap writers across manifests.
                    const result = await runtime.workflow.run(
                        snapshot.runId,
                        ctx,
                    );
                    runtime.activity?.onSnapshot(result);
                } finally {
                    if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
                }
            }
        }
    });

    pi.on("session_shutdown", (_event, ctx) => {
        liveUi.dispose(ctx);
        runtime.delegation.dispose();
    });
}
