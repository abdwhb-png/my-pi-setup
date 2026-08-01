import { expect, test } from 'bun:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { DraftManifest } from './manifest.ts';
import {
    createReviewController,
    openManifestReview,
    ManifestReviewComponent,
    type ReviewProgressStorage,
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
        maximumLaunches: 2,
        estimatedQualitativeDuration: 'moderate',
    });
    expect(controller.validate()).toContain(
        'Critical downgrade for task-1 requires confirmation.',
    );
    expect(() =>
        controller.approve('operator', '2026-07-21T12:00:00.000Z'),
    ).toThrow('Critical downgrade for task-1 requires confirmation.');

    controller.confirmCriticalDowngrade('task-1', true);
    controller.setCriticalJustification('task-1', 'Accepted for this run.');
    controller.setTaskAccepted('task-1', true);
    controller.setParallelism(false);
    controller.setTaskAccepted('task-1', true);
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

test('review controller enforces full task acceptance before approval', () => {
    const controller = createReviewController(draft());
    controller.setTaskAccepted('task-1', false);
    expect(controller.validate()).toContain(
        'Task task-1 is not accepted.',
    );
    expect(() =>
        controller.approve('operator', '2026-07-21T12:00:00.000Z'),
    ).toThrow('Task task-1 is not accepted.');
    controller.setTaskAccepted('task-1', true);
    expect(controller.validate()).toEqual([]);
    expect(
        controller.approve('operator', '2026-07-21T12:00:00.000Z')
            .globalProfile,
    ).toBe('standard');
});

test('task overrides update the preview without mutating the draft', () => {
    const source = draft();
    const controller = createReviewController(source);

    controller.setTaskOverride('task-1', 'direct');
    expect(controller.current.maximumLaunches).toBe(1);
    controller.setTaskOverride('task-1', undefined);
    expect(controller.current.maximumLaunches).toBe(5);
    expect(source.tasks[0]?.effectiveProfile).toBe('critical');
});

test('review decision changes invalidate the affected acceptance without reaccepting it', () => {
    const source = draftWithValidation();
    const controller = createReviewController(source);

    controller.setTaskOverride('task-1', 'direct');
    expect(controller.taskIsAccepted('task-1')).toBe(false);
    expect(controller.taskIsAccepted('task-2')).toBe(true);
    controller.setTaskAccepted('task-1', true);
    controller.setTaskOverride('task-1', undefined);
    expect(controller.taskIsAccepted('task-1')).toBe(false);

    controller.setTaskAccepted('task-1', true);
    controller.setGlobalProfile('standard');
    expect(controller.current.acceptedTaskIds).toEqual([]);
    controller.setTaskAccepted('task-1', true);
    controller.setTaskAccepted('task-2', true);
    controller.setParallelism(true);
    expect(controller.current.acceptedTaskIds).toEqual([]);
    controller.setTaskAccepted('task-1', true);
    controller.setFinalIntegrationReview(true);
    expect(controller.current.acceptedTaskIds).toEqual([]);
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
    controller.setTaskAccepted('task-1', true);
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

function plainTheme() {
    return {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
        bg: (_color: string, text: string) => text,
        italic: (text: string) => text,
        underline: (text: string) => text,
        inverse: (text: string) => text,
        strikethrough: (text: string) => text,
    } as never;
}

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

test('review overlay loads persisted progress state and renders pending acceptance', async () => {
    const manifestId = draft().manifestId;
    const loaded = {
        version: 1,
        manifestId,
        revision: 2,
        acceptedTaskIds: [] as string[],
        decision: {
            globalProfile: 'standard',
            taskOverrides: {},
            parallelismEnabled: true,
            finalIntegrationReview: true,
            criticalDowngradeConfirmations: {},
            criticalDowngradeJustifications: {},
        },
    };
    let loadedManifestId: string | undefined;
    const storage = {
        loadReviewProgress: (id: string) => {
            loadedManifestId = id;
            return loaded;
        },
    };
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

    await openManifestReview(ctx as never, draft(), storage);
    expect(loadedManifestId).toBe(manifestId);
    expect(rendered.join('\n')).toContain('Pending acceptance: task-1');
});

test('review overlay saves mutation and reconciles after revision conflict', async () => {
    const source = draft();
    const saves: unknown[] = [];
    const storage: ReviewProgressStorage = {
        loadReviewProgress: () => null,
        saveReviewProgress: (manifestId, expectedRevision, progress) => {
            saves.push({ manifestId, expectedRevision, progress });
            return {
                type: 'conflict',
                current: {
                    version: 1,
                    manifestId: 'manifest-1',
                    revision: 99,
                    acceptedTaskIds: ['task-1'],
                    decision: {
                        globalProfile: 'light',
                        taskOverrides: { 'task-1': 'light' },
                        parallelismEnabled: true,
                        finalIntegrationReview: true,
                        criticalDowngradeConfirmations: {},
                        criticalDowngradeJustifications: {},
                    },
                },
            };
        },
    };
    const controller = createReviewController(source);
    const component = new ManifestReviewComponent(
        { requestRender() {} } as never,
        fakeTheme(),
        { matches: () => false } as never,
        source,
        controller,
        (() => {}) as never,
        0,
        storage,
    );
    component.render(120);
    component.handleInput('p');
    await Promise.resolve();

    expect(saves).toHaveLength(1);
    expect(
        (
            saves[0] as {
                manifestId: string;
                expectedRevision: number;
                progress: { decision: { globalProfile: string } };
            }
        ).progress.decision.globalProfile,
    ).toBe('standard');
    expect(
        (saves[0] as { manifestId: string; expectedRevision: number }).manifestId,
    ).toBe('manifest-1');
    expect(
        (saves[0] as { manifestId: string; expectedRevision: number }).expectedRevision,
    ).toBe(0);
    const rendered = component.render(120).join('\n');
    expect(rendered).toContain('Review progress was updated by another session.');
    expect(rendered).toContain('global: light');
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

test('review overlay renders a closed fallback below 36 columns', async () => {
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
    expect(rendered).toHaveLength(3);
    expect(rendered[0]).toContain('╭');
    expect(rendered[1]).toContain('36 columns');
    expect(rendered.at(-1)).toContain('╰');
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
    const rendered = component.render(96);
    expect(rendered.join('\n')).toContain('Critical downgrade justification:');
    expect(rendered.length).toBeLessThanOrEqual(27);
});

test('review overlay space toggles acceptance for the selected task', () => {
    const source = draft();
    const controller = createReviewController(source);
    const component = new ManifestReviewComponent(
        { requestRender() {} } as never,
        fakeTheme(),
        { matches: () => false } as never,
        source,
        controller,
        (() => {}) as never,
    );
    component.render(120);

    expect(controller.taskIsAccepted('task-1')).toBe(true);
    component.handleInput(' ');
    expect(controller.taskIsAccepted('task-1')).toBe(false);
    component.handleInput(' ');
    expect(controller.taskIsAccepted('task-1')).toBe(true);
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

test('review overlay uses the prescribed responsive panes and a bounded closed frame', () => {
    const source = draftWithValidation();
    for (const width of [35, 36, 59, 60, 95, 96, 120]) {
        for (const rows of [12, 16, 20, 24, 32, 43]) {
            const component = new ManifestReviewComponent(
                { requestRender() {}, terminal: { rows } } as never,
                plainTheme(),
                { matches: () => false } as never,
                source,
                createReviewController(source),
                (() => {}) as never,
            );
            const rendered = component.render(width);
            if (width < 36) {
                expect(rendered).toHaveLength(3);
                expect(rendered[0]).toStartWith('╭');
                expect(rendered.at(-1)).toStartWith('╰');
                continue;
            }
            const budget = Math.max(1, Math.min(Math.floor(rows * 0.85), rows - 2));
            expect(rendered.length).toBeLessThanOrEqual(budget);
            expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
            expect(rendered[0]).toStartWith('╭');
            expect(rendered.at(-1)).toStartWith('╰');
            expect(rendered.at(-1)).toEndWith('╯');
            expect(rendered.join('\n')).toContain('Tab panels');
        }
    }

    const wide = new ManifestReviewComponent(
        { requestRender() {}, terminal: { rows: 32 } } as never,
        plainTheme(),
        { matches: () => false } as never,
        source,
        createReviewController(source),
        (() => {}) as never,
    ).render(96);
    expect(wide).toContain('├────────────────────────┬────────────────────────────────────────┬────────────────────────────┤');

    const medium = new ManifestReviewComponent(
        { requestRender() {}, terminal: { rows: 32 } } as never,
        plainTheme(),
        { matches: () => false } as never,
        source,
        createReviewController(source),
        (() => {}) as never,
    ).render(60);
    expect(medium).toContain('├────────────────────────┬─────────────────────────────────┤');
});

test('review overlay renders description before task metadata and supports legacy and Kitty acceptance keys', () => {
    const source = draftWithValidation();
    const controller = createReviewController(source);
    const component = new ManifestReviewComponent(
        { requestRender() {}, terminal: { rows: 32 } } as never,
        plainTheme(),
        { matches: () => false } as never,
        source,
        controller,
        (() => {}) as never,
    );
    const rendered = component.render(96).join('\n');
    expect(rendered.indexOf('description: Change authentication.')).toBeLessThan(
        rendered.indexOf('dependencies: none'),
    );

    component.handleInput(' ');
    expect(controller.taskIsAccepted('task-1')).toBe(false);
    component.handleInput('\x1b[32u');
    expect(controller.taskIsAccepted('task-1')).toBe(true);
    component.handleInput('\r');
    expect(controller.taskIsAccepted('task-1')).toBe(false);
    component.handleInput('\x1b[13u');
    expect(controller.taskIsAccepted('task-1')).toBe(true);
});

test('review overlay keeps a closed compact frame and useful action at very low heights', () => {
    const source = draftWithValidation();
    for (const rows of [6, 8, 10]) {
        const component = new ManifestReviewComponent(
            { requestRender() {}, terminal: { rows } } as never,
            plainTheme(),
            { matches: () => false } as never,
            source,
            createReviewController(source),
            (() => {}) as never,
        );
        const budget = Math.max(1, Math.min(Math.floor(rows * 0.85), rows - 2));
        const rendered = component.render(96);
        expect(rendered.length).toBeLessThanOrEqual(budget);
        expect(rendered[0]).toStartWith('╭');
        expect(rendered.at(-1)).toStartWith('╰');
        expect(rendered.at(-1)).toEndWith('╯');
        expect(rendered.join('\n')).toContain('Esc cancel');
    }
});

test('review overlay rolls back a failed save, exposes the error, and blocks approval', async () => {
    const source = draftWithValidation();
    const controller = createReviewController(source);
    let done: unknown = null;
    const component = new ManifestReviewComponent(
        { requestRender() {}, terminal: { rows: 32 } } as never,
        plainTheme(),
        { matches: () => false } as never,
        source,
        controller,
        (outcome) => {
            done = outcome;
        },
        0,
        {
            saveReviewProgress: () => ({ type: 'error', error: 'disk full' }),
        },
    );
    component.render(96);
    component.handleInput('p');
    await (component as unknown as { pendingSave: Promise<void> }).pendingSave;

    expect(controller.current.globalProfile).toBe('light');
    expect(component.render(96).join('\n')).toContain(
        'Failed to persist review progress: disk full',
    );
    component.handleInput('a');
    expect(done).toBeNull();
});

test('review overlay serializes sequential saves from the effective server revision', async () => {
    const source = draftWithValidation();
    const expectedRevisions: number[] = [];
    const component = new ManifestReviewComponent(
        { requestRender() {}, terminal: { rows: 32 } } as never,
        plainTheme(),
        { matches: () => false } as never,
        source,
        createReviewController(source),
        (() => {}) as never,
        0,
        {
            saveReviewProgress: (_manifestId, expectedRevision) => {
                expectedRevisions.push(expectedRevision);
                return { type: 'ok', revision: expectedRevision === 0 ? 41 : 42 };
            },
        },
    );
    component.handleInput('p');
    component.handleInput('i');
    await (component as unknown as { pendingSave: Promise<void> }).pendingSave;

    expect(expectedRevisions).toEqual([0, 41]);
});

test('review overlay handles legacy and Kitty panel navigation, scroll, clamp, and rerender', () => {
    const source = draftWithValidation();
    let renders = 0;
    const component = new ManifestReviewComponent(
        {
            requestRender() {
                renders += 1;
            },
            terminal: { rows: 12 },
        } as never,
        plainTheme(),
        { matches: () => false } as never,
        source,
        createReviewController(source),
        (() => {}) as never,
    );
    component.render(96);
    component.handleInput('\x1b[57420u');
    expect((component as unknown as { selectedTask: number }).selectedTask).toBe(1);
    component.handleInput('\t');
    expect((component as unknown as { focusedPanel: string }).focusedPanel).toBe('detail');
    component.handleInput('\x1b[57422u');
    expect((component as unknown as { detailScroll: number }).detailScroll).toBeGreaterThan(0);
    component.handleInput('\x1b[5~');
    expect((component as unknown as { detailScroll: number }).detailScroll).toBe(0);
    component.handleInput('\x1b[57424u');
    expect((component as unknown as { detailScroll: number }).detailScroll).toBeGreaterThan(0);
    component.handleInput('\x1b[H');
    expect((component as unknown as { detailScroll: number }).detailScroll).toBe(0);
    component.handleInput('\x1b[9u');
    expect((component as unknown as { focusedPanel: string }).focusedPanel).toBe('validation');
    component.handleInput('\x1b[D');
    component.handleInput('\x1b[D');
    expect((component as unknown as { focusedPanel: string }).focusedPanel).toBe('roster');
    component.handleInput('\x1b[A');
    expect((component as unknown as { selectedTask: number }).selectedTask).toBe(0);
    expect((component as unknown as { detailScroll: number }).detailScroll).toBe(0);
    expect(renders).toBeGreaterThanOrEqual(10);
});

test('review overlay discards queued local mutations after a conflict instead of sending stale CAS', async () => {
    const source = draftWithValidation();
    const expectedRevisions: number[] = [];
    let resolveConflict: (() => void) | undefined;
    const component = new ManifestReviewComponent(
        { requestRender() {}, terminal: { rows: 32 } } as never,
        plainTheme(),
        { matches: () => false } as never,
        source,
        createReviewController(source),
        (() => {}) as never,
        0,
        {
            saveReviewProgress: (_manifestId, expectedRevision) => {
                expectedRevisions.push(expectedRevision);
                if (expectedRevisions.length === 1) {
                    return new Promise((resolve) => {
                        resolveConflict = () =>
                            resolve({
                                type: 'conflict',
                                current: {
                                    version: 1,
                                    manifestId: source.manifestId,
                                    revision: 99,
                                    acceptedTaskIds: source.tasks.map((task) => task.id),
                                    decision: {
                                        globalProfile: 'standard',
                                        taskOverrides: {},
                                        parallelismEnabled: true,
                                        finalIntegrationReview: false,
                                        criticalDowngradeConfirmations: {},
                                        criticalDowngradeJustifications: {},
                                    },
                                },
                            });
                    });
                }
                return { type: 'ok', revision: expectedRevision + 1 };
            },
        },
    );
    component.handleInput('p');
    component.handleInput('i');
    resolveConflict?.();
    await (component as unknown as { pendingSave: Promise<void> }).pendingSave;

    expect(expectedRevisions).toEqual([0]);
    expect(
        (component as unknown as { controller: ReturnType<typeof createReviewController> }).controller.current,
    ).toMatchObject({ globalProfile: 'standard', finalIntegrationReview: false });
    expect(component.render(120).join('\n')).toContain('Pending local changes were discarded.');
});

test('review overlay scrolls large validation results independently in the validation pane', () => {
    const base = draftWithValidation();
    const source: DraftManifest = {
        ...base,
        tasks: Array.from({ length: 40 }, (_value, index) => ({
            ...base.tasks[index % base.tasks.length]!,
            id: `task-${index + 1}`,
            title: `Task ${index + 1}`,
        })),
    };
    const controller = createReviewController(source);
    for (const task of source.tasks) controller.setTaskAccepted(task.id, false);
    const component = new ManifestReviewComponent(
        { requestRender() {}, terminal: { rows: 32 } } as never,
        plainTheme(),
        { matches: () => false } as never,
        source,
        controller,
        (() => {}) as never,
    );
    component.render(120);
    component.handleInput('\t');
    component.handleInput('\x1b[9u');
    expect((component as unknown as { focusedPanel: string }).focusedPanel).toBe('validation');
    const firstPage = component.render(120).join('\n');
    component.handleInput('\x1b[57422u');
    expect((component as unknown as { validationScroll: number }).validationScroll).toBeGreaterThan(0);
    const secondPage = component.render(120).join('\n');
    expect(secondPage).not.toBe(firstPage);
    component.handleInput('\x1b[F');
    expect(component.render(120).join('\n')).toContain('task-40');
    component.handleInput('\x1b[57423u');
    expect((component as unknown as { validationScroll: number }).validationScroll).toBe(0);
});

test('review overlay routes medium-width validation focus to the appended detail scroll', () => {
    const base = draftWithValidation();
    const source: DraftManifest = {
        ...base,
        globalProfile: 'light',
        tasks: Array.from({ length: 40 }, (_value, index) => ({
            ...base.tasks[index % base.tasks.length]!,
            id: `task-${index + 1}`,
            title: `Task ${index + 1}`,
            recommendedProfile: 'critical',
            effectiveProfile: 'light',
        })),
    };
    const controller = createReviewController(source);
    for (const task of source.tasks) {
        controller.setTaskOverride(task.id, 'light');
        controller.setTaskAccepted(task.id, true);
    }
    const component = new ManifestReviewComponent(
        { requestRender() {}, terminal: { rows: 32 } } as never,
        plainTheme(),
        { matches: () => false } as never,
        source,
        controller,
        (() => {}) as never,
    );
    component.render(80);
    expect((component as unknown as { renderedLayoutMode: string }).renderedLayoutMode).toBe('medium');
    expect(
        (component as unknown as { detailLineCount: number; bodyHeight: number }).detailLineCount,
    ).toBeGreaterThan((component as unknown as { bodyHeight: number }).bodyHeight);
    component.handleInput('\t');
    component.handleInput('\x1b[9u');
    expect((component as unknown as { focusedPanel: string }).focusedPanel).toBe('validation');
    const firstPage = component.render(80).join('\n');
    component.handleInput('\x1b[6~');
    expect((component as unknown as { detailScroll: number }).detailScroll).toBeGreaterThan(0);
    const secondPage = component.render(80).join('\n');
    expect(secondPage).not.toBe(firstPage);
    component.handleInput('\x1b[57422u');
    component.handleInput('\x1b[F');
    expect(component.render(80).join('\n')).toContain('task-40');
});

test('review overlay visibly identifies the focused panel in every responsive mode', () => {
    const source = draftWithValidation();
    const styled = new ManifestReviewComponent(
        { requestRender() {}, terminal: { rows: 32 } } as never,
        fakeTheme(),
        { matches: () => false } as never,
        source,
        createReviewController(source),
        (() => {}) as never,
    );
    expect(styled.render(120).join('\n')).toContain('[accent|▸ TASKS]');

    const component = new ManifestReviewComponent(
        { requestRender() {}, terminal: { rows: 32 } } as never,
        plainTheme(),
        { matches: () => false } as never,
        source,
        createReviewController(source),
        (() => {}) as never,
    );
    expect(component.render(120).join('\n')).toContain('▸ TASKS');
    expect(component.render(120).join('\n')).toContain('Focus: Tasks');

    component.handleInput('\t');
    expect(component.render(120).join('\n')).toContain('▸ DETAILS');
    expect(component.render(120).join('\n')).toContain('Focus: Details');

    component.handleInput('\x1b[9u');
    expect(component.render(120).join('\n')).toContain('▸ VALIDATION');
    expect(component.render(120).join('\n')).toContain('Focus: Validation');

    const medium = component.render(80).join('\n');
    expect(medium).toContain('DETAILS + ▸ VALIDATION');

    const compact = component.render(50).join('\n');
    expect(compact).toContain('▸ VALIDATION');
});
