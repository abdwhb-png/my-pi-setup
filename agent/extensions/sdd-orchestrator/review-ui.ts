import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
    Input,
    type Component,
    type KeybindingsManager,
    type TUI,
} from '@earendil-works/pi-tui';
import {
    calculateLaunchPreview,
    type DraftManifest,
    type LaunchPreview,
    type ManifestDecision,
} from './manifest.ts';
import { PROFILES, type Profile } from './types.ts';

export type QualitativeDuration =
    | 'manual-only'
    | 'short'
    | 'moderate'
    | 'extended';

const QUALITATIVE_DURATIONS = [
    'manual-only',
    'short',
    'moderate',
    'extended',
] as const satisfies readonly QualitativeDuration[];

export function estimateQualitativeDuration(
    tasks: DraftManifest['tasks'],
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
    if (tasks.length === 0) return 'manual-only';

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
    return QUALITATIVE_DURATIONS[tier] ?? 'extended';
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
                task.recommendedProfile !== 'critical' ||
                (profile !== 'direct' && profile !== 'light')
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
    | { readonly type: 'approve'; readonly decision: ManifestDecision }
    | { readonly type: 'return_to_planning' }
    | { readonly type: 'cancel' };

class ManifestReviewComponent implements Component {
    private selectedTask = 0;
    private editingJustification = false;
    private readonly justificationInput = new Input();
    private errors: string[] = [];

    constructor(
        private readonly tui: TUI,
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

    render(_width: number): string[] {
        const state = this.controller.current;
        const lines = [
            `SDD manifest review: ${this.draft.planTitle}`,
            `Digest: ${this.draft.sourceDigest}`,
            `Global profile [g]: ${state.globalProfile}`,
            `Parallel writers [p]: ${state.parallelismEnabled ? 'enabled' : 'disabled'}`,
            `Estimated qualitative duration: ${state.estimatedQualitativeDuration}`,
            `Maximum launches: ${state.maximumLaunches}`,
            `Validation launches: qa=${state.qaLaunches}, browser=${state.browserLaunches}, total=${state.validationLaunches} (of profile budget ${state.profileLaunches})`,
            `Final integration review: ${state.finalIntegrationReview ? 'required' : 'not required'}`,
            '',
        ];
        for (const [index, task] of this.draft.tasks.entries()) {
            const effective =
                state.taskOverrides[task.id] ?? state.globalProfile;
            lines.push(
                `${index === this.selectedTask ? '>' : ' '} ${task.id}: ${task.title}`,
                `  recommended=${task.recommendedProfile} effective=${effective} parallel=${task.parallelEligible ? 'yes' : 'no'}`,
                `  dependencies=${task.dependencies.join(', ') || 'none'}`,
                `  rules=${task.classificationRules.join(', ') || 'none'}`,
            );
            if (
                task.recommendedProfile === 'critical' &&
                (effective === 'direct' || effective === 'light')
            ) {
                lines.push(
                    `  CRITICAL DOWNGRADE confirmed=${state.criticalDowngradeConfirmations[task.id] ? 'yes' : 'no'}`,
                    `  justification=${state.criticalDowngradeJustifications[task.id] || '(required)'}`,
                );
            }
            if (task.qa?.length) {
                lines.push(`  validation=QA launch (${task.qa.length})`);
            }
        }
        lines.push(
            '',
            '[up/down] task  [g] global  [o] override  [p] parallel  [i] integration',
            '[c] confirm downgrade  [j] justification  [a] approve',
            '[r] return to planning  [esc] cancel',
        );
        if (this.editingJustification) {
            lines.push('', 'Critical downgrade justification:');
            lines.push(...this.justificationInput.render(_width));
        }
        if (this.errors.length) lines.push('', ...this.errors);
        return lines;
    }

    handleInput(data: string): void {
        if (this.editingJustification) {
            this.justificationInput.handleInput(data);
            this.tui.requestRender();
            return;
        }
        if (this.keybindings.matches(data, 'tui.select.cancel')) {
            this.done({ type: 'cancel' });
            return;
        }
        if (this.keybindings.matches(data, 'tui.select.up')) {
            this.selectedTask = Math.max(0, this.selectedTask - 1);
        } else if (this.keybindings.matches(data, 'tui.select.down')) {
            this.selectedTask = Math.min(
                this.draft.tasks.length - 1,
                this.selectedTask + 1,
            );
        } else if (data === 'g') {
            const current = PROFILES.indexOf(
                this.controller.current.globalProfile,
            );
            this.controller.setGlobalProfile(
                PROFILES[(current + 1) % PROFILES.length],
            );
        } else if (data === 'p') {
            this.controller.setParallelism(
                !this.controller.current.parallelismEnabled,
            );
        } else if (data === 'i') {
            this.controller.setFinalIntegrationReview(
                !this.controller.current.finalIntegrationReview,
            );
        } else if (data === 'o') {
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
        } else if (data === 'c') {
            const task = this.draft.tasks[this.selectedTask];
            if (task) this.controller.confirmCriticalDowngrade(task.id, true);
        } else if (data === 'j') {
            const task = this.draft.tasks[this.selectedTask];
            if (task) {
                this.justificationInput.setValue(
                    this.controller.current.criticalDowngradeJustifications[
                        task.id
                    ] ?? '',
                );
                this.justificationInput.focused = true;
                this.editingJustification = true;
            }
        } else if (data === 'r') {
            this.done({ type: 'return_to_planning' });
            return;
        } else if (data === 'a') {
            this.errors = this.controller.validate();
            if (!this.errors.length) {
                this.done({
                    type: 'approve',
                    decision: this.controller.approve(
                        'interactive',
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
    if (ctx.mode !== 'tui') {
        throw new Error('Manifest review overlay requires TUI mode.');
    }
    const controller = createReviewController(draft);
    return ctx.ui.custom<ManifestReviewOutcome>(
        (tui, _theme, keybindings, done) =>
            new ManifestReviewComponent(
                tui,
                keybindings,
                draft,
                controller,
                done,
            ),
        { overlay: true },
    );
}
