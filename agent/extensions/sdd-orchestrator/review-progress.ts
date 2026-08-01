import type { ApprovedManifest, DraftManifest } from "./manifest.ts";
import { PROFILES, type Profile } from "./types.ts";

export interface ReviewDecisionDraft {
    readonly globalProfile: Profile;
    readonly taskOverrides: Readonly<Record<string, Profile>>;
    readonly parallelismEnabled: boolean;
    readonly finalIntegrationReview: boolean;
    readonly criticalDowngradeConfirmations: Readonly<Record<string, boolean>>;
    readonly criticalDowngradeJustifications: Readonly<Record<string, string>>;
}

export interface ManifestReviewProgressState {
    readonly acceptedTaskIds: readonly string[];
    readonly decision: ReviewDecisionDraft;
}

export interface ManifestReviewProgressV1 extends ManifestReviewProgressState {
    readonly version: 1;
    readonly manifestId: string;
    readonly revision: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object") {
        return false;
    }
    try {
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    } catch {
        return false;
    }
}

function hasExactlyKeys(
    value: Record<string, unknown>,
    expected: readonly string[],
): boolean {
    const keys = Object.keys(value);
    return (
        keys.length === expected.length &&
        keys.every((key) => expected.includes(key))
    );
}

function isProfile(value: unknown): value is Profile {
    return (
        typeof value === "string" &&
        PROFILES.some((profile) => profile === value)
    );
}

const UNSAFE_MAP_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assertSafeMapKey(key: string, field: string): void {
    if (UNSAFE_MAP_KEYS.has(key)) {
        throw new Error(`Unsafe review progress ${field} key: ${key}.`);
    }
}

function parseProfileMap(
    value: unknown,
    field: string,
): Readonly<Record<string, Profile>> {
    if (!isPlainRecord(value)) {
        throw new Error(
            `Invalid review progress ${field}: expected a plain object.`,
        );
    }
    const result: Record<string, Profile> = {};
    for (const [key, profile] of Object.entries(value)) {
        assertSafeMapKey(key, field);
        if (!isProfile(profile)) {
            throw new Error(
                `Invalid review progress ${field}.${key}: invalid profile.`,
            );
        }
        result[key] = profile;
    }
    return result;
}

function parseBooleanMap(
    value: unknown,
    field: string,
): Readonly<Record<string, boolean>> {
    if (!isPlainRecord(value)) {
        throw new Error(
            `Invalid review progress ${field}: expected a plain object.`,
        );
    }
    const result: Record<string, boolean> = {};
    for (const [key, confirmed] of Object.entries(value)) {
        assertSafeMapKey(key, field);
        if (typeof confirmed !== "boolean") {
            throw new Error(
                `Invalid review progress ${field}.${key}: expected a boolean.`,
            );
        }
        result[key] = confirmed;
    }
    return result;
}

function parseStringMap(
    value: unknown,
    field: string,
): Readonly<Record<string, string>> {
    if (!isPlainRecord(value)) {
        throw new Error(
            `Invalid review progress ${field}: expected a plain object.`,
        );
    }
    const result: Record<string, string> = {};
    for (const [key, justification] of Object.entries(value)) {
        assertSafeMapKey(key, field);
        if (typeof justification !== "string") {
            throw new Error(
                `Invalid review progress ${field}.${key}: expected a string.`,
            );
        }
        result[key] = justification;
    }
    return result;
}

function parseAcceptedTaskIds(value: unknown): readonly string[] {
    if (!Array.isArray(value)) {
        throw new Error('Invalid review progress acceptedTaskIds.');
    }
    const acceptedTaskIds: string[] = [];
    const seen = new Set<string>();
    for (const taskId of value) {
        if (typeof taskId !== 'string' || !taskId || seen.has(taskId)) {
            throw new Error('Invalid review progress acceptedTaskIds.');
        }
        seen.add(taskId);
        acceptedTaskIds.push(taskId);
    }
    return acceptedTaskIds;
}

function parseReviewProgressState(value: unknown): ManifestReviewProgressState {
    if (
        !isPlainRecord(value) ||
        !hasExactlyKeys(value, ['acceptedTaskIds', 'decision'])
    ) {
        throw new Error('Invalid review progress state.');
    }
    return {
        acceptedTaskIds: parseAcceptedTaskIds(value.acceptedTaskIds),
        decision: parseDecision(value.decision),
    };
}

function parseDecision(value: unknown): ReviewDecisionDraft {
    if (
        !isPlainRecord(value) ||
        !hasExactlyKeys(value, [
            "globalProfile",
            "taskOverrides",
            "parallelismEnabled",
            "finalIntegrationReview",
            "criticalDowngradeConfirmations",
            "criticalDowngradeJustifications",
        ])
    ) {
        throw new Error("Invalid review progress decision.");
    }
    if (!isProfile(value.globalProfile)) {
        throw new Error("Invalid review progress decision.globalProfile.");
    }
    if (typeof value.parallelismEnabled !== "boolean") {
        throw new Error("Invalid review progress decision.parallelismEnabled.");
    }
    if (typeof value.finalIntegrationReview !== "boolean") {
        throw new Error(
            "Invalid review progress decision.finalIntegrationReview.",
        );
    }
    return {
        globalProfile: value.globalProfile,
        taskOverrides: parseProfileMap(
            value.taskOverrides,
            "decision.taskOverrides",
        ),
        parallelismEnabled: value.parallelismEnabled,
        finalIntegrationReview: value.finalIntegrationReview,
        criticalDowngradeConfirmations: parseBooleanMap(
            value.criticalDowngradeConfirmations,
            "decision.criticalDowngradeConfirmations",
        ),
        criticalDowngradeJustifications: parseStringMap(
            value.criticalDowngradeJustifications,
            "decision.criticalDowngradeJustifications",
        ),
    };
}

export function parseReviewProgress(value: unknown): ManifestReviewProgressV1 {
    if (
        !isPlainRecord(value) ||
        !hasExactlyKeys(value, [
            "version",
            "manifestId",
            "revision",
            "acceptedTaskIds",
            "decision",
        ])
    ) {
        throw new Error("Invalid review progress object.");
    }
    if (value.version !== 1) {
        throw new Error(
            `Unsupported review progress version: ${String(value.version)}.`,
        );
    }
    if (
        typeof value.manifestId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value.manifestId)
    ) {
        throw new Error("Invalid review progress manifestId.");
    }
    if (typeof value.revision !== 'number') {
        throw new Error("Invalid review progress revision.");
    }
    const revision = value.revision;
    if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new Error("Invalid review progress revision.");
    }
    const state = parseReviewProgressState({
        acceptedTaskIds: value.acceptedTaskIds,
        decision: value.decision,
    });
    return {
        version: 1,
        manifestId: value.manifestId,
        revision,
        ...state,
    };
}

function assertKnownTaskKeys(
    values: Readonly<Record<string, unknown>>,
    taskIds: ReadonlySet<string>,
    field: string,
): void {
    for (const taskId of Object.keys(values)) {
        if (!taskIds.has(taskId)) {
            throw new Error(
                `Unknown review progress ${field} task: ${taskId}.`,
            );
        }
    }
}

export function normalizeReviewProgressState(
    draft: DraftManifest | ApprovedManifest,
    state: ManifestReviewProgressState,
): ManifestReviewProgressState {
    const parsed = parseReviewProgressState(state);
    const taskIds = new Set(draft.tasks.map((task) => task.id));
    for (const taskId of parsed.acceptedTaskIds) {
        if (!taskIds.has(taskId)) {
            throw new Error(
                `Unknown review progress accepted task: ${taskId}.`,
            );
        }
    }
    assertKnownTaskKeys(parsed.decision.taskOverrides, taskIds, "override");
    assertKnownTaskKeys(
        parsed.decision.criticalDowngradeConfirmations,
        taskIds,
        "confirmation",
    );
    assertKnownTaskKeys(
        parsed.decision.criticalDowngradeJustifications,
        taskIds,
        "justification",
    );
    const accepted = new Set(parsed.acceptedTaskIds);
    const copyTaskMap = <T>(values: Readonly<Record<string, T>>): Record<string, T> => {
        const result: Record<string, T> = {};
        for (const task of draft.tasks) {
            if (Object.hasOwn(values, task.id)) {
                result[task.id] = values[task.id];
            }
        }
        return result;
    };
    return {
        acceptedTaskIds: draft.tasks
            .map((task) => task.id)
            .filter((taskId) => accepted.has(taskId)),
        decision: {
            globalProfile: parsed.decision.globalProfile,
            taskOverrides: copyTaskMap(parsed.decision.taskOverrides),
            parallelismEnabled: parsed.decision.parallelismEnabled,
            finalIntegrationReview: parsed.decision.finalIntegrationReview,
            criticalDowngradeConfirmations: copyTaskMap(
                parsed.decision.criticalDowngradeConfirmations,
            ),
            criticalDowngradeJustifications: copyTaskMap(
                parsed.decision.criticalDowngradeJustifications,
            ),
        },
    };
}

export function createInitialReviewProgress(
    draft: DraftManifest,
): ManifestReviewProgressV1 {
    return {
        version: 1,
        manifestId: draft.manifestId,
        revision: 0,
        acceptedTaskIds: draft.tasks.map((task) => task.id),
        decision: {
            globalProfile: draft.globalProfile,
            taskOverrides: Object.fromEntries(
                draft.tasks
                    .filter(
                        (task) =>
                            task.recommendedProfile !== draft.globalProfile,
                    )
                    .map((task) => [task.id, task.recommendedProfile]),
            ),
            parallelismEnabled: draft.parallelismEnabled,
            finalIntegrationReview: draft.finalIntegrationReview,
            criticalDowngradeConfirmations: {},
            criticalDowngradeJustifications: {},
        },
    };
}
