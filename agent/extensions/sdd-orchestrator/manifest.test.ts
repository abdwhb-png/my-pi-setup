import { expect, spyOn, test } from 'bun:test';
import type { Assessment } from './assessment.ts';
import type { SddConfig } from './config.ts';
import {
    applyApproval,
    budgetsFor,
    calculateLaunchPreview,
    compileManifest,
    type ManifestDecision,
} from './manifest.ts';
import type { ParsedPlan } from './types.ts';

const config: SddConfig = {
    agents: {
        assessor: 'orchestration-assessor',
        quickWorker: 'quick-worker',
        worker: 'sdd-worker',
        combinedReviewer: 'sdd-combined-reviewer',
        specReviewer: 'sdd-spec-reviewer',
        qualityReviewer: 'sdd-quality-reviewer',
    },
    models: {},
    timeoutsMs: { assessor: 600_000, worker: 2_700_000, reviewer: 900_000 },
    maxConcurrentWriters: 2,
    structuredOutputRetries: 1,
};

function plan(secondFile = 'src/two.ts'): ParsedPlan {
    return {
        title: 'Two tasks',
        tasks: [
            {
                id: 'task-1',
                ordinal: 1,
                title: 'One',
                body: 'First task',
                dependsOn: [],
                files: ['src/one.ts'],
                verify: [{ id: 'one', command: 'bun test one' }],
            },
            {
                id: 'task-2',
                ordinal: 2,
                title: 'Two',
                body: 'Second task',
                dependsOn: [],
                files: [secondFile],
                verify: [{ id: 'two', command: 'bun test two' }],
            },
        ],
    };
}

function planWithValidation(): ParsedPlan {
    const parsed = plan();
    parsed.tasks[0]!.qa = [{ id: 'a11y', command: 'bun run test:a11y src/one.ts' }];
    parsed.tasks[1]!.browser = [
        {
            id: 'ui-flow',
            baseUrl: 'https://example.test',
            preconditions: ['build passes'],
            steps: ['open /one', 'submit'],
            expected: ['ok'],
            cleanup: ['snapshot'],
        },
    ];
    return parsed;
}

function assessment(taskIds = ['task-1', 'task-2']): Assessment {
    return {
        version: 1,
        assessorModel: 'test-model',
        tasks: taskIds.map((taskId) => ({
            taskId,
            signals: [
                'isolated_scope',
                'clear_requirements',
                'existing_test_pattern',
            ],
            evidence: [],
            confidence: 'high',
            uncertainties: [],
            advisoryMinimum: 'light',
        })),
    };
}

function compile(parsedPlan = plan()) {
    return compileManifest({
        planPath: '/repo/plan.md',
        planContent: '# Plan',
        parsedPlan,
        assessment: assessment(),
        globalProfile: 'light',
        parallelismEnabled: true,
        config,
    });
}

test('returns immutable exact launch ceilings for every profile', () => {
    expect(budgetsFor('direct')).toEqual({
        initialWorkers: 0,
        correctionWorkers: 0,
        reviewerAttempts: 0,
        maxLaunches: 0,
    });
    expect(budgetsFor('light')).toEqual({
        initialWorkers: 1,
        correctionWorkers: 0,
        reviewerAttempts: 0,
        maxLaunches: 1,
    });
    expect(budgetsFor('standard')).toEqual({
        initialWorkers: 1,
        correctionWorkers: 1,
        reviewerAttempts: 2,
        maxLaunches: 4,
    });
    expect(budgetsFor('critical')).toEqual({
        initialWorkers: 1,
        correctionWorkers: 2,
        reviewerAttempts: 4,
        maxLaunches: 7,
    });
    expect(Object.isFrozen(budgetsFor('critical'))).toBe(true);
});

test('compiles disjoint tasks as parallel and overlapping tasks as sequential', () => {
    const disjoint = compile();
    expect(disjoint.tasks.map((task) => task.parallelEligible)).toEqual([
        true,
        true,
    ]);
    expect(disjoint.tasks[0]).toMatchObject({
        id: 'task-1',
        recommendedProfile: 'light',
        effectiveProfile: 'light',
        classificationRules: ['light-positive-scope'],
        dependencies: [],
        files: ['src/one.ts'],
        budgets: budgetsFor('light'),
    });
    expect(disjoint).toMatchObject({
        planTitle: 'Two tasks',
        manifestVersion: 1,
        ruleSetVersion: 1,
        globalProfile: 'light',
        finalIntegrationReview: false,
        maximumLaunches: 2,
        maxConcurrentWriters: 2,
    });
    expect(compile()).toEqual(disjoint);

    const overlapping = compile(plan('src/one.ts'));
    expect(overlapping.tasks.map((task) => task.parallelEligible)).toEqual([
        false,
        false,
    ]);
});

test('calculates one shared launch preview from explicit effective profiles', () => {
    const draft = compile();
    const direct = calculateLaunchPreview(draft.tasks, {
        'task-1': 'direct',
        'task-2': 'direct',
    });
    const critical = calculateLaunchPreview(draft.tasks, {
        'task-1': 'critical',
        'task-2': 'light',
    });

    expect(direct).toEqual({
        finalIntegrationReview: false,
        profileLaunches: 0,
        qaLaunches: 0,
        browserLaunches: 0,
        validationLaunches: 0,
        maximumLaunches: 0,
    });
    expect(critical).toEqual({
        finalIntegrationReview: true,
        profileLaunches: 8,
        qaLaunches: 0,
        browserLaunches: 0,
        validationLaunches: 0,
        maximumLaunches: 9,
    });
});

test('adds one QA launch per task and one aggregate browser launch', () => {
    const draft = compileManifest({
        planPath: '/repo/plan.md',
        planContent: '# Plan',
        parsedPlan: planWithValidation(),
        assessment: assessment(),
        globalProfile: 'light',
        parallelismEnabled: true,
        config,
    });

    expect(draft.tasks[0]!.qa).toEqual([
        { id: 'a11y', command: 'bun run test:a11y src/one.ts' },
    ]);
    expect(draft.tasks[1]!.browser).toEqual([
        {
            id: 'ui-flow',
            baseUrl: 'https://example.test',
            preconditions: ['build passes'],
            steps: ['open /one', 'submit'],
            expected: ['ok'],
            cleanup: ['snapshot'],
        },
    ]);
    expect(draft).toMatchObject({
        maximumLaunches: 4,
        profileLaunches: 2,
        qaLaunches: 1,
        browserLaunches: 1,
        validationLaunches: 2,
    });
});

test('requires final integration review for a Critical task', () => {
    const assessed = assessment();
    assessed.tasks[0].signals = ['authentication_or_authorization'];
    const draft = compileManifest({
        planPath: '/repo/plan.md',
        planContent: '# Plan',
        parsedPlan: plan(),
        assessment: assessed,
        globalProfile: 'light',
        parallelismEnabled: true,
        config,
    });

    expect(draft.finalIntegrationReview).toBe(true);
    expect(draft.maximumLaunches).toBe(9);
});

test('retains qa and browser declarations through approval', () => {
    const decision: ManifestDecision = {
        globalProfile: 'light',
        taskOverrides: {},
        parallelismEnabled: true,
        criticalDowngradeConfirmations: {},
        criticalDowngradeJustifications: {},
        approvedBy: 'operator',
        approvedAt: '2026-07-21T00:00:00.000Z',
    };
    const draft = compileManifest({
        planPath: '/repo/plan.md',
        planContent: '# Plan',
        parsedPlan: planWithValidation(),
        assessment: assessment(),
        globalProfile: 'light',
        parallelismEnabled: true,
        config,
    });
    const approved = applyApproval(draft, decision, '# Plan');

    expect(approved).toMatchObject({
        maximumLaunches: 4,
        profileLaunches: 2,
        qaLaunches: 1,
        browserLaunches: 1,
        validationLaunches: 2,
    });
    expect(approved.tasks[0]!.qa).toEqual(draft.tasks[0]!.qa);
    expect(approved.tasks[1]!.browser).toEqual(draft.tasks[1]!.browser);
    expect(Object.isFrozen(approved.tasks[0].qa)).toBe(true);
    expect(Object.isFrozen(approved.tasks[1].browser)).toBe(true);
});

test('keeps final integration review for multiple approved shared-contract tasks', () => {
    const assessed = assessment();
    assessed.tasks[0].signals = ['shared_infrastructure'];
    assessed.tasks[1].signals = ['inter_extension_protocol'];
    const draft = compileManifest({
        planPath: '/repo/plan.md',
        planContent: '# Plan',
        parsedPlan: plan(),
        assessment: assessed,
        globalProfile: 'light',
        parallelismEnabled: true,
        config,
    });
    const approved = applyApproval(
        draft,
        {
            globalProfile: 'standard',
            taskOverrides: {},
            parallelismEnabled: true,
            criticalDowngradeConfirmations: {},
            criticalDowngradeJustifications: {},
            approvedBy: 'operator',
            approvedAt: '2026-07-21T00:00:00.000Z',
        },
        '# Plan',
    );

    expect(approved.tasks.every((task) => task.effectiveProfile === 'standard')).toBe(
        true,
    );
    expect(approved.finalIntegrationReview).toBe(true);
    expect(approved.maximumLaunches).toBe(9);
});

test('requires final integration review for cross-module integration', () => {
    const assessed = assessment();
    assessed.tasks[0].signals = ['multi_module'];
    const draft = compileManifest({
        planPath: '/repo/plan.md',
        planContent: '# Plan',
        parsedPlan: plan(),
        assessment: assessed,
        globalProfile: 'light',
        parallelismEnabled: true,
        config,
    });

    expect(draft.finalIntegrationReview).toBe(true);
    expect(draft.maximumLaunches).toBe(6);
});

test('clears final integration review when approval removes the only trigger', () => {
    const assessed = assessment();
    assessed.tasks[0].signals = ['authentication_or_authorization'];
    const draft = compileManifest({
        planPath: '/repo/plan.md',
        planContent: '# Plan',
        parsedPlan: plan(),
        assessment: assessed,
        globalProfile: 'light',
        parallelismEnabled: true,
        config,
    });
    const approved = applyApproval(
        draft,
        {
            globalProfile: 'light',
            taskOverrides: { 'task-1': 'direct' },
            parallelismEnabled: true,
            criticalDowngradeConfirmations: { 'task-1': true },
            criticalDowngradeJustifications: { 'task-1': 'Risk accepted.' },
            approvedBy: 'operator',
            approvedAt: '2026-07-21T00:00:00.000Z',
        },
        '# Plan',
    );

    expect(draft.finalIntegrationReview).toBe(true);
    expect(approved.finalIntegrationReview).toBe(false);
    expect(approved.maximumLaunches).toBe(1);
});

test('allows approval to request one final integration review launch', () => {
    const draft = compile();
    const decision: ManifestDecision = {
        globalProfile: 'light',
        taskOverrides: {},
        parallelismEnabled: true,
        criticalDowngradeConfirmations: {},
        criticalDowngradeJustifications: {},
        approvedBy: 'operator',
        approvedAt: '2026-07-21T00:00:00.000Z',
    };

    const omitted = applyApproval(draft, decision, '# Plan');
    const declined = applyApproval(
        draft,
        { ...decision, finalIntegrationReview: false },
        '# Plan',
    );
    const requested = applyApproval(
        draft,
        { ...decision, finalIntegrationReview: true },
        '# Plan',
    );

    expect(omitted.finalIntegrationReview).toBe(false);
    expect(omitted.maximumLaunches).toBe(2);
    expect(declined.finalIntegrationReview).toBe(false);
    expect(declined.maximumLaunches).toBe(2);
    expect(requested.finalIntegrationReview).toBe(true);
    expect(requested.maximumLaunches).toBe(3);
    expect(requested.decision.finalIntegrationReview).toBe(true);
    expect(Object.isFrozen(requested.decision)).toBe(true);
});

test('keeps manifest and approval digests stable for reordered object keys', () => {
    const originalAssessment = assessment();
    const reorderedAssessment: Assessment = {
        tasks: originalAssessment.tasks.map((task) => ({
            advisoryMinimum: task.advisoryMinimum,
            uncertainties: task.uncertainties,
            confidence: task.confidence,
            evidence: task.evidence,
            signals: task.signals,
            taskId: task.taskId,
        })),
        assessorModel: originalAssessment.assessorModel,
        version: originalAssessment.version,
    };
    const originalDecision: ManifestDecision = {
        globalProfile: 'light',
        taskOverrides: { 'task-1': 'light', 'task-2': 'light' },
        parallelismEnabled: true,
        criticalDowngradeConfirmations: {},
        criticalDowngradeJustifications: {},
        approvedBy: 'operator',
        approvedAt: '2026-07-21T00:00:00.000Z',
    };
    const reorderedDecision: ManifestDecision = {
        approvedAt: originalDecision.approvedAt,
        approvedBy: originalDecision.approvedBy,
        criticalDowngradeJustifications: {},
        criticalDowngradeConfirmations: {},
        parallelismEnabled: originalDecision.parallelismEnabled,
        taskOverrides: { 'task-2': 'light', 'task-1': 'light' },
        globalProfile: originalDecision.globalProfile,
    };

    const outputs = (() => {
        const localeCompare = spyOn(
            String.prototype,
            'localeCompare',
        ).mockImplementation(() => {
            throw new Error('locale-sensitive comparator used');
        });
        try {
            const compileAssessment = (value: Assessment) =>
                compileManifest({
                    planPath: '/repo/plan.md',
                    planContent: '# Plan',
                    parsedPlan: plan(),
                    assessment: value,
                    globalProfile: 'light',
                    parallelismEnabled: true,
                    config,
                });
            const originalDraft = compileAssessment(originalAssessment);
            const reorderedDraft = compileAssessment(reorderedAssessment);
            return {
                originalDraft,
                reorderedDraft,
                originalApproval: applyApproval(
                    originalDraft,
                    originalDecision,
                    '# Plan',
                ),
                reorderedApproval: applyApproval(
                    reorderedDraft,
                    reorderedDecision,
                    '# Plan',
                ),
            };
        } finally {
            localeCompare.mockRestore();
        }
    })();

    expect(outputs.reorderedDraft.assessmentDigest).toBe(
        outputs.originalDraft.assessmentDigest,
    );
    expect(outputs.reorderedDraft.manifestId).toBe(
        outputs.originalDraft.manifestId,
    );
    expect(outputs.reorderedApproval.approvalDigest).toBe(
        outputs.originalApproval.approvalDigest,
    );
});

test('blocks parallelism for dependencies, global disable, and shared contracts', () => {
    const dependentPlan = plan();
    dependentPlan.tasks[1].dependsOn = ['task-1'];
    expect(compile(dependentPlan).tasks[1].parallelEligible).toBe(false);

    const globallyDisabled = compileManifest({
        planPath: '/repo/plan.md',
        planContent: '# Plan',
        parsedPlan: plan(),
        assessment: assessment(),
        globalProfile: 'light',
        parallelismEnabled: false,
        config,
    });
    expect(globallyDisabled.tasks.every((task) => !task.parallelEligible)).toBe(
        true,
    );

    const sharedContractAssessment = assessment();
    sharedContractAssessment.tasks[0].signals = ['shared_infrastructure'];
    const sharedContract = compileManifest({
        planPath: '/repo/plan.md',
        planContent: '# Plan',
        parsedPlan: plan(),
        assessment: sharedContractAssessment,
        globalProfile: 'light',
        parallelismEnabled: true,
        config,
    });
    expect(sharedContract.tasks[0].parallelEligible).toBe(false);
    expect(sharedContract.tasks[1].parallelEligible).toBe(true);
});

test('rejects duplicate, missing, and unknown assessment task IDs', () => {
    const compileWithAssessment = (value: Assessment) =>
        compileManifest({
            planPath: '/repo/plan.md',
            planContent: '# Plan',
            parsedPlan: plan(),
            assessment: value,
            globalProfile: 'light',
            parallelismEnabled: true,
            config,
        });

    expect(() => compileWithAssessment(assessment(['task-1', 'task-1']))).toThrow(
        'Assessment task IDs mismatch: duplicate task-1; missing task-2.',
    );
    expect(() => compileWithAssessment(assessment(['task-1', 'task-3']))).toThrow(
        'Assessment task IDs mismatch: missing task-2; unknown task-3.',
    );
});

test('rejects dependency cycles with the concrete cycle path', () => {
    const cyclicPlan = plan();
    cyclicPlan.tasks[0].dependsOn = ['task-2'];
    cyclicPlan.tasks[1].dependsOn = ['task-1'];

    expect(() => compile(cyclicPlan)).toThrow(
        'Dependency cycle: task-1 -> task-2 -> task-1.',
    );
});

test('rejects invalid approval decisions and returns a frozen approved manifest', () => {
    const assessed = assessment();
    assessed.tasks[0].signals = ['shared_infrastructure'];
    const draft = compileManifest({
        planPath: '/repo/plan.md',
        planContent: '# Plan',
        parsedPlan: plan(),
        assessment: assessed,
        globalProfile: 'light',
        parallelismEnabled: false,
        config,
    });
    const decision: ManifestDecision = {
        globalProfile: 'standard',
        taskOverrides: { 'task-1': 'direct' },
        parallelismEnabled: true,
        criticalDowngradeConfirmations: { 'task-1': true },
        criticalDowngradeJustifications: { 'task-1': 'Risk accepted.' },
        approvedBy: 'operator',
        approvedAt: '2026-07-21T00:00:00.000Z',
    };

    expect(() => applyApproval(draft, decision, '# Changed')).toThrow(
        'Source plan changed after manifest compilation.',
    );
    expect(() =>
        applyApproval(
            draft,
            { ...decision, taskOverrides: { 'task-999': 'light' } },
            '# Plan',
        ),
    ).toThrow('Unknown task override: task-999.');
    expect(() =>
        applyApproval(
            draft,
            {
                ...decision,
                criticalDowngradeConfirmations: {
                    ...decision.criticalDowngradeConfirmations,
                    'task-999': true,
                },
            },
            '# Plan',
        ),
    ).toThrow('Unknown critical downgrade confirmation: task-999.');
    expect(() =>
        applyApproval(
            draft,
            {
                ...decision,
                criticalDowngradeJustifications: {
                    ...decision.criticalDowngradeJustifications,
                    'task-999': 'Unknown task.',
                },
            },
            '# Plan',
        ),
    ).toThrow('Unknown critical downgrade justification: task-999.');
    expect(() =>
        applyApproval(
            draft,
            { ...decision, globalProfile: 'invalid' as never },
            '# Plan',
        ),
    ).toThrow('Invalid profile: invalid.');
    expect(() =>
        applyApproval(
            draft,
            {
                ...decision,
                criticalDowngradeConfirmations: {},
                criticalDowngradeJustifications: {},
            },
            '# Plan',
        ),
    ).toThrow('Critical downgrade for task-1 requires confirmation.');
    expect(() =>
        applyApproval(
            draft,
            {
                ...decision,
                criticalDowngradeJustifications: { 'task-1': '   ' },
            },
            '# Plan',
        ),
    ).toThrow('Critical downgrade for task-1 requires a justification.');
    expect(() =>
        applyApproval(draft, { ...decision, approvedBy: ' ' }, '# Plan'),
    ).toThrow('approvedBy must be non-empty.');
    expect(() =>
        applyApproval(draft, { ...decision, approvedAt: '' }, '# Plan'),
    ).toThrow('approvedAt must be non-empty.');

    expect(
        applyApproval(
            draft,
            {
                ...decision,
                taskOverrides: { 'task-1': 'standard' },
                criticalDowngradeConfirmations: {},
                criticalDowngradeJustifications: {},
            },
            '# Plan',
        ).tasks[0].effectiveProfile,
    ).toBe('standard');

    const original = structuredClone(draft);
    const approved = applyApproval(draft, decision, '# Plan');
    expect(draft).toEqual(original);
    expect(approved).toMatchObject({
        state: 'approved',
        globalProfile: 'standard',
        parallelismEnabled: true,
        maximumLaunches: 4,
        decision,
    });
    expect(approved.tasks.map((task) => task.effectiveProfile)).toEqual([
        'direct',
        'standard',
    ]);
    expect(approved.tasks.map((task) => task.parallelEligible)).toEqual([
        false,
        true,
    ]);
    expect(approved.approvalDigest).toHaveLength(64);
    expect(applyApproval(draft, decision, '# Plan')).toEqual(approved);
    expect(Object.isFrozen(approved)).toBe(true);
    expect(Object.isFrozen(approved.tasks)).toBe(true);
    expect(Object.isFrozen(approved.tasks[0].budgets)).toBe(true);
    expect(Object.isFrozen(approved.decision.taskOverrides)).toBe(true);
});
