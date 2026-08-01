import { expect, test } from 'bun:test';
import {
    createInitialReviewProgress,
    normalizeReviewProgressState,
    parseReviewProgress,
} from './review-progress.ts';
import type { DraftManifest } from './manifest.ts';

function draft(): DraftManifest {
    return {
        manifestId: 'manifest-1',
        manifestVersion: 1,
        ruleSetVersion: 1,
        state: 'awaiting_approval',
        planTitle: 'Reviewable plan',
        planPath: '/repo/plan.md',
        sourceDigest: 'source',
        assessmentDigest: 'assessment',
        assessorModel: 'model',
        globalProfile: 'light',
        parallelismEnabled: true,
        maxConcurrentWriters: 2,
        finalIntegrationReview: true,
        maximumLaunches: 0,
        tasks: [
            {
                id: 'task-1',
                title: 'First',
                description: '',
                recommendedProfile: 'critical',
                effectiveProfile: 'critical',
                classificationRules: [],
                signals: [],
                dependencies: [],
                files: [],
                verify: [],
                budgets: { initialWorkers: 1, correctionWorkers: 2, reviewerAttempts: 4, maxLaunches: 7 },
                parallelEligible: true,
            },
            {
                id: 'task-2',
                title: 'Second',
                description: '',
                recommendedProfile: 'light',
                effectiveProfile: 'light',
                classificationRules: [],
                signals: [],
                dependencies: [],
                files: [],
                verify: [],
                budgets: { initialWorkers: 1, correctionWorkers: 0, reviewerAttempts: 0, maxLaunches: 1 },
                parallelEligible: true,
            },
        ],
    };
}

test('creates the review state from the draft without mutating it', () => {
    const source = draft();

    const progress = createInitialReviewProgress(source);

    expect(progress).toEqual({
        version: 1,
        manifestId: 'manifest-1',
        revision: 0,
        acceptedTaskIds: ['task-1', 'task-2'],
        decision: {
            globalProfile: 'light',
            taskOverrides: { 'task-1': 'critical' },
            parallelismEnabled: true,
            finalIntegrationReview: true,
            criticalDowngradeConfirmations: {},
            criticalDowngradeJustifications: {},
        },
    });
    expect(source.tasks[0]?.recommendedProfile).toBe('critical');
});

function reviewStateFromProgress(state: ReturnType<typeof createInitialReviewProgress>) {
    return {
        acceptedTaskIds: state.acceptedTaskIds,
        decision: state.decision,
    };
}

test('normalizes review state in draft order and rejects invalid task state', () => {
    const source = draft();
    const base = reviewStateFromProgress(createInitialReviewProgress(source));
    const reversed = {
        ...base,
        acceptedTaskIds: ['task-2', 'task-1'],
        decision: {
            globalProfile: 'standard' as const,
            taskOverrides: { 'task-2': 'direct' as const },
            parallelismEnabled: false,
            finalIntegrationReview: false,
            criticalDowngradeConfirmations: { 'task-1': true },
            criticalDowngradeJustifications: { 'task-1': 'Reviewed.' },
        },
    };

    expect(normalizeReviewProgressState(source, reversed)).toEqual({
        acceptedTaskIds: ['task-1', 'task-2'],
        decision: reversed.decision,
    });
    expect(() =>
        normalizeReviewProgressState(source, {
            ...reversed,
            acceptedTaskIds: ['task-1', 'task-1'],
        }),
    ).toThrow('Invalid review progress acceptedTaskIds.');
    expect(() =>
        normalizeReviewProgressState(source, {
            ...reversed,
            decision: {
                ...reversed.decision,
                taskOverrides: { unknown: 'light' },
            },
        }),
    ).toThrow('Unknown review progress override task: unknown.');
    expect(() =>
        normalizeReviewProgressState(source, {
            ...reversed,
            decision: {
                ...reversed.decision,
                globalProfile: 'invalid' as never,
            },
        }),
    ).toThrow('Invalid review progress decision.globalProfile.');
});

test('strictly validates raw state and canonicalizes every task-keyed field', () => {
    const source = draft();
    const initial = createInitialReviewProgress(source);
    const state = {
        acceptedTaskIds: ['task-2', 'task-1'],
        decision: {
            ...initial.decision,
            taskOverrides: { 'task-2': 'direct' as const, 'task-1': 'critical' as const },
            criticalDowngradeConfirmations: { 'task-2': false, 'task-1': true },
            criticalDowngradeJustifications: { 'task-2': 'No risk.', 'task-1': 'Reviewed.' },
        },
    };

    const normalized = normalizeReviewProgressState(source, state);
    expect(normalized.acceptedTaskIds).toEqual(['task-1', 'task-2']);
    expect(Object.keys(normalized.decision.taskOverrides)).toEqual(['task-1', 'task-2']);
    expect(Object.keys(normalized.decision.criticalDowngradeConfirmations)).toEqual(['task-1', 'task-2']);
    expect(Object.keys(normalized.decision.criticalDowngradeJustifications)).toEqual(['task-1', 'task-2']);
    expect(normalized.decision).not.toBe(state.decision);
    expect(() =>
        normalizeReviewProgressState(source, { ...state, unexpected: true } as never),
    ).toThrow('Invalid review progress state.');
    expect(() =>
        normalizeReviewProgressState(source, {
            ...state,
            decision: { ...state.decision, unexpected: true },
        } as never),
    ).toThrow('Invalid review progress decision.');

    const initialForExtra = createInitialReviewProgress(draft());
    expect(() =>
        normalizeReviewProgressState(source, {
            ...reviewStateFromProgress(initialForExtra),
            version: 2,
        } as never),
    ).toThrow('Invalid review progress state.');
    expect(() =>
        normalizeReviewProgressState(source, {
            ...reviewStateFromProgress(initialForExtra),
            manifestId: '../escape',
        } as never),
    ).toThrow('Invalid review progress state.');
    expect(() =>
        normalizeReviewProgressState(source, {
            ...reviewStateFromProgress(initialForExtra),
            revision: -1,
        } as never),
    ).toThrow('Invalid review progress state.');
});

test('rejects unsafe JSON map keys and unsafe persisted manifest IDs', () => {
    const initial = createInitialReviewProgress(draft());
    const mapCases = [
        ['taskOverrides', 'light'],
        ['criticalDowngradeConfirmations', true],
        ['criticalDowngradeJustifications', 'Reviewed.'],
    ] as const;
    for (const [field, value] of mapCases) {
        for (const key of ['__proto__', 'constructor', 'prototype']) {
            const parsed = JSON.parse(JSON.stringify({
                ...initial,
                decision: { ...initial.decision, [field]: { [key]: value } },
            }));
            expect(() => parseReviewProgress(parsed)).toThrow(
                `Unsafe review progress decision.${field} key: ${key}.`,
            );
        }
    }
    for (const manifestId of ['../x', '-leading', 'nested/id', '/tmp/escape']) {
        expect(() =>
            parseReviewProgress({ ...initial, manifestId }),
        ).toThrow('Invalid review progress manifestId.');
    }
    expect(() =>
        parseReviewProgress({ ...initial, revision: '1' }),
    ).toThrow('Invalid review progress revision.');
});

test('rejects full unsupported review progress versions before type/field checks', () => {
    const initial = createInitialReviewProgress(draft());

    expect(() =>
        parseReviewProgress({ ...initial, version: 2 }),
    ).toThrow('Unsupported review progress version: 2.');

    expect(() =>
        parseReviewProgress({
            ...initial,
            decision: { ...initial.decision, globalProfile: 'invalid' as never },
        }),
    ).toThrow('Invalid review progress decision.globalProfile.');
});

test('rejects non-record and hostile proxy inputs with a controlled validation error', () => {
    for (const value of [null, undefined, 1, 'invalid']) {
        expect(() => parseReviewProgress(value)).toThrow(
            'Invalid review progress object.',
        );
    }
    const hostile = new Proxy(
        {},
        {
            getPrototypeOf() {
                throw new Error('prototype trap');
            },
        },
    );
    expect(() => parseReviewProgress(hostile)).toThrow(
        'Invalid review progress object.',
    );
});

test('copies finalIntegrationReview from draft into initial decision', () => {
    expect(
        createInitialReviewProgress({
            ...draft(),
            finalIntegrationReview: false,
        }).decision.finalIntegrationReview,
    ).toBe(false);
});
