import { expect, test } from 'bun:test';
import type { DraftManifest } from './manifest.ts';
import {
    createReviewController,
    openManifestReview,
} from './review-ui.ts';

function draft(): DraftManifest {
    return {
        manifestId: 'manifest-1',
        manifestVersion: 1,
        ruleSetVersion: 1,
        state: 'awaiting_approval',
        planTitle: 'Review plan',
        planPath: '/repo/plan.md',
        sourceDigest: 'abc123',
        assessmentDigest: 'assessment',
        assessorModel: 'model',
        globalProfile: 'standard',
        parallelismEnabled: true,
        maxConcurrentWriters: 2,
        finalIntegrationReview: true,
        maximumLaunches: 8,
        tasks: [
            {
                id: 'task-1',
                title: 'Sensitive task',
                description: 'Change authentication.',
                recommendedProfile: 'critical',
                effectiveProfile: 'critical',
                classificationRules: ['critical-signal'],
                signals: ['authentication_or_authorization'],
                dependencies: [],
                files: ['src/auth.ts'],
                verify: [{ id: 'auth', command: 'bun test auth' }],
                budgets: {
                    initialWorkers: 1,
                    correctionWorkers: 2,
                    reviewerAttempts: 4,
                    maxLaunches: 7,
                },
                parallelEligible: false,
            },
        ],
    };
}

test('review controller recalculates previews and blocks unconfirmed critical downgrades', () => {
    const source = draft();
    const controller = createReviewController(source);

    expect(controller.current).toMatchObject({
        estimatedQualitativeDuration: 'extended',
    });
    controller.setGlobalProfile('light');
    expect(controller.current.maximumLaunches).toBe(8);
    controller.setTaskOverride('task-1', 'light');
    expect(controller.current).toMatchObject({
        maximumLaunches: 1,
        estimatedQualitativeDuration: 'short',
    });
    expect(controller.validate()).toContain(
        'Critical downgrade for task-1 requires confirmation.',
    );
    expect(() =>
        controller.approve('operator', '2026-07-21T12:00:00.000Z'),
    ).toThrow('Critical downgrade for task-1 requires confirmation.');

    controller.confirmCriticalDowngrade('task-1', true);
    controller.setCriticalJustification('task-1', 'Accepted for this run.');
    controller.setParallelism(false);
    expect(controller.approve('operator', '2026-07-21T12:00:00.000Z')).toMatchObject(
        {
            globalProfile: 'light',
            parallelismEnabled: false,
            criticalDowngradeConfirmations: { 'task-1': true },
            criticalDowngradeJustifications: {
                'task-1': 'Accepted for this run.',
            },
        },
    );
    expect(controller.cancel()).toBeNull();
    expect(source).toEqual(draft());
});

test('approving the untouched review preserves deterministic task recommendations', () => {
    const controller = createReviewController(draft());

    expect(controller.current.taskOverrides).toEqual({ 'task-1': 'critical' });
    expect(
        controller.approve('operator', '2026-07-21T12:00:00.000Z')
            .taskOverrides,
    ).toEqual({ 'task-1': 'critical' });
});

test('task overrides update the preview without mutating the draft', () => {
    const source = draft();
    const controller = createReviewController(source);

    controller.setTaskOverride('task-1', 'direct');
    expect(controller.current.maximumLaunches).toBe(0);
    controller.setTaskOverride('task-1', undefined);
    expect(controller.current.maximumLaunches).toBe(4);
    expect(source.tasks[0]?.effectiveProfile).toBe('critical');
});

test('review controller can request an optional final integration review', () => {
    const original = draft();
    const source: DraftManifest = {
        ...original,
        globalProfile: 'light',
        finalIntegrationReview: false,
        maximumLaunches: 1,
        tasks: [
            {
                ...original.tasks[0]!,
                recommendedProfile: 'light',
                effectiveProfile: 'light',
                signals: ['isolated_scope'],
                budgets: {
                    initialWorkers: 1,
                    correctionWorkers: 0,
                    reviewerAttempts: 0,
                    maxLaunches: 1,
                },
            },
        ],
    };
    const controller = createReviewController(source);

    expect(controller.current.finalIntegrationReview).toBe(false);
    controller.setFinalIntegrationReview(true);
    expect(controller.current).toMatchObject({
        finalIntegrationReview: true,
        maximumLaunches: 2,
    });
    expect(
        controller.approve('operator', '2026-07-21T12:00:00.000Z')
            .finalIntegrationReview,
    ).toBe(true);
});

test('review UI module imports and calls one native custom overlay', async () => {
    let calls = 0;
    let rendered: string[] = [];
    const ctx = {
        mode: 'tui',
        ui: {
            custom: async (factory: Function) => {
                calls++;
                expect(typeof factory).toBe('function');
                const component = factory(
                    { requestRender() {} },
                    {},
                    { matches: () => false },
                    () => {},
                );
                rendered = component.render(120);
                return { type: 'cancel' as const };
            },
        },
    };

    await expect(openManifestReview(ctx as never, draft())).resolves.toEqual({
        type: 'cancel',
    });
    expect(calls).toBe(1);
    expect(rendered).toContain('Estimated qualitative duration: extended');
});
