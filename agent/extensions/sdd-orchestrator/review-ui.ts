import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    Input,
    Key,
    matchesKey,
    truncateToWidth,
    type Component,
    type KeybindingsManager,
    type TUI,
    visibleWidth,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { cycleFocus } from "../_shared/ui/focus-navigation.ts";
import {
    computePanelOverlayHeight,
    renderFramedPanelFallback,
    renderFramedPanels,
    renderPanelTitle,
    resolveResponsivePanelLayout,
    slicePanelViewport,
    wrapPanelLines,
} from "../_shared/ui/framed-panels.ts";
import {
    calculateLaunchPreview,
    type DraftManifest,
    type LaunchPreview,
    type ManifestDecision,
} from "./manifest.ts";
import {
    createInitialReviewProgress,
    type ManifestReviewProgressState,
    type ManifestReviewProgressV1,
    normalizeReviewProgressState,
    parseReviewProgress,
} from "./review-progress.ts";
import { profileSeverity, taskStateGlyph } from "./review-render.ts";
import type { TaskState } from "./state-machine.ts";
import { PROFILES, type Profile } from "./types.ts";

export type QualitativeDuration =
    | "manual-only"
    | "short"
    | "moderate"
    | "extended";

const QUALITATIVE_DURATIONS = [
    "manual-only",
    "short",
    "moderate",
    "extended",
] as const satisfies readonly QualitativeDuration[];

export function estimateQualitativeDuration(
    tasks: DraftManifest["tasks"],
    effectiveProfiles: Readonly<Record<string, Profile>>,
    preview: LaunchPreview,
): QualitativeDuration {
    const profileCounts: Record<Profile, number> = {
        direct: 0,
        light: 0,
        standard: 0,
        critical: 0,
    };
    for (const task of tasks) {
        profileCounts[effectiveProfiles[task.id] ?? task.effectiveProfile]++;
    }
    if (tasks.length === 0) return "manual-only";

    const highestProfileTier = PROFILES.reduce(
        (highest, profile, index) =>
            profileCounts[profile] > 0 ? Math.max(highest, index) : highest,
        0,
    );
    const launchTier =
        preview.maximumLaunches === 0
            ? 0
            : preview.maximumLaunches <= tasks.length
              ? 1
              : preview.maximumLaunches <= tasks.length * 4
                ? 2
                : 3;
    const integrationTier = preview.finalIntegrationReview ? 2 : 0;
    const tier = Math.max(highestProfileTier, launchTier, integrationTier);
    return QUALITATIVE_DURATIONS[tier] ?? "extended";
}

export interface ReviewDecisionState {
    readonly globalProfile: Profile;
    readonly taskOverrides: Readonly<Record<string, Profile>>;
    readonly parallelismEnabled: boolean;
    readonly criticalDowngradeConfirmations: Readonly<Record<string, boolean>>;
    readonly criticalDowngradeJustifications: Readonly<Record<string, string>>;
    readonly finalIntegrationReview: boolean;
    readonly profileLaunches: number;
    readonly qaLaunches: number;
    readonly browserLaunches: number;
    readonly validationLaunches: number;
    readonly maximumLaunches: number;
    readonly estimatedQualitativeDuration: QualitativeDuration;
    readonly acceptedTaskIds: readonly string[];
}

export interface ReviewController {
    readonly current: ReviewDecisionState;
    setGlobalProfile(profile: Profile): void;
    setTaskOverride(taskId: string, profile: Profile | undefined): void;
    setParallelism(enabled: boolean): void;
    setFinalIntegrationReview(enabled: boolean): void;
    confirmCriticalDowngrade(taskId: string, confirmed: boolean): void;
    setCriticalJustification(taskId: string, justification: string): void;
    setTaskAccepted(taskId: string, accepted: boolean): void;
    toggleTaskAcceptance(taskId: string): boolean;
    clearAllAcceptance(): void;
    taskIsAccepted(taskId: string): boolean;
    validate(): string[];
    approve(approvedBy: string, approvedAt: string): ManifestDecision;
    cancel(): null;
}

export interface ReviewProgressStorage {
    loadReviewProgress?: (manifestId: string) => unknown;
    saveReviewProgress?: (
        manifestId: string,
        expectedRevision: number,
        progress: ManifestReviewProgressState,
    ) => Promise<ReviewProgressSaveOutcome> | ReviewProgressSaveOutcome;
}

export type ReviewProgressSaveOutcome =
    | { readonly type: "ok"; readonly revision?: number }
    | {
          readonly type: "conflict";
          readonly current: ManifestReviewProgressV1;
      }
    | {
          readonly type: "error";
          readonly error: string;
      }
    | { readonly type: "noop" };

type PersistResult = {
    readonly warning: string | null;
    readonly persistError: string | null;
    readonly discardQueuedMutations?: boolean;
};

const toArray = (values: Iterable<string>): string[] => Array.from(values);

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeSaveResult(raw: unknown): ReviewProgressSaveOutcome {
    if (!isRecord(raw)) {
        return { type: "noop" };
    }
    const result = raw;
    if (result.type === "ok") {
        return {
            type: "ok",
            revision:
                typeof result.revision === "number"
                    ? result.revision
                    : undefined,
        };
    }
    if (result.type === "conflict") {
        try {
            return {
                type: "conflict",
                current: parseReviewProgress(result.current),
            };
        } catch {
            return { type: "noop" };
        }
    }
    if (result.type === "error" && typeof result.error === "string") {
        return { type: "error", error: result.error };
    }
    if (result.type === "noop") return { type: "noop" };
    try {
        const parsed = parseReviewProgress(raw);
        return { type: "ok", revision: parsed.revision };
    } catch {
        return { type: "noop" };
    }
}

export function createReviewController(
    draft: DraftManifest,
    initialState: ManifestReviewProgressState = createInitialReviewProgress(
        draft,
    ),
): ReviewController {
    let globalProfile = initialState.decision.globalProfile;
    let parallelismEnabled = initialState.decision.parallelismEnabled;
    let finalIntegrationReview = initialState.decision.finalIntegrationReview;
    let globalTaskOverrides: Record<string, Profile> = {
        ...initialState.decision.taskOverrides,
    };
    let confirmations: Record<string, boolean> = {
        ...initialState.decision.criticalDowngradeConfirmations,
    };
    let justifications: Record<string, string> = {
        ...initialState.decision.criticalDowngradeJustifications,
    };
    const acceptedTaskIds = new Set(initialState.acceptedTaskIds);
    const taskIds = new Set(draft.tasks.map((task) => task.id));

    const clearAcceptanceForTask = (taskId: string): void => {
        acceptedTaskIds.delete(taskId);
    };

    const assertKnownTask = (taskId: string): void => {
        if (!taskIds.has(taskId)) {
            throw new Error(`Unknown task: ${taskId}.`);
        }
    };

    const effectiveProfiles = () =>
        Object.fromEntries(
            draft.tasks.map((task) => [
                task.id,
                globalTaskOverrides[task.id] ?? globalProfile,
            ]),
        );
    const validationErrors = () => {
        const errors: string[] = [];
        const profiles = effectiveProfiles();
        const accepted = toArray(acceptedTaskIds);
        for (const task of draft.tasks) {
            const profile = profiles[task.id];
            if (
                task.recommendedProfile !== "critical" ||
                (profile !== "direct" && profile !== "light")
            ) {
                continue;
            }
            if (!confirmations[task.id]) {
                errors.push(
                    `Critical downgrade for ${task.id} requires confirmation.`,
                );
            } else if (!justifications[task.id]?.trim()) {
                errors.push(
                    `Critical downgrade for ${task.id} requires a justification.`,
                );
            }
        }
        for (const taskId of toArray(taskIds)) {
            if (!accepted.includes(taskId)) {
                errors.push(`Task ${taskId} is not accepted.`);
            }
        }
        return errors;
    };

    return {
        get current() {
            const profiles = effectiveProfiles();
            const preview = calculateLaunchPreview(
                draft.tasks,
                profiles,
                finalIntegrationReview,
            );
            return {
                globalProfile,
                taskOverrides: { ...globalTaskOverrides },
                parallelismEnabled,
                criticalDowngradeConfirmations: { ...confirmations },
                criticalDowngradeJustifications: { ...justifications },
                acceptedTaskIds: toArray(taskIds).filter((taskId) =>
                    acceptedTaskIds.has(taskId),
                ),
                ...preview,
                estimatedQualitativeDuration: estimateQualitativeDuration(
                    draft.tasks,
                    profiles,
                    preview,
                ),
            };
        },
        setGlobalProfile(profile) {
            if (globalProfile === profile) return;
            globalProfile = profile;
            acceptedTaskIds.clear();
        },
        setTaskOverride(taskId, profile) {
            assertKnownTask(taskId);
            if (globalTaskOverrides[taskId] === profile) return;
            if (profile === undefined) delete globalTaskOverrides[taskId];
            else globalTaskOverrides[taskId] = profile;
            clearAcceptanceForTask(taskId);
        },
        setParallelism(enabled) {
            if (parallelismEnabled === enabled) return;
            parallelismEnabled = enabled;
            acceptedTaskIds.clear();
        },
        setFinalIntegrationReview(enabled) {
            if (finalIntegrationReview === enabled) return;
            finalIntegrationReview = enabled;
            acceptedTaskIds.clear();
        },
        confirmCriticalDowngrade(taskId, confirmed) {
            assertKnownTask(taskId);
            if (confirmations[taskId] === confirmed) return;
            confirmations[taskId] = confirmed;
            clearAcceptanceForTask(taskId);
        },
        setCriticalJustification(taskId, justification) {
            assertKnownTask(taskId);
            if (justifications[taskId] === justification) return;
            justifications[taskId] = justification;
            clearAcceptanceForTask(taskId);
        },
        setTaskAccepted(taskId, accepted) {
            assertKnownTask(taskId);
            if (accepted) {
                acceptedTaskIds.add(taskId);
            } else {
                acceptedTaskIds.delete(taskId);
            }
        },
        toggleTaskAcceptance(taskId) {
            assertKnownTask(taskId);
            if (acceptedTaskIds.has(taskId)) {
                acceptedTaskIds.delete(taskId);
                return false;
            }
            acceptedTaskIds.add(taskId);
            return true;
        },
        clearAllAcceptance() {
            acceptedTaskIds.clear();
        },
        taskIsAccepted(taskId) {
            assertKnownTask(taskId);
            return acceptedTaskIds.has(taskId);
        },
        validate: validationErrors,
        approve(approvedBy, approvedAt) {
            const errors = validationErrors();
            if (errors[0]) throw new Error(errors[0]);
            return {
                globalProfile,
                taskOverrides: { ...globalTaskOverrides },
                parallelismEnabled,
                finalIntegrationReview,
                criticalDowngradeConfirmations: { ...confirmations },
                criticalDowngradeJustifications: { ...justifications },
                approvedBy,
                approvedAt,
            };
        },
        cancel: () => null,
    };
}

export type ManifestReviewOutcome =
    | { readonly type: "approve"; readonly decision: ManifestDecision }
    | { readonly type: "return_to_planning" }
    | { readonly type: "cancel" };

type ReviewTheme = ExtensionContext["ui"]["theme"];

function fit(text: string, width: number): string {
    const clipped = truncateToWidth(text, Math.max(0, width));
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function rightAligned(left: string, right: string, width: number): string {
    const rightWidth = visibleWidth(right);
    const leftWidth = Math.max(0, width - rightWidth - 1);
    return (
        fit(left, leftWidth) +
        " ".repeat(Math.max(1, width - leftWidth - rightWidth)) +
        fit(right, rightWidth)
    );
}

function taskReviewState(
    draft: DraftManifest,
    taskId: string,
    state: ReviewController["current"],
): TaskState {
    const task = draft.tasks.find((t) => t.id === taskId);
    if (!task) return "pending";
    const effective = state.taskOverrides[task.id] ?? state.globalProfile;
    if (
        task.recommendedProfile === "critical" &&
        (effective === "direct" || effective === "light")
    ) {
        const confirmed =
            state.criticalDowngradeConfirmations[task.id] ?? false;
        const justified =
            !!state.criticalDowngradeJustifications[task.id]?.trim();
        return confirmed && justified ? "verified" : "needs_input";
    }
    return "verified";
}

export class ManifestReviewComponent implements Component {
    private selectedTask = 0;
    private focusedPanel: "roster" | "detail" | "validation" = "roster";
    private detailScroll = 0;
    private detailLineCount = 0;
    private validationScroll = 0;
    private validationLineCount = 0;
    private renderedLayoutMode: "compact" | "medium" | "wide" = "wide";
    private bodyHeight = 8;
    private editingJustification = false;
    private readonly justificationInput = new Input();
    private errors: string[] = [];
    private saveError: string | null = null;
    private conflictWarning: string | null = null;
    private revision = 0;
    private pendingSave = Promise.resolve();
    private saveInFlight = 0;
    private persistenceEpoch = 0;

    constructor(
        private readonly tui: TUI,
        private readonly theme: ReviewTheme,
        private readonly keybindings: KeybindingsManager,
        private readonly draft: DraftManifest,
        private controller: ReviewController,
        private readonly done: (result: ManifestReviewOutcome) => void,
        initialRevision = 0,
        private readonly progressStorage: ReviewProgressStorage = {},
    ) {
        this.revision = initialRevision;
        this.justificationInput.onSubmit = (value) => {
            const task = this.draft.tasks[this.selectedTask];
            if (task) {
                const rollbackState = this.serializeProgress();
                this.controller.setCriticalJustification(task.id, value);
                this.persistMutation("critical-justification", rollbackState);
            }
            this.editingJustification = false;
            this.tui.requestRender();
        };
        this.justificationInput.onEscape = () => {
            this.editingJustification = false;
            this.tui.requestRender();
        };
    }

    private get selectedTaskId(): string | null {
        return this.draft.tasks[this.selectedTask]?.id ?? null;
    }

    private get taskIds(): string[] {
        return this.draft.tasks.map((task) => task.id);
    }

    private serializeProgress(): ManifestReviewProgressState {
        const state = this.controller.current;
        return {
            acceptedTaskIds: [...state.acceptedTaskIds],
            decision: {
                globalProfile: state.globalProfile,
                taskOverrides: { ...state.taskOverrides },
                parallelismEnabled: state.parallelismEnabled,
                finalIntegrationReview: state.finalIntegrationReview,
                criticalDowngradeConfirmations: {
                    ...state.criticalDowngradeConfirmations,
                },
                criticalDowngradeJustifications: {
                    ...state.criticalDowngradeJustifications,
                },
            },
        };
    }

    private async persistToStore(
        expectedRevision: number,
        state: ManifestReviewProgressState,
    ): Promise<PersistResult> {
        const save = this.progressStorage.saveReviewProgress;
        if (!save) {
            this.revision = expectedRevision + 1;
            return { warning: null, persistError: null };
        }

        const raw = normalizeSaveResult(
            await save(this.draft.manifestId, expectedRevision, state),
        );
        if (raw.type === "ok") {
            this.revision = raw.revision ?? expectedRevision + 1;
            return { warning: null, persistError: null };
        }
        if (raw.type === "noop") {
            this.revision = expectedRevision + 1;
            return { warning: null, persistError: null };
        }
        if (raw.type === "error") {
            return {
                warning: null,
                persistError: `Failed to persist review progress: ${raw.error}`,
            };
        }
        try {
            const current = parseReviewProgress(raw.current);
            if (current.manifestId !== this.draft.manifestId) {
                throw new Error(
                    `Review progress manifestId mismatch: ${current.manifestId}.`,
                );
            }
            const normalized = normalizeReviewProgressState(this.draft, {
                acceptedTaskIds: current.acceptedTaskIds,
                decision: current.decision,
            });
            this.conflictWarning =
                "Review progress was updated by another session. Reloaded latest state.";
            this.saveError = null;
            this.controller = createReviewController(this.draft, normalized);
            this.revision = current.revision;
            return {
                warning: this.conflictWarning,
                persistError: null,
                discardQueuedMutations: true,
            };
        } catch (error) {
            return {
                warning: null,
                persistError:
                    error instanceof Error
                        ? error.message
                        : "Review progress conflict could not be applied.",
            };
        }
    }

    private persistMutation(
        _reason: string,
        rollbackState: ManifestReviewProgressState = this.serializeProgress(),
    ): void {
        const state = this.serializeProgress();
        const epoch = this.persistenceEpoch;
        this.saveInFlight += 1;
        const runSave = async (): Promise<void> => {
            if (epoch !== this.persistenceEpoch) {
                this.saveInFlight = Math.max(0, this.saveInFlight - 1);
                this.tui.requestRender();
                return;
            }
            try {
                const result = await this.persistToStore(this.revision, state);
                this.saveError = result.persistError;
                if (result.discardQueuedMutations) {
                    const hasQueuedLocalMutations = this.saveInFlight > 1;
                    this.persistenceEpoch += 1;
                    this.conflictWarning =
                        "Review progress was updated by another session. Reloaded latest state." +
                        (hasQueuedLocalMutations
                            ? " Pending local changes were discarded."
                            : "");
                } else if (result.persistError) {
                    this.controller = createReviewController(
                        this.draft,
                        rollbackState,
                    );
                    this.persistenceEpoch += 1;
                }
                if (!result.warning && this.saveError === null) {
                    this.conflictWarning = null;
                }
                if (result.warning && !result.discardQueuedMutations) {
                    this.conflictWarning = result.warning;
                }
                this.saveInFlight = Math.max(0, this.saveInFlight - 1);
                this.tui.requestRender();
            } catch (error) {
                this.controller = createReviewController(
                    this.draft,
                    rollbackState,
                );
                this.persistenceEpoch += 1;
                this.saveError =
                    error instanceof Error
                        ? `Failed to persist review progress: ${error.message}`
                        : "Failed to persist review progress.";
                this.saveInFlight = Math.max(0, this.saveInFlight - 1);
                this.tui.requestRender();
            }
        };
        this.pendingSave =
            this.saveInFlight === 1
                ? runSave()
                : this.pendingSave.then(runSave, runSave);
    }

    private mutateAndPersist(mutator: () => void): void {
        const rollbackState = this.serializeProgress();
        mutator();
        this.persistMutation("mutation", rollbackState);
        this.tui.requestRender();
    }

    private moveSelection(delta: number): void {
        if (this.draft.tasks.length === 0) return;
        this.selectedTask = Math.max(
            0,
            Math.min(this.draft.tasks.length - 1, this.selectedTask + delta),
        );
        this.detailScroll = 0;
        this.tui.requestRender();
    }

    private rosterLines(width: number, bodyHeight: number): string[] {
        const state = this.controller.current;
        if (this.draft.tasks.length === 0)
            return [this.theme.fg("dim", "No tasks")];
        const start = Math.max(
            0,
            Math.min(
                this.selectedTask - bodyHeight + 1,
                Math.max(0, this.draft.tasks.length - bodyHeight),
            ),
        );
        return this.draft.tasks
            .slice(start, start + bodyHeight)
            .map((task, offset) => {
                const index = start + offset;
                const marker =
                    index === this.selectedTask
                        ? this.theme.fg("accent", "›")
                        : " ";
                const effective =
                    state.taskOverrides[task.id] ?? state.globalProfile;
                const reviewState = taskReviewState(this.draft, task.id, state);
                const glyph = taskStateGlyph(this.theme, reviewState);
                const accepted = this.controller.taskIsAccepted(task.id)
                    ? this.theme.fg("success", "[x]")
                    : this.theme.fg("muted", "[ ]");
                const left = `${marker} ${accepted} ${glyph} ${task.id}: ${task.title}`;
                return rightAligned(
                    left,
                    profileSeverity(this.theme, effective),
                    width,
                );
            });
    }

    private detailLines(width: number): string[] {
        const state = this.controller.current;
        const task = this.draft.tasks[this.selectedTask];
        if (!task) return [this.theme.fg("dim", "No task selected")];
        const effective = state.taskOverrides[task.id] ?? state.globalProfile;
        const raw = [
            this.theme.bold(task.title),
            `description: ${task.description}`,
            this.theme.fg("muted", `id: ${task.id}`),
            `recommended: ${profileSeverity(this.theme, task.recommendedProfile)}  effective: ${profileSeverity(this.theme, effective)}`,
            `parallel: ${task.parallelEligible ? "yes" : "no"}  integration: ${state.finalIntegrationReview ? "required" : "off"}`,
            `dependencies: ${task.dependencies.join(", ") || "none"}`,
            `rules: ${task.classificationRules.join(", ") || "none"}`,
            `files: ${task.files.join(", ") || "none"}`,
            `verify: ${task.verify.map((v) => v.id).join(", ") || "none"}`,
        ];
        if (task.qa?.length)
            raw.push(`validation=QA launch (${task.qa.length})`);
        if (task.browser?.length)
            raw.push(`validation=Browser launch (${task.browser.length})`);
        if (
            task.recommendedProfile === "critical" &&
            (effective === "direct" || effective === "light")
        ) {
            raw.push(
                `CRITICAL DOWNGRADE confirmed=${state.criticalDowngradeConfirmations[task.id] ? "yes" : "no"}`,
                `justification=${state.criticalDowngradeJustifications[task.id] || "(required)"}`,
            );
        }
        const lines: string[] = [];
        for (const line of raw) {
            const wrapped = wrapTextWithAnsi(line, Math.max(1, width));
            lines.push(...(wrapped.length ? wrapped : [""]));
        }
        return lines;
    }

    private validationLines(): string[] {
        const state = this.controller.current;
        const task = this.draft.tasks[this.selectedTask];
        const lines: string[] = [];
        const errors = this.controller.validate();
        this.errors = errors;
        if (errors.length) {
            lines.push(this.theme.fg("error", "Validation errors:"));
            for (const error of errors)
                lines.push(this.theme.fg("error", `· ${error}`));
        } else {
            lines.push(this.theme.fg("success", "Validation: OK"));
        }
        if (this.saveError) {
            lines.push(this.theme.fg("error", this.saveError));
        }
        if (this.conflictWarning) {
            lines.push(this.theme.fg("warning", this.conflictWarning));
        }
        const unaccepted =
            state.acceptedTaskIds.length === this.draft.tasks.length
                ? []
                : this.taskIds.filter(
                      (taskId) => !state.acceptedTaskIds.includes(taskId),
                  );
        if (unaccepted.length) {
            lines.push(
                this.theme.fg(
                    "warning",
                    `Pending acceptance: ${unaccepted.join(", ")}`,
                ),
            );
        }
        if (task && task.recommendedProfile === "critical") {
            const effective =
                state.taskOverrides[task.id] ?? state.globalProfile;
            if (effective === "direct" || effective === "light") {
                const confirmed =
                    state.criticalDowngradeConfirmations[task.id] ?? false;
                const justified =
                    !!state.criticalDowngradeJustifications[task.id]?.trim();
                lines.push("", this.theme.bold("Critical downgrade:"));
                lines.push(
                    `confirmed: ${confirmed ? this.theme.fg("success", "yes") : this.theme.fg("warning", "no")}`,
                );
                lines.push(
                    `justified: ${justified ? this.theme.fg("success", "yes") : this.theme.fg("warning", "no")}`,
                );
            }
        }
        return lines;
    }

    private panelTitle(
        panel: "roster" | "detail" | "validation",
        label: string,
    ): string {
        return renderPanelTitle(
            this.theme,
            label,
            this.focusedPanel === panel,
            { padding: 0 },
        );
    }

    private panelTitleCells(
        mode: "compact" | "medium" | "wide",
    ): readonly string[] {
        if (mode === "wide") {
            return [
                this.panelTitle("roster", "TASKS"),
                this.panelTitle("detail", "DETAILS"),
                this.panelTitle("validation", "VALIDATION"),
            ];
        }
        if (mode === "medium") {
            const combinedTitle =
                this.focusedPanel === "validation"
                    ? `${this.theme.fg("muted", "DETAILS +")} ${this.panelTitle("validation", "VALIDATION")}`
                    : this.focusedPanel === "detail"
                      ? `${this.panelTitle("detail", "DETAILS")} ${this.theme.fg("muted", "+ VALIDATION")}`
                      : this.theme.fg("muted", "DETAILS + VALIDATION");
            return [this.panelTitle("roster", "TASKS"), combinedTitle];
        }
        const label =
            this.focusedPanel === "roster"
                ? "TASKS"
                : this.focusedPanel === "detail"
                  ? "DETAILS"
                  : "VALIDATION";
        return [this.panelTitle(this.focusedPanel, label)];
    }

    private focusHelp(): string {
        const focused =
            this.focusedPanel === "roster"
                ? "Tasks"
                : this.focusedPanel === "detail"
                  ? "Details"
                  : "Validation";
        const controls =
            this.focusedPanel === "roster"
                ? "↑↓ select task"
                : `↑↓/PgUp/PgDn scroll ${focused.toLowerCase()}`;
        return `Focus: ${focused} · Tab panels · ${controls}`;
    }

    render(width: number): string[] {
        const rows = this.tui.terminal?.rows ?? 32;
        const maxHeight = computePanelOverlayHeight(rows);
        if (width < 36) {
            return renderFramedPanelFallback({
                theme: this.theme,
                width,
                maxHeight: Math.min(3, maxHeight),
                title: "SDD manifest review",
                message: "Need ≥36 columns · Esc",
            });
        }
        if (maxHeight < 3)
            return ["Manifest review is too short to display. Esc closes."];

        const resolved = resolveResponsivePanelLayout(width, [
            {
                mode: "compact",
                minWidth: 36,
                panels: [{ minWidth: 34 }],
            },
            {
                mode: "medium",
                minWidth: 60,
                panels: [
                    { minWidth: 24, maxWidth: 24 },
                    { minWidth: 33, weight: 1 },
                ],
            },
            {
                mode: "wide",
                minWidth: 96,
                panels: [
                    { minWidth: 24, maxWidth: 24 },
                    { minWidth: 40, weight: 1 },
                    { minWidth: 28, maxWidth: 28 },
                ],
            },
        ] as const);
        if (!resolved) return ["Manifest review cannot fit. Esc closes."];
        const { layout } = resolved;
        this.renderedLayoutMode = resolved.mode;
        const wide = resolved.mode === "wide";
        const medium = resolved.mode === "medium";

        const renderLowHeightFallback = (): string[] =>
            renderFramedPanelFallback({
                theme: this.theme,
                width,
                maxHeight,
                title: "SDD manifest review",
                message: `${this.focusHelp()} · a approve · r return · Esc cancel`,
            }).map((line) => truncateToWidth(line, width));
        if (maxHeight <= 8) return renderLowHeightFallback();

        const state = this.controller.current;
        const rosterWidth = layout.panelWidths[0];
        const detailWidth = layout.panelWidths[wide || medium ? 1 : 0];
        const validationWidth = wide ? layout.panelWidths[2] : detailWidth;
        const pending = this.taskIds.filter(
            (taskId) => !state.acceptedTaskIds.includes(taskId),
        );
        const notices = wrapPanelLines(
            [
                ...(this.saveError
                    ? [this.theme.fg("error", this.saveError)]
                    : []),
                ...(this.conflictWarning
                    ? [this.theme.fg("warning", this.conflictWarning)]
                    : []),
                ...(pending.length
                    ? [
                          this.theme.fg(
                              "warning",
                              `Pending acceptance: ${pending.join(", ")}`,
                          ),
                      ]
                    : []),
            ],
            width - 2,
            { padding: 0 },
        );
        const actionLines = wrapPanelLines(
            [
                this.theme.fg(
                    "dim",
                    `${this.focusHelp()} · Home/End scroll · Space/Enter accept · g/o/p/i/c/j · a approve · r return · Esc cancel`,
                ),
            ],
            layout.frameWidth - 2,
            { padding: 1 },
        );
        const availableActionLines = Math.max(
            1,
            maxHeight - (1 + 2 + notices.length + 3 + 1 + 1 + 1),
        );
        const visibleActionLines = actionLines.slice(0, availableActionLines);
        const editorLines = this.editingJustification
            ? wrapPanelLines(
                  [
                      this.theme.bold("Critical downgrade justification:"),
                      ...this.justificationInput.render(detailWidth),
                  ],
                  detailWidth,
                  { padding: 0 },
              )
            : [];
        const fixedLines =
            1 + 2 + notices.length + 3 + visibleActionLines.length + 1 + 1;
        if (fixedLines > maxHeight) return renderLowHeightFallback();
        this.bodyHeight = Math.max(0, maxHeight - fixedLines);

        const roster = this.rosterLines(rosterWidth, this.bodyHeight);
        let details = [...editorLines, ...this.detailLines(detailWidth)];
        const validation = wrapPanelLines(
            this.validationLines(),
            validationWidth,
            { padding: 0 },
        );
        if (!wide && medium) {
            details = [...details, "", ...validation];
        }
        this.detailLineCount = details.length;
        this.validationLineCount = validation.length;
        const detailViewport = slicePanelViewport(
            details,
            this.detailScroll,
            this.bodyHeight,
        );
        const validationViewport = slicePanelViewport(
            validation,
            this.validationScroll,
            this.bodyHeight,
        );
        this.detailScroll = detailViewport.offset;
        this.validationScroll = validationViewport.offset;
        const visibleDetails = detailViewport.lines;
        const visibleValidation = validationViewport.lines;

        const panelRows: string[][] = [];
        for (let index = 0; index < this.bodyHeight; index++) {
            const compactContent =
                this.focusedPanel === "roster"
                    ? roster[index]
                    : this.focusedPanel === "detail"
                      ? visibleDetails[index]
                      : visibleValidation[index];
            panelRows.push(
                wide
                    ? [
                          roster[index] ?? "",
                          visibleDetails[index] ?? "",
                          visibleValidation[index] ?? "",
                      ]
                    : medium
                      ? [roster[index] ?? "", visibleDetails[index] ?? ""]
                      : [compactContent ?? ""],
            );
        }
        const lines = renderFramedPanels({
            theme: this.theme,
            title: `SDD manifest review ${this.theme.fg("accent", "›")} · ${this.draft.planTitle}`,
            layout,
            prelude: [
                ` ${this.theme.fg("muted", `duration: ${state.estimatedQualitativeDuration} · launches: ${state.maximumLaunches} · global: ${state.globalProfile} · parallel: ${state.parallelismEnabled ? "on" : "off"}`)}`,
                ` ${this.theme.fg("muted", `Validation launches: qa=${state.qaLaunches}, browser=${state.browserLaunches}, total=${state.validationLaunches} (of profile budget ${state.profileLaunches})`)}`,
                ...notices.map((notice) => ` ${notice}`),
            ],
            panelTitles: this.panelTitleCells(this.renderedLayoutMode),
            panelRows,
            boxFooterRows: visibleActionLines,
            maxHeight,
        });
        return lines.map((line) => truncateToWidth(line, width));
    }

    private scrollFocusedPanel(delta: number): void {
        if (
            this.focusedPanel === "validation" &&
            this.renderedLayoutMode !== "medium"
        ) {
            const maxScroll = Math.max(
                0,
                this.validationLineCount - this.bodyHeight,
            );
            this.validationScroll = Math.max(
                0,
                Math.min(maxScroll, this.validationScroll + delta),
            );
            return;
        }
        const maxScroll = Math.max(0, this.detailLineCount - this.bodyHeight);
        this.detailScroll = Math.max(
            0,
            Math.min(maxScroll, this.detailScroll + delta),
        );
    }

    private scrollFocusedPanelToEnd(): void {
        if (
            this.focusedPanel === "validation" &&
            this.renderedLayoutMode !== "medium"
        ) {
            this.validationScroll = Math.max(
                0,
                this.validationLineCount - this.bodyHeight,
            );
            return;
        }
        this.detailScroll = Math.max(0, this.detailLineCount - this.bodyHeight);
    }

    private scrollFocusedPanelToStart(): void {
        if (
            this.focusedPanel === "validation" &&
            this.renderedLayoutMode !== "medium"
        ) {
            this.validationScroll = 0;
            return;
        }
        this.detailScroll = 0;
    }

    handleInput(data: string): void {
        if (this.editingJustification) {
            this.justificationInput.handleInput(data);
            this.tui.requestRender();
            return;
        }
        if (
            this.keybindings.matches(data, "tui.select.cancel") ||
            matchesKey(data, Key.escape) ||
            matchesKey(data, "q") ||
            matchesKey(data, Key.shift("q")) ||
            matchesKey(data, Key.ctrl("c"))
        ) {
            this.done({ type: "cancel" });
            return;
        }
        if (
            this.keybindings.matches(data, "tui.select.up") ||
            matchesKey(data, Key.up) ||
            matchesKey(data, "k")
        ) {
            if (this.focusedPanel === "roster") return this.moveSelection(-1);
            this.scrollFocusedPanel(-1);
            this.tui.requestRender();
            return;
        }
        if (matchesKey(data, "j")) {
            const task = this.draft.tasks[this.selectedTask];
            if (task) {
                this.justificationInput.setValue(
                    this.controller.current.criticalDowngradeJustifications[
                        task.id
                    ] ?? "",
                );
                this.justificationInput.focused = true;
                this.editingJustification = true;
                this.focusedPanel = "detail";
            }
            this.tui.requestRender();
            return;
        }
        if (
            this.keybindings.matches(data, "tui.select.down") ||
            matchesKey(data, Key.down)
        ) {
            if (this.focusedPanel === "roster") return this.moveSelection(1);
            this.scrollFocusedPanel(1);
            this.tui.requestRender();
            return;
        }
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
            const panels: readonly (typeof this.focusedPanel)[] = [
                "roster",
                "detail",
                "validation",
            ];
            this.focusedPanel = cycleFocus(panels, this.focusedPanel, 1);
            this.tui.requestRender();
            return;
        }
        if (
            matchesKey(data, Key.shift(Key.tab)) ||
            matchesKey(data, Key.left)
        ) {
            const panels: readonly (typeof this.focusedPanel)[] = [
                "roster",
                "detail",
                "validation",
            ];
            this.focusedPanel = cycleFocus(panels, this.focusedPanel, -1);
            this.tui.requestRender();
            return;
        }
        if (matchesKey(data, Key.pageUp)) {
            this.scrollFocusedPanel(-this.bodyHeight);
            this.tui.requestRender();
            return;
        }
        if (matchesKey(data, Key.pageDown)) {
            this.scrollFocusedPanel(this.bodyHeight);
            this.tui.requestRender();
            return;
        }
        if (matchesKey(data, Key.home)) {
            this.scrollFocusedPanelToStart();
            this.tui.requestRender();
            return;
        }
        if (matchesKey(data, Key.end)) {
            this.scrollFocusedPanelToEnd();
            this.tui.requestRender();
            return;
        }
        if (
            matchesKey(data, Key.space) ||
            matchesKey(data, Key.enter) ||
            matchesKey(data, Key.return)
        ) {
            const taskId = this.selectedTaskId;
            if (taskId) {
                this.mutateAndPersist(() =>
                    this.controller.toggleTaskAcceptance(taskId),
                );
            }
            return;
        }
        if (matchesKey(data, "g")) {
            const current = PROFILES.indexOf(
                this.controller.current.globalProfile,
            );
            this.mutateAndPersist(() =>
                this.controller.setGlobalProfile(
                    PROFILES[(current + 1) % PROFILES.length],
                ),
            );
        } else if (matchesKey(data, "p")) {
            this.mutateAndPersist(() =>
                this.controller.setParallelism(
                    !this.controller.current.parallelismEnabled,
                ),
            );
        } else if (matchesKey(data, "i")) {
            this.mutateAndPersist(() =>
                this.controller.setFinalIntegrationReview(
                    !this.controller.current.finalIntegrationReview,
                ),
            );
        } else if (matchesKey(data, "o")) {
            const task = this.draft.tasks[this.selectedTask];
            if (task) {
                const current = this.controller.current.taskOverrides[task.id];
                const options: Array<Profile | undefined> = [
                    undefined,
                    ...PROFILES,
                ];
                this.mutateAndPersist(() =>
                    this.controller.setTaskOverride(
                        task.id,
                        options[
                            (options.indexOf(current) + 1) % options.length
                        ],
                    ),
                );
            }
        } else if (matchesKey(data, "c")) {
            const task = this.draft.tasks[this.selectedTask];
            if (task) {
                this.mutateAndPersist(() =>
                    this.controller.confirmCriticalDowngrade(task.id, true),
                );
            }
        } else if (matchesKey(data, "r")) {
            this.done({ type: "return_to_planning" });
            return;
        } else if (matchesKey(data, "a")) {
            this.errors = this.controller.validate();
            if (
                !this.errors.length &&
                !this.saveError &&
                this.saveInFlight === 0
            ) {
                this.done({
                    type: "approve",
                    decision: this.controller.approve(
                        "interactive",
                        new Date().toISOString(),
                    ),
                });
                return;
            }
        }
        this.tui.requestRender();
    }

    invalidate(): void {
        this.justificationInput.invalidate();
    }
}

type ResolvedReviewProgress = {
    readonly initialState: ManifestReviewProgressState;
    readonly initialRevision: number;
};

async function resolveReviewProgress(
    draft: DraftManifest,
    progressStorage: ReviewProgressStorage,
): Promise<ResolvedReviewProgress> {
    const initialProgress = createInitialReviewProgress(draft);
    if (!progressStorage.loadReviewProgress) {
        return { initialState: initialProgress, initialRevision: 0 };
    }

    const raw = await progressStorage.loadReviewProgress(draft.manifestId);
    if (!raw) return { initialState: initialProgress, initialRevision: 0 };

    const parsed = parseReviewProgress(raw);
    if (parsed.manifestId !== draft.manifestId) {
        throw new Error(
            `Review progress manifestId mismatch: ${parsed.manifestId}.`,
        );
    }
    return {
        initialState: normalizeReviewProgressState(draft, {
            acceptedTaskIds: parsed.acceptedTaskIds,
            decision: parsed.decision,
        }),
        initialRevision: parsed.revision,
    };
}

export async function openManifestReview(
    ctx: ExtensionContext,
    draft: DraftManifest,
    reviewProgressStorage: ReviewProgressStorage = {},
): Promise<ManifestReviewOutcome> {
    if (ctx.mode !== "tui") {
        throw new Error("Manifest review overlay requires TUI mode.");
    }
    const { initialState, initialRevision } = await resolveReviewProgress(
        draft,
        reviewProgressStorage,
    );
    const controller = createReviewController(draft, initialState);
    return ctx.ui.custom<ManifestReviewOutcome>(
        (tui, theme, keybindings, done) =>
            new ManifestReviewComponent(
                tui,
                theme,
                keybindings,
                draft,
                controller,
                done,
                initialRevision,
                reviewProgressStorage,
            ),
        {
            overlay: true,
            overlayOptions: {
                anchor: "center",
                width: "95%",
                minWidth: 60,
                maxHeight: "85%",
                margin: 1,
            },
        },
    );
}
