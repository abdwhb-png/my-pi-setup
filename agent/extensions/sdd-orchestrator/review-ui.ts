import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    Input,
    matchesKey,
    truncateToWidth,
    type Component,
    type KeybindingsManager,
    type TUI,
    visibleWidth,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
    calculateLaunchPreview,
    type DraftManifest,
    type LaunchPreview,
    type ManifestDecision,
} from "./manifest.ts";
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
}

export interface ReviewController {
    readonly current: ReviewDecisionState;
    setGlobalProfile(profile: Profile): void;
    setTaskOverride(taskId: string, profile: Profile | undefined): void;
    setParallelism(enabled: boolean): void;
    setFinalIntegrationReview(enabled: boolean): void;
    confirmCriticalDowngrade(taskId: string, confirmed: boolean): void;
    setCriticalJustification(taskId: string, justification: string): void;
    validate(): string[];
    approve(approvedBy: string, approvedAt: string): ManifestDecision;
    cancel(): null;
}

export function createReviewController(draft: DraftManifest): ReviewController {
    let globalProfile = draft.globalProfile;
    let parallelismEnabled = draft.parallelismEnabled;
    let finalIntegrationReview = false;
    const taskOverrides: Record<string, Profile> = Object.fromEntries(
        draft.tasks
            .filter((task) => task.recommendedProfile !== draft.globalProfile)
            .map((task) => [task.id, task.recommendedProfile]),
    );
    const confirmations: Record<string, boolean> = {};
    const justifications: Record<string, string> = {};
    const taskIds = new Set(draft.tasks.map((task) => task.id));

    const effectiveProfiles = () =>
        Object.fromEntries(
            draft.tasks.map((task) => [
                task.id,
                taskOverrides[task.id] ?? globalProfile,
            ]),
        );
    const validationErrors = () => {
        const errors: string[] = [];
        const profiles = effectiveProfiles();
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
                taskOverrides: { ...taskOverrides },
                parallelismEnabled,
                criticalDowngradeConfirmations: { ...confirmations },
                criticalDowngradeJustifications: { ...justifications },
                ...preview,
                estimatedQualitativeDuration: estimateQualitativeDuration(
                    draft.tasks,
                    profiles,
                    preview,
                ),
            };
        },
        setGlobalProfile(profile) {
            globalProfile = profile;
        },
        setTaskOverride(taskId, profile) {
            if (!taskIds.has(taskId))
                throw new Error(`Unknown task: ${taskId}.`);
            if (profile === undefined) delete taskOverrides[taskId];
            else taskOverrides[taskId] = profile;
        },
        setParallelism(enabled) {
            parallelismEnabled = enabled;
        },
        setFinalIntegrationReview(enabled) {
            finalIntegrationReview = enabled;
        },
        confirmCriticalDowngrade(taskId, confirmed) {
            if (!taskIds.has(taskId))
                throw new Error(`Unknown task: ${taskId}.`);
            confirmations[taskId] = confirmed;
        },
        setCriticalJustification(taskId, justification) {
            if (!taskIds.has(taskId))
                throw new Error(`Unknown task: ${taskId}.`);
            justifications[taskId] = justification;
        },
        validate: validationErrors,
        approve(approvedBy, approvedAt) {
            const errors = validationErrors();
            if (errors[0]) throw new Error(errors[0]);
            return {
                globalProfile,
                taskOverrides: { ...taskOverrides },
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
    private detailScroll = 0;
    private detailAutoFollow = true;
    private detailLineCount = 0;
    private bodyHeight = 8;
    private editingJustification = false;
    private readonly justificationInput = new Input();
    private errors: string[] = [];

    constructor(
        private readonly tui: TUI,
        private readonly theme: ReviewTheme,
        private readonly keybindings: KeybindingsManager,
        private readonly draft: DraftManifest,
        private readonly controller: ReviewController,
        private readonly done: (result: ManifestReviewOutcome) => void,
    ) {
        this.justificationInput.onSubmit = (value) => {
            const task = this.draft.tasks[this.selectedTask];
            if (task) this.controller.setCriticalJustification(task.id, value);
            this.editingJustification = false;
            this.tui.requestRender();
        };
        this.justificationInput.onEscape = () => {
            this.editingJustification = false;
            this.tui.requestRender();
        };
    }

    private moveSelection(delta: number): void {
        if (this.draft.tasks.length === 0) return;
        this.selectedTask = Math.max(
            0,
            Math.min(this.draft.tasks.length - 1, this.selectedTask + delta),
        );
        this.detailAutoFollow = true;
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
                const left = `${marker} ${glyph} ${task.id}: ${task.title}`;
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
        raw.push(`description: ${task.description}`);
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
        if (errors.length) {
            lines.push(this.theme.fg("error", "Validation errors:"));
            for (const error of errors)
                lines.push(this.theme.fg("error", `· ${error}`));
        } else {
            lines.push(this.theme.fg("success", "Validation: OK"));
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

    render(width: number): string[] {
        if (width < 36)
            return ["Manifest review needs ≥36 columns. Esc closes."];
        const theme = this.theme;
        const innerWidth = width - 2;
        const rows = this.tui.terminal?.rows ?? 32;
        const showValidation = rows >= 24;
        this.bodyHeight = Math.max(
            4,
            Math.min(30, Math.floor(rows * 0.85) - 6),
        );
        const rosterWidth = Math.max(
            22,
            Math.min(46, Math.floor((innerWidth - 1) * 0.38)),
        );
        const validationWidth = showValidation
            ? Math.max(20, Math.min(34, Math.floor((innerWidth - 1) * 0.22)))
            : 0;
        const dividers = showValidation ? 2 : 1;
        const detailWidth = Math.max(
            1,
            innerWidth - rosterWidth - validationWidth - dividers,
        );

        const state = this.controller.current;
        const border = theme.fg("border", "│");
        const lines: string[] = [];

        // Header box
        lines.push(theme.fg("border", `╭${"─".repeat(innerWidth)}╮`));
        lines.push(
            border +
                fit(
                    ` ${theme.bold("SDD manifest review")} ${theme.fg("dim", "· " + this.draft.planTitle)}`,
                    innerWidth,
                ) +
                border,
        );
        lines.push(
            border +
                fit(
                    ` ${theme.fg("muted", `duration: ${state.estimatedQualitativeDuration} · launches: ${state.maximumLaunches} · global: ${profileSeverity(theme, state.globalProfile)} · parallel: ${state.parallelismEnabled ? "on" : "off"}`)}`,
                    innerWidth,
                ) +
                border,
        );
        lines.push(
            border +
                fit(
                    ` ${theme.fg("muted", `Validation launches: qa=${state.qaLaunches}, browser=${state.browserLaunches}, total=${state.validationLaunches} (of profile budget ${state.profileLaunches})`)}`,
                    innerWidth,
                ) +
                border,
        );

        // Body separator
        const sepRow = showValidation
            ? theme.fg(
                  "border",
                  `├${"─".repeat(rosterWidth)}┬${"─".repeat(detailWidth)}┬${"─".repeat(validationWidth)}┤`,
              )
            : theme.fg(
                  "border",
                  `├${"─".repeat(rosterWidth)}┬${"─".repeat(detailWidth)}┤`,
              );
        lines.push(sepRow);

        const roster = this.rosterLines(rosterWidth, this.bodyHeight);
        const details = this.detailLines(detailWidth);
        this.detailLineCount = details.length;
        const maxDetailScroll = Math.max(0, details.length - this.bodyHeight);
        if (this.detailAutoFollow) this.detailScroll = maxDetailScroll;
        else if (this.detailScroll > maxDetailScroll)
            this.detailScroll = maxDetailScroll;
        const visibleDetails = details.slice(
            this.detailScroll,
            this.detailScroll + this.bodyHeight,
        );
        const validation = showValidation ? this.validationLines() : [];

        for (let i = 0; i < this.bodyHeight; i++) {
            let row =
                border +
                fit(roster[i] ?? "", rosterWidth) +
                theme.fg("border", "│");
            row += fit(visibleDetails[i] ?? "", detailWidth);
            if (showValidation) {
                row +=
                    theme.fg("border", "│") +
                    fit(validation[i] ?? "", validationWidth) +
                    border;
            } else {
                row += border;
            }
            lines.push(row);
        }

        // Footer
        const footerSep = showValidation
            ? theme.fg(
                  "border",
                  `├${"─".repeat(rosterWidth)}┴${"─".repeat(detailWidth)}┴${"─".repeat(validationWidth)}┤`,
              )
            : theme.fg(
                  "border",
                  `├${"─".repeat(rosterWidth)}┴${"─".repeat(detailWidth)}┤`,
              );
        lines.push(footerSep);
        const position = `${this.selectedTask + 1}/${this.draft.tasks.length}`;
        const footer = ` ↑↓/jk task · PgUp/PgDn detail · g global · o override · p parallel · i integration · c confirm · j justify · a approve · r return · ${position}`;
        lines.push(border + fit(theme.fg("dim", footer), innerWidth) + border);
        lines.push(theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));

        if (this.editingJustification) {
            lines.push("", "Critical downgrade justification:");
            lines.push(...this.justificationInput.render(width));
        }
        return lines.map((line) => truncateToWidth(line, width));
    }

    handleInput(data: string): void {
        if (this.editingJustification) {
            this.justificationInput.handleInput(data);
            this.tui.requestRender();
            return;
        }
        if (this.keybindings.matches(data, "tui.select.cancel")) {
            this.done({ type: "cancel" });
            return;
        }
        if (
            this.keybindings.matches(data, "tui.select.up") ||
            matchesKey(data, "k")
        ) {
            return this.moveSelection(-1);
        }
        if (
            this.keybindings.matches(data, "tui.select.down") ||
            matchesKey(data, "j")
        ) {
            return this.moveSelection(1);
        }
        if (matchesKey(data, "pageUp")) {
            this.detailAutoFollow = false;
            this.detailScroll = Math.max(
                0,
                this.detailScroll - this.bodyHeight,
            );
            this.tui.requestRender();
            return;
        }
        if (matchesKey(data, "pageDown")) {
            const maxScroll = Math.max(
                0,
                this.detailLineCount - this.bodyHeight,
            );
            this.detailScroll = Math.min(
                maxScroll,
                this.detailScroll + this.bodyHeight,
            );
            this.detailAutoFollow = this.detailScroll >= maxScroll;
            this.tui.requestRender();
            return;
        }
        if (matchesKey(data, "home")) {
            this.detailAutoFollow = false;
            this.detailScroll = 0;
            this.tui.requestRender();
            return;
        }
        if (matchesKey(data, "end")) {
            this.detailScroll = Math.max(
                0,
                this.detailLineCount - this.bodyHeight,
            );
            this.detailAutoFollow = true;
            this.tui.requestRender();
            return;
        }
        if (data === "g") {
            const current = PROFILES.indexOf(
                this.controller.current.globalProfile,
            );
            this.controller.setGlobalProfile(
                PROFILES[(current + 1) % PROFILES.length],
            );
        } else if (data === "p") {
            this.controller.setParallelism(
                !this.controller.current.parallelismEnabled,
            );
        } else if (data === "i") {
            this.controller.setFinalIntegrationReview(
                !this.controller.current.finalIntegrationReview,
            );
        } else if (data === "o") {
            const task = this.draft.tasks[this.selectedTask];
            if (task) {
                const current = this.controller.current.taskOverrides[task.id];
                const options: Array<Profile | undefined> = [
                    undefined,
                    ...PROFILES,
                ];
                this.controller.setTaskOverride(
                    task.id,
                    options[(options.indexOf(current) + 1) % options.length],
                );
            }
        } else if (data === "c") {
            const task = this.draft.tasks[this.selectedTask];
            if (task) this.controller.confirmCriticalDowngrade(task.id, true);
        } else if (data === "j") {
            const task = this.draft.tasks[this.selectedTask];
            if (task) {
                this.justificationInput.setValue(
                    this.controller.current.criticalDowngradeJustifications[
                        task.id
                    ] ?? "",
                );
                this.justificationInput.focused = true;
                this.editingJustification = true;
            }
        } else if (data === "r") {
            this.done({ type: "return_to_planning" });
            return;
        } else if (data === "a") {
            this.errors = this.controller.validate();
            if (!this.errors.length) {
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

export async function openManifestReview(
    ctx: ExtensionContext,
    draft: DraftManifest,
): Promise<ManifestReviewOutcome> {
    if (ctx.mode !== "tui") {
        throw new Error("Manifest review overlay requires TUI mode.");
    }
    const controller = createReviewController(draft);
    return ctx.ui.custom<ManifestReviewOutcome>(
        (tui, theme, keybindings, done) =>
            new ManifestReviewComponent(
                tui,
                theme,
                keybindings,
                draft,
                controller,
                done,
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
