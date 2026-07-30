import { expect, test } from 'bun:test';
import type { DraftManifest } from './manifest.ts';
import {
    createReviewController,
    openManifestReview,
    ManifestReviewComponent,
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

function draftWithValidation(): DraftManifest {
    return {
        ...draft(),
        globalProfile: 'light',
        finalIntegrationReview: false,
        tasks: [
            {
                ...draft().tasks[0]!,
                id: 'task-1',
                title: 'Task one',
                qa: [{ id: 'a11y', command: 'bun run test:a11y' }],
                budgets: {
                    initialWorkers: 1,
                    correctionWorkers: 0,
                    reviewerAttempts: 0,
                    maxLaunches: 1,
                },
                effectiveProfile: 'light',
                recommendedProfile: 'light',
            },
            {
                ...draft().tasks[0]!,
                id: 'task-2',
                title: 'Task two',
                qa: undefined,
                browser: [
                    {
                        id: 'flow',
                        baseUrl: 'https://example.test',
                        preconditions: ['ready'],
                        steps: ['start', 'submit'],
                        expected: ['ok'],
                    },
                ],
                budgets: {
                    initialWorkers: 1,
                    correctionWorkers: 0,
                    reviewerAttempts: 0,
                    maxLaunches: 1,
                },
                effectiveProfile: 'light',
                recommendedProfile: 'light',
            },
        ],
        parallelismEnabled: false,
        maximumLaunches: 4,
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

test('review controller exposes separate validation launch accounting', () => {
    const controller = createReviewController(draftWithValidation());

    expect(controller.current).toMatchObject({
        profileLaunches: 2,
        qaLaunches: 1,
        browserLaunches: 1,
        validationLaunches: 2,
        maximumLaunches: 4,
    });

    controller.setGlobalProfile('direct');
    expect(controller.current).toMatchObject({
        profileLaunches: 0,
        qaLaunches: 1,
        browserLaunches: 1,
        validationLaunches: 2,
        maximumLaunches: 2,
    });
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

function fakeTheme() {
    return {
        fg: (color: string, text: string) => `[${color}|${text}]`,
        bold: (text: string) => text,
        bg: (_color: string, text: string) => text,
        italic: (text: string) => text,
        underline: (text: string) => text,
        inverse: (text: string) => text,
        strikethrough: (text: string) => text,
    } as never;
}

const tuiStub = { requestRender() {} } as never;
const kbStub = { matches: () => false } as never;

test('review UI module imports and calls one native custom overlay', async () => {
    let calls = 0;
    let rendered: string[] = [];
    const ctx = {
        mode: 'tui',
        ui: {
            custom: async (factory: Function) => {
                calls++;
                expect(typeof factory).toBe('function');
                const component = factory(tuiStub, fakeTheme(), kbStub, () => {});
                rendered = component.render(120);
                return { type: 'cancel' as const };
            },
        },
    };

    await expect(openManifestReview(ctx as never, draft())).resolves.toEqual({
        type: 'cancel',
    });
    expect(calls).toBe(1);
    expect(rendered.join('\n')).toContain('duration: extended');
    expect(rendered.join('\n')).toContain('Validation launches: qa=0, browser=0, total=0 (of profile budget 7)');
});

test('review overlay renders three themed panes with box drawing at wide width', async () => {
    let rendered: string[] = [];
    const ctx = {
        mode: 'tui',
        ui: {
            custom: async (factory: Function) => {
                const component = factory(tuiStub, fakeTheme(), kbStub, () => {});
                rendered = component.render(120);
                return { type: 'cancel' as const };
            },
        },
    };

    await openManifestReview(ctx as never, draft());
    const joined = rendered.join('\n');
    expect(joined).toContain('│');
    expect(joined).toContain('[accent|›]');
    expect(joined).toContain('task-1');
});

test('review overlay falls back to a single message below 36 columns', async () => {
    let rendered: string[] = [];
    const ctx = {
        mode: 'tui',
        ui: {
            custom: async (factory: Function) => {
                const component = factory(tuiStub, fakeTheme(), kbStub, () => {});
                rendered = component.render(30);
                return { type: 'cancel' as const };
            },
        },
    };

    await openManifestReview(ctx as never, draft());
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain('36 columns');
});

test('review overlay approve with validation errors keeps the overlay open', () => {
    const source = draft();
    const controller = createReviewController(source);
    // Critical downgrade (effective light) without confirmation → validate() fails.
    controller.setTaskOverride('task-1', 'light');
    let result: unknown = null;
    const done = (r: unknown) => {
        result = r;
    };
    const component = new ManifestReviewComponent(
        { requestRender() {} } as never,
        fakeTheme(),
        { matches: () => false } as never,
        source,
        controller,
        done as never,
    );
    component.render(120);
    component.handleInput('a');
    expect(result).toBe(null);
});

test('review overlay j key opens the justification editor (not consumed by roster down)', () => {
    const source = draft();
    const controller = createReviewController(source);
    controller.setTaskOverride('task-1', 'light');
    controller.confirmCriticalDowngrade('task-1', true);
    const component = new ManifestReviewComponent(
        { requestRender() {} } as never,
        fakeTheme(),
        { matches: () => false } as never,
        source,
        controller,
        (() => {}) as never,
    );
    component.render(120);
    component.handleInput('j');
    // j must enter justification editing, not move the roster selection.
    expect((component as unknown as { editingJustification: boolean }).editingJustification).toBe(true);
    // selectedTask unchanged (still 0).
    expect((component as unknown as { selectedTask: number }).selectedTask).toBe(0);
});

test('review overlay collapses validation into detail pane below 24 rows', () => {
    const source = draft();
    const controller = createReviewController(source);
    const component = new ManifestReviewComponent(
        { requestRender() {}, terminal: { rows: 20 } } as never,
        fakeTheme(),
        { matches: () => false } as never,
        source,
        controller,
        (() => {}) as never,
    );
    const rendered = component.render(120);
    const joined = rendered.join('\n').toLowerCase();
    // Validation must still be visible (collapsed into detail), not vanish.
    expect(joined).toContain('validation');
});

test('review overlay shows task QA validation and browser aggregate preview', async () => {
    let rendered: string[] = [];
    const ctx = {
        mode: 'tui',
        ui: {
            custom: async (factory: Function) => {
                const component = factory(tuiStub, fakeTheme(), kbStub, () => {});
                rendered = component.render(120);
                return { type: 'cancel' as const };
            },
        },
    };

    await expect(openManifestReview(ctx as never, draftWithValidation())).resolves.toEqual(
        { type: 'cancel' },
    );
    expect(rendered.join('\n')).toContain('Validation launches: qa=1, browser=1, total=2 (of profile budget 2)');
    expect(rendered.join('\n')).toContain('validation=QA launch (1)');
});
