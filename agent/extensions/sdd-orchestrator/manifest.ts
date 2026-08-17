import { createHash } from "node:crypto";
import type { Assessment, TaskAssessment } from "./assessment.ts";
import { classifyTask, effectiveProfile } from "./classification.ts";
import type { SddConfig } from "./config.ts";
import {
    PROFILES,
    type ParsedPlan,
    type Profile,
    type VerifyCommand,
    type QaCommand,
    type BrowserScenario,
} from "./types.ts";

export interface ProfileBudget {
    readonly initialWorkers: number;
    readonly correctionWorkers: number;
    readonly reviewerAttempts: number;
    readonly maxLaunches: number;
}

export interface DraftManifestTask {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly recommendedProfile: Profile;
    readonly effectiveProfile: Profile;
    readonly classificationRules: readonly string[];
    readonly signals: readonly TaskAssessment["signals"][number][];
    readonly dependencies: readonly string[];
    readonly files: readonly string[];
    readonly verify: readonly VerifyCommand[];
    readonly qa?: readonly QaCommand[];
    readonly browser?: readonly BrowserScenario[];
    readonly budgets: ProfileBudget;
    readonly parallelEligible: boolean;
}

export interface DraftManifest {
    readonly manifestId: string;
    readonly manifestVersion: 1;
    readonly ruleSetVersion: 1;
    readonly state: "awaiting_approval";
    readonly planTitle: string;
    readonly planPath: string;
    readonly sourceDigest: string;
    readonly assessmentDigest: string;
    readonly assessorModel: string;
    readonly globalProfile: Profile;
    readonly parallelismEnabled: boolean;
    readonly maxConcurrentWriters: number;
    readonly finalIntegrationReview: boolean;
    readonly profileLaunches?: number;
    readonly qaLaunches?: number;
    readonly browserLaunches?: number;
    readonly validationLaunches?: number;
    readonly maximumLaunches: number;
    readonly tasks: readonly DraftManifestTask[];
}

export interface ManifestDecision {
    readonly globalProfile: Profile;
    readonly taskOverrides: Readonly<Record<string, Profile>>;
    readonly parallelismEnabled: boolean;
    readonly finalIntegrationReview?: boolean;
    readonly criticalDowngradeConfirmations: Readonly<Record<string, boolean>>;
    readonly criticalDowngradeJustifications: Readonly<Record<string, string>>;
    readonly approvedBy: string;
    readonly approvedAt: string;
}

export type ApprovedManifestTask = DraftManifestTask;

export type ApprovedManifest = Omit<DraftManifest, "state" | "tasks"> & {
    readonly state: "approved";
    readonly tasks: readonly ApprovedManifestTask[];
    readonly decision: ManifestDecision;
    readonly approvalDigest: string;
};

const PROFILE_BUDGETS: Record<Profile, Readonly<ProfileBudget>> = {
    direct: Object.freeze({
        initialWorkers: 0,
        correctionWorkers: 0,
        reviewerAttempts: 0,
        maxLaunches: 0,
    }),
    light: Object.freeze({
        initialWorkers: 1,
        correctionWorkers: 0,
        reviewerAttempts: 0,
        maxLaunches: 1,
    }),
    standard: Object.freeze({
        initialWorkers: 1,
        correctionWorkers: 1,
        reviewerAttempts: 2,
        maxLaunches: 4,
    }),
    critical: Object.freeze({
        initialWorkers: 1,
        correctionWorkers: 2,
        reviewerAttempts: 4,
        maxLaunches: 7,
    }),
};

const SHARED_CONTRACT_SIGNALS = [
    "shared_infrastructure",
    "pi_core_behavior",
    "inter_extension_protocol",
] as const;

const CROSS_MODULE_SIGNALS = ["multi_module", "external_integration"] as const;

export function budgetsFor(profile: Profile): ProfileBudget {
    return PROFILE_BUDGETS[profile];
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (value && typeof value === "object") {
        return `{${Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .toSorted(([left], [right]) =>
                left < right ? -1 : left > right ? 1 : 0,
            )
            .map(
                ([key, entry]) =>
                    `${JSON.stringify(key)}:${canonicalJson(entry)}`,
            )
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

function digest(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

export function approvalDecisionDigest(decision: ManifestDecision): string {
    const { approvedAt: _approvedAt, ...retryStableDecision } = decision;
    return digest(canonicalJson(retryStableDecision));
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

function isProfile(value: unknown): value is Profile {
    return (
        typeof value === "string" &&
        PROFILES.some((profile) => profile === value)
    );
}

function collectFileOwners(
    tasks: ReadonlyArray<{ id: string; files: readonly string[] }>,
): Map<string, Set<string>> {
    const fileOwners = new Map<string, Set<string>>();
    for (const task of tasks) {
        for (const file of task.files) {
            const owners = fileOwners.get(file) ?? new Set<string>();
            owners.add(task.id);
            fileOwners.set(file, owners);
        }
    }
    return fileOwners;
}

function canRunInParallel(
    task: {
        dependencies: readonly string[];
        files: readonly string[];
        signals: readonly TaskAssessment["signals"][number][];
    },
    fileOwners: ReadonlyMap<string, ReadonlySet<string>>,
    parallelismEnabled: boolean,
): boolean {
    return (
        parallelismEnabled &&
        task.dependencies.length === 0 &&
        !task.files.some((file) => (fileOwners.get(file)?.size ?? 0) > 1) &&
        !SHARED_CONTRACT_SIGNALS.some((signal) => task.signals.includes(signal))
    );
}

function requiresFinalIntegrationReview(
    tasks: ReadonlyArray<{
        effectiveProfile: Profile;
        signals: readonly TaskAssessment["signals"][number][];
    }>,
): boolean {
    if (tasks.some((task) => task.effectiveProfile === "critical")) return true;
    if (
        tasks.filter((task) =>
            SHARED_CONTRACT_SIGNALS.some((signal) =>
                task.signals.includes(signal),
            ),
        ).length >= 2
    ) {
        return true;
    }
    return tasks.some((task) =>
        CROSS_MODULE_SIGNALS.some((signal) => task.signals.includes(signal)),
    );
}

export interface LaunchPreview {
    readonly finalIntegrationReview: boolean;
    readonly profileLaunches: number;
    readonly qaLaunches: number;
    readonly browserLaunches: number;
    readonly validationLaunches: number;
    readonly maximumLaunches: number;
}

function countValidationLaunches(
    tasks: ReadonlyArray<{
        qa?: readonly QaCommand[];
        browser?: readonly BrowserScenario[];
    }>,
): {
    readonly qaLaunches: number;
    readonly browserLaunches: number;
    readonly validationLaunches: number;
} {
    const qaLaunches = tasks.filter((task) => task.qa?.length).length;
    const browserLaunches = tasks.some((task) => task.browser?.length) ? 1 : 0;
    return {
        qaLaunches,
        browserLaunches,
        validationLaunches: qaLaunches + browserLaunches,
    };
}

export function calculateLaunchPreview(
    tasks: readonly DraftManifestTask[],
    effectiveProfiles: Readonly<Record<string, Profile>> = {},
    requestedIntegrationReview = false,
): LaunchPreview {
    const profiled = tasks.map((task) => ({
        ...task,
        effectiveProfile: effectiveProfiles[task.id] ?? task.effectiveProfile,
    }));
    const finalIntegrationReview =
        requiresFinalIntegrationReview(profiled) || requestedIntegrationReview;
    const validation = countValidationLaunches(tasks);
    const profileLaunches = profiled.reduce(
        (sum, task) => sum + budgetsFor(task.effectiveProfile).maxLaunches,
        0,
    );
    return {
        finalIntegrationReview,
        profileLaunches,
        qaLaunches: validation.qaLaunches,
        browserLaunches: validation.browserLaunches,
        validationLaunches: validation.validationLaunches,
        maximumLaunches:
            profileLaunches +
            validation.validationLaunches +
            (finalIntegrationReview ? 1 : 0),
    };
}

function validateAssessmentTaskIds(
    parsedPlan: ParsedPlan,
    assessment: Assessment,
): void {
    const planIds = new Set(parsedPlan.tasks.map((task) => task.id));
    const assessmentIds = new Set<string>();
    const duplicates: string[] = [];
    for (const task of assessment.tasks) {
        if (
            assessmentIds.has(task.taskId) &&
            !duplicates.includes(task.taskId)
        ) {
            duplicates.push(task.taskId);
        }
        assessmentIds.add(task.taskId);
    }
    const missing = [...planIds].filter((id) => !assessmentIds.has(id));
    const unknown = [...assessmentIds].filter((id) => !planIds.has(id));
    const issues = [
        ...duplicates.map((id) => `duplicate ${id}`),
        ...missing.map((id) => `missing ${id}`),
        ...unknown.map((id) => `unknown ${id}`),
    ];
    if (issues.length) {
        throw new Error(`Assessment task IDs mismatch: ${issues.join("; ")}.`);
    }
}

function validateDependencies(parsedPlan: ParsedPlan): void {
    const dependencies = new Map(
        parsedPlan.tasks.map((task) => [task.id, task.dependsOn] as const),
    );
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const path: string[] = [];

    const visit = (taskId: string): void => {
        if (visited.has(taskId)) return;
        if (visiting.has(taskId)) {
            const cycleStart = path.indexOf(taskId);
            throw new Error(
                `Dependency cycle: ${[...path.slice(cycleStart), taskId].join(
                    " -> ",
                )}.`,
            );
        }
        visiting.add(taskId);
        path.push(taskId);
        for (const dependency of dependencies.get(taskId) ?? []) {
            if (dependencies.has(dependency)) visit(dependency);
        }
        path.pop();
        visiting.delete(taskId);
        visited.add(taskId);
    };

    for (const task of parsedPlan.tasks) visit(task.id);
}

export function compileManifest(input: {
    planPath: string;
    planContent: string;
    parsedPlan: ParsedPlan;
    assessment: Assessment;
    globalProfile: Profile;
    parallelismEnabled: boolean;
    config: SddConfig;
}): DraftManifest {
    validateAssessmentTaskIds(input.parsedPlan, input.assessment);
    validateDependencies(input.parsedPlan);
    const fileOwners = collectFileOwners(input.parsedPlan.tasks);

    const tasks = input.parsedPlan.tasks.map((task): DraftManifestTask => {
        const taskAssessment = input.assessment.tasks.find(
            (candidate) => candidate.taskId === task.id,
        );
        if (!taskAssessment) {
            throw new Error(`Assessment is missing ${task.id}.`);
        }
        const classification = classifyTask(taskAssessment);
        const recommendedProfile = effectiveProfile(
            input.globalProfile,
            classification,
            taskAssessment,
        );
        return {
            id: task.id,
            title: task.title,
            description: task.body,
            recommendedProfile,
            effectiveProfile: recommendedProfile,
            classificationRules: [...classification.rules],
            signals: [...taskAssessment.signals],
            dependencies: [...task.dependsOn],
            files: [...task.files],
            verify: task.verify.map((command) => ({ ...command })),
            qa: task.qa?.map((command) => ({ ...command })),
            browser: task.browser?.map((scenario) => ({
                ...scenario,
                preconditions: [...scenario.preconditions],
                steps: [...scenario.steps],
                expected: [...scenario.expected],
                cleanup: scenario.cleanup ? [...scenario.cleanup] : undefined,
            })),
            budgets: budgetsFor(recommendedProfile),
            parallelEligible: canRunInParallel(
                {
                    dependencies: task.dependsOn,
                    files: task.files,
                    signals: taskAssessment.signals,
                },
                fileOwners,
                input.parallelismEnabled,
            ),
        };
    });
    const preview = calculateLaunchPreview(tasks);
    const data = {
        manifestVersion: 1 as const,
        ruleSetVersion: 1 as const,
        state: "awaiting_approval" as const,
        planTitle: input.parsedPlan.title,
        planPath: input.planPath,
        sourceDigest: digest(input.planContent),
        assessmentDigest: digest(canonicalJson(input.assessment)),
        assessorModel: input.assessment.assessorModel,
        globalProfile: input.globalProfile,
        parallelismEnabled: input.parallelismEnabled,
        maxConcurrentWriters: input.config.maxConcurrentWriters,
        ...preview,
        tasks,
    };
    return { manifestId: digest(canonicalJson(data)), ...data };
}

export function applyApproval(
    draft: DraftManifest,
    decision: ManifestDecision,
    currentPlanContent: string,
): ApprovedManifest {
    if (digest(currentPlanContent) !== draft.sourceDigest) {
        throw new Error("Source plan changed after manifest compilation.");
    }
    if (!decision.approvedBy.trim()) {
        throw new Error("approvedBy must be non-empty.");
    }
    if (!decision.approvedAt.trim()) {
        throw new Error("approvedAt must be non-empty.");
    }
    if (!isProfile(decision.globalProfile)) {
        throw new Error(`Invalid profile: ${String(decision.globalProfile)}.`);
    }
    const taskIds = new Set(draft.tasks.map((task) => task.id));
    for (const [taskId, profile] of Object.entries(decision.taskOverrides)) {
        if (!taskIds.has(taskId)) {
            throw new Error(`Unknown task override: ${taskId}.`);
        }
        if (!isProfile(profile)) {
            throw new Error(`Invalid profile: ${String(profile)}.`);
        }
    }
    for (const taskId of Object.keys(decision.criticalDowngradeConfirmations)) {
        if (!taskIds.has(taskId)) {
            throw new Error(
                `Unknown critical downgrade confirmation: ${taskId}.`,
            );
        }
    }
    for (const taskId of Object.keys(
        decision.criticalDowngradeJustifications,
    )) {
        if (!taskIds.has(taskId)) {
            throw new Error(
                `Unknown critical downgrade justification: ${taskId}.`,
            );
        }
    }

    for (const task of draft.tasks) {
        const profile =
            decision.taskOverrides[task.id] ?? decision.globalProfile;
        if (
            task.recommendedProfile === "critical" &&
            (profile === "light" || profile === "direct")
        ) {
            if (!decision.criticalDowngradeConfirmations[task.id]) {
                throw new Error(
                    `Critical downgrade for ${task.id} requires confirmation.`,
                );
            }
            if (!decision.criticalDowngradeJustifications[task.id]?.trim()) {
                throw new Error(
                    `Critical downgrade for ${task.id} requires a justification.`,
                );
            }
        }
    }

    const fileOwners = collectFileOwners(draft.tasks);
    const tasks = draft.tasks.map((task): ApprovedManifestTask => {
        const approvedProfile =
            decision.taskOverrides[task.id] ?? decision.globalProfile;
        return {
            ...task,
            classificationRules: [...task.classificationRules],
            signals: [...task.signals],
            dependencies: [...task.dependencies],
            files: [...task.files],
            verify: task.verify.map((command) => ({ ...command })),
            qa: task.qa?.map((command) => ({ ...command })),
            browser: task.browser?.map((scenario) => ({
                ...scenario,
                preconditions: [...scenario.preconditions],
                steps: [...scenario.steps],
                expected: [...scenario.expected],
                cleanup: scenario.cleanup ? [...scenario.cleanup] : undefined,
            })),
            effectiveProfile: approvedProfile,
            budgets: budgetsFor(approvedProfile),
            parallelEligible: canRunInParallel(
                task,
                fileOwners,
                decision.parallelismEnabled,
            ),
        };
    });
    const approvedDecision: ManifestDecision = {
        globalProfile: decision.globalProfile,
        taskOverrides: { ...decision.taskOverrides },
        parallelismEnabled: decision.parallelismEnabled,
        finalIntegrationReview: decision.finalIntegrationReview,
        criticalDowngradeConfirmations: {
            ...decision.criticalDowngradeConfirmations,
        },
        criticalDowngradeJustifications: {
            ...decision.criticalDowngradeJustifications,
        },
        approvedBy: decision.approvedBy,
        approvedAt: decision.approvedAt,
    };
    const preview = calculateLaunchPreview(
        tasks,
        Object.fromEntries(
            tasks.map((task) => [task.id, task.effectiveProfile]),
        ),
        decision.finalIntegrationReview === true,
    );
    const approved = {
        manifestId: draft.manifestId,
        manifestVersion: draft.manifestVersion,
        ruleSetVersion: draft.ruleSetVersion,
        state: "approved" as const,
        planTitle: draft.planTitle,
        planPath: draft.planPath,
        sourceDigest: draft.sourceDigest,
        assessmentDigest: draft.assessmentDigest,
        assessorModel: draft.assessorModel,
        globalProfile: decision.globalProfile,
        parallelismEnabled: decision.parallelismEnabled,
        maxConcurrentWriters: draft.maxConcurrentWriters,
        ...preview,
        tasks,
        decision: approvedDecision,
    };
    return deepFreeze({
        ...approved,
        approvalDigest: digest(canonicalJson(approved)),
    });
}
