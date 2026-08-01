import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
    existsSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    lstatSync,
    rmSync,
    unlinkSync,
    writeFileSync,
    symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    ReviewProgressConflictError,
    SddStore,
    snapshotDigest,
    type TransitionRecord,
} from './store.ts';
import type { RunSnapshot } from './state-machine.ts';
import type { ApprovedManifest, DraftManifest } from './manifest.ts';
import { createInitialReviewProgress } from './review-progress.ts';

let agentDir: string;

beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'sdd-store-'));
});

afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
});

function snapshot(revision = 0): RunSnapshot {
    return {
        runId: 'run-1',
        revision,
        state: revision === 0 ? 'draft' : 'assessed',
        tasks: {
            'task-1': {
                id: 'task-1',
                state: 'pending',
                launches: 0,
                maxLaunches: 1,
            },
        },
        consumedIdempotencyKeys: [],
        plannedDelegations: {},
    };
}

function draftManifest(): DraftManifest {
    return {
        manifestId: 'manifest-1',
        manifestVersion: 1,
        ruleSetVersion: 1,
        state: 'awaiting_approval',
        planTitle: 'Stored plan',
        planPath: '/repo/plan.md',
        sourceDigest: 'source',
        assessmentDigest: 'assessment',
        assessorModel: 'model',
        globalProfile: 'light',
        parallelismEnabled: true,
        maxConcurrentWriters: 2,
        finalIntegrationReview: false,
        maximumLaunches: 0,
        tasks: [],
    };
}

function approvedManifest(
    draft: DraftManifest,
    approvedBy = 'operator',
    approvedAt = '2026-07-21T12:00:00.000Z',
): ApprovedManifest {
    return {
        ...draft,
        state: 'approved',
        decision: {
            globalProfile: draft.globalProfile,
            taskOverrides: {},
            parallelismEnabled: draft.parallelismEnabled,
            criticalDowngradeConfirmations: {},
            criticalDowngradeJustifications: {},
            approvedBy,
            approvedAt,
        },
        approvalDigest: `${approvedBy}:${approvedAt}`,
    };
}

function initialRun(manifestId = 'manifest-1'): RunSnapshot {
    return {
        ...snapshot(),
        runId: manifestId,
        state: 'approved',
    };
}

function reviewStateFromDraft(draft: DraftManifest) {
    const initial = createInitialReviewProgress(draft);
    return {
        acceptedTaskIds: initial.acceptedTaskIds,
        decision: initial.decision,
    };
}

function seedTicket(
    runDir: string,
    ticket: number,
    contents: object | string,
): string {
    const ticketDir = join(runDir, 'snapshot.lock-tickets');
    mkdirSync(ticketDir, { recursive: true });
    const target = join(ticketDir, `${String(ticket).padStart(6, '0')}.lock`);
    const candidate = join(ticketDir, `.seed-${ticket}.candidate`);
    writeFileSync(
        candidate,
        typeof contents === 'string' ? contents : JSON.stringify(contents),
    );
    linkSync(candidate, target);
    unlinkSync(candidate);
    return target;
}

test('creates, loads, and atomically replaces snapshots', () => {
    const store = new SddStore(agentDir);
    expect(store.load('missing')).toBeNull();

    store.create(snapshot());
    expect(store.load('run-1')).toEqual(snapshot());
    expect(() => store.create(snapshot())).toThrow(
        'Run already exists: run-1.',
    );

    store.save(snapshot(1));
    store.save(snapshot(2));
    expect(store.load('run-1')).toEqual(snapshot(2));
    const runDir = join(agentDir, '.sdd', 'runs', 'run-1');
    expect(
        readdirSync(runDir).filter(
            (name) => name.endsWith('.tmp') || name.includes('.candidate'),
        ),
    ).toEqual([]);
    expect(existsSync(join(runDir, 'snapshot.lock-tickets'))).toBe(false);
});

test('locks saves and rejects stale or conflicting persisted revisions', () => {
    const store = new SddStore(agentDir);
    store.create(snapshot(1));

    store.save(snapshot(1));
    expect(() => store.save(snapshot())).toThrow(
        'Snapshot revision conflict: expected 2, received 0.',
    );
    expect(() =>
        store.save({ ...snapshot(1), state: 'approved' }),
    ).toThrow('Snapshot revision conflict: 1.');
    expect(() => store.save(snapshot(3))).toThrow(
        'Snapshot revision conflict: expected 2, received 3.',
    );
    expect(store.load('run-1')).toEqual(snapshot(1));
});

test('publishes a complete ticket before snapshot serialization', () => {
    const runId = 'observable-run';
    const runDir = join(agentDir, '.sdd', 'runs', runId);
    let observedOwner: unknown;
    const inspectable = {
        ...snapshot(),
        runId,
        toJSON() {
            const ticketDir = join(runDir, 'snapshot.lock-tickets');
            const tickets = readdirSync(ticketDir).filter((name) =>
                name.endsWith('.lock'),
            );
            expect(tickets).toEqual(['000001.lock']);
            expect(
                readdirSync(ticketDir).some((name) =>
                    name.includes('.candidate'),
                ),
            ).toBe(false);
            observedOwner = JSON.parse(
                readFileSync(join(ticketDir, tickets[0]), 'utf8'),
            );
            return { ...snapshot(), runId };
        },
    } as RunSnapshot;

    new SddStore(agentDir).save(inspectable);
    expect(observedOwner).toMatchObject({
        pid: process.pid,
        createdAt: expect.any(String),
        nonce: expect.any(String),
    });
    expect(existsSync(join(runDir, 'snapshot.lock-tickets'))).toBe(false);
});

test('orders contenders and blocks behind live or malformed lower tickets', () => {
    const store = new SddStore(agentDir);
    store.create(snapshot(1));
    const runDir = join(agentDir, '.sdd', 'runs', 'run-1');
    const liveTicket = seedTicket(runDir, 1, {
        pid: process.pid,
        createdAt: '2026-07-21T12:00:00.000Z',
        nonce: 'live-seed',
    });

    expect(() => store.save(snapshot(2))).toThrow(
        'Snapshot save blocked by lower ticket: 000001.lock.',
    );
    expect(store.load('run-1')).toEqual(snapshot(1));
    expect(readdirSync(join(runDir, 'snapshot.lock-tickets'))).toEqual([
        '000001.lock',
    ]);

    unlinkSync(liveTicket);
    seedTicket(runDir, 1, 'malformed');
    expect(() => store.save(snapshot(2))).toThrow(
        'Snapshot save blocked by lower ticket: 000001.lock.',
    );
});

test('ignores but retains a crashed dead lower ticket', () => {
    const store = new SddStore(agentDir);
    store.create(snapshot(1));
    const runDir = join(agentDir, '.sdd', 'runs', 'run-1');
    seedTicket(runDir, 1, {
        pid: 2_147_483_647,
        createdAt: '2026-07-21T12:00:00.000Z',
        nonce: 'dead-seed',
    });

    store.save(snapshot(2));
    expect(store.load('run-1')).toEqual(snapshot(2));
    expect(readdirSync(join(runDir, 'snapshot.lock-tickets'))).toEqual([
        '000001.lock',
    ]);
});

test('ticket release cannot delete a replacement at the same path', () => {
    const store = new SddStore(agentDir);
    store.create(snapshot(1));
    const runDir = join(agentDir, '.sdd', 'runs', 'run-1');
    const replacementOwner = {
        pid: process.pid,
        createdAt: '2026-07-21T12:01:00.000Z',
        nonce: 'replacement',
    };
    const replacingSnapshot = {
        ...snapshot(2),
        toJSON() {
            const ticketDir = join(runDir, 'snapshot.lock-tickets');
            const ownTicket = join(ticketDir, '000001.lock');
            unlinkSync(ownTicket);
            seedTicket(runDir, 1, replacementOwner);
            return snapshot(2);
        },
    } as RunSnapshot;

    store.save(replacingSnapshot);
    expect(
        JSON.parse(
            readFileSync(
                join(runDir, 'snapshot.lock-tickets', '000001.lock'),
                'utf8',
            ),
        ),
    ).toEqual(replacementOwner);
});

test('removes a newly-created empty run directory when its first save fails', () => {
    const store = new SddStore(agentDir);
    const runId = 'retryable-run';
    const unserializable = {
        ...snapshot(),
        runId,
        revision: 1n,
    } as unknown as RunSnapshot;

    expect(() => store.create(unserializable)).toThrow();
    expect(existsSync(join(agentDir, '.sdd', 'runs', runId))).toBe(false);
    expect(() => store.create({ ...snapshot(), runId })).not.toThrow();
});

test('lists only run directories containing snapshots and ignores legacy state', () => {
    const store = new SddStore(agentDir);
    store.create(snapshot());
    mkdirSync(join(agentDir, '.sdd', 'runs', 'empty'));
    for (const legacyDir of ['queue', 'progress']) {
        const path = join(agentDir, '.sdd', legacyDir, 'legacy-run');
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, 'snapshot.json'), '{"legacy":true}');
    }

    expect(store.list()).toEqual([snapshot()]);
});

test('fails visibly when a run snapshot is malformed', () => {
    const badRunDir = join(agentDir, '.sdd', 'runs', 'run-bad');
    mkdirSync(badRunDir, { recursive: true });
    writeFileSync(join(badRunDir, 'snapshot.json'), '{bad json');
    const store = new SddStore(agentDir);

    expect(() => store.load('run-bad')).toThrow(SyntaxError);
    expect(() => store.list()).toThrow(SyntaxError);
});

test('rejects traversal and invalid run IDs at every store boundary', () => {
    const store = new SddStore(agentDir);
    const invalidRunIds = [
        '',
        '.',
        '..',
        '../escape',
        'nested/run',
        'nested\\run',
        '/tmp/escape',
        '-leading',
        'run with spaces',
    ];

    for (const runId of invalidRunIds) {
        const invalidSnapshot = { ...snapshot(), runId };
        const record: TransitionRecord = {
            runId,
            revision: 1,
            event: {
                type: 'run-transition',
                expectedRevision: 0,
                to: 'assessed',
            },
            timestamp: '2026-07-21T12:00:00.000Z',
            snapshotDigest: 'digest',
        };
        for (const operation of [
            () => store.load(runId),
            () => store.create(invalidSnapshot),
            () => store.save(invalidSnapshot),
            () => store.appendTransition(record),
        ]) {
            expect(operation).toThrow('Invalid run ID');
        }
    }
    expect(existsSync(join(agentDir, '.sdd', 'runs'))).toBe(false);
});

test('appends complete transition records and computes canonical digests', () => {
    const store = new SddStore(agentDir);
    const initial = snapshot();
    store.create(initial);
    const sameSnapshot: RunSnapshot = {
        plannedDelegations: {},
        consumedIdempotencyKeys: [],
        tasks: {
            'task-1': {
                maxLaunches: 1,
                launches: 0,
                state: 'pending',
                id: 'task-1',
            },
        },
        state: 'draft',
        revision: 0,
        runId: 'run-1',
    };
    const digest = snapshotDigest(initial);
    expect(snapshotDigest(sameSnapshot)).toBe(digest);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);

    const records: TransitionRecord[] = [
        {
            runId: 'run-1',
            revision: 1,
            event: {
                type: 'run-transition',
                expectedRevision: 0,
                to: 'assessed',
            },
            timestamp: '2026-07-21T12:00:00.000Z',
            snapshotDigest: digest,
        },
        {
            runId: 'run-1',
            revision: 2,
            event: {
                type: 'run-transition',
                expectedRevision: 1,
                to: 'awaiting_approval',
            },
            timestamp: '2026-07-21T12:01:00.000Z',
            snapshotDigest: digest,
        },
    ];
    for (const record of records) store.appendTransition(record);

    const lines = readFileSync(
        join(
            agentDir,
            '.sdd',
            'runs',
            'run-1',
            'transitions.jsonl',
        ),
        'utf8',
    )
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
    expect(lines).toEqual(
        records.map(({ revision, event, timestamp, snapshotDigest }) => ({
            revision,
            event,
            timestamp,
            snapshotDigest,
        })),
    );
});

test('creates durable drafts without overwriting an existing manifest', () => {
    const store = new SddStore(agentDir);
    const draft = draftManifest();

    expect(store.loadManifest('manifest-1')).toBeNull();
    expect(store.createManifest(draft)).toEqual(draft);
    expect(store.createManifest(draft)).toEqual(draft);
    expect(store.loadManifest('manifest-1')).toEqual(draft);
    expect(store.listManifests()).toEqual([draft]);

    const updated = { ...draft, globalProfile: 'standard' as const };
    expect(() => store.createManifest(updated)).toThrow(
        'Manifest already exists with different content: manifest-1.',
    );
    expect(store.loadManifest('manifest-1')).toEqual(draft);

    expect(store.deleteManifest('manifest-1')).toBe(true);
    expect(store.deleteManifest('manifest-1')).toBe(false);
    expect(store.loadManifest('manifest-1')).toBeNull();
});

test('saves and loads review progress with optimistic revisions', () => {
    const store = new SddStore(agentDir);
    const draft = draftManifest();
    store.createManifest(draft);
    const initial = reviewStateFromDraft(draft);

    expect(store.loadReviewProgress('manifest-1')).toBeNull();
    const first = store.saveReviewProgress('manifest-1', 0, initial);
    expect(first.revision).toBe(1);
    const second = store.saveReviewProgress('manifest-1', 1, {
        acceptedTaskIds: [],
        decision: first.decision,
    });
    expect(second.revision).toBe(2);
    expect(store.loadReviewProgress('manifest-1')).toEqual(second);
    expect(() => store.saveReviewProgress('manifest-1', 1, initial)).toThrow(
        'Review progress revision conflict: expected 2, received 1.',
    );
    expect(
        readdirSync(join(agentDir, '.sdd', 'reviews')).filter((name) =>
            name.endsWith('.tmp'),
        ),
    ).toEqual([]);
});

test('rejects review saves without an awaiting manifest', () => {
    const store = new SddStore(agentDir);
    const draft = draftManifest();
    const state = reviewStateFromDraft(draft);

    expect(() => store.saveReviewProgress('manifest-1', 0, state)).toThrow(
        'Manifest not found: manifest-1.',
    );
    store.createManifest(draft);
    store.approveManifest(draft, approvedManifest(draft), initialRun());
    expect(() => store.saveReviewProgress('manifest-1', 0, state)).toThrow(
        'Review progress can only be saved while awaiting approval: manifest-1.',
    );
    expect(store.loadReviewProgress('manifest-1')).toBeNull();
});

test('fails visibly for corrupt review progress', () => {
    const store = new SddStore(agentDir);
    const draft = draftManifest();
    const reviewDir = join(agentDir, '.sdd', 'reviews');
    const manifestId = 'manifest-1';
    mkdirSync(reviewDir, { recursive: true });
    store.createManifest(draft);
    const baseline = createInitialReviewProgress(draft);

    writeFileSync(join(reviewDir, 'manifest-1.json'), '{bad json');
    expect(() => store.loadReviewProgress('manifest-1')).toThrow(SyntaxError);
    writeFileSync(join(reviewDir, 'manifest-1.json'), JSON.stringify({ ...baseline, version: 2 }));
    expect(() => store.loadReviewProgress('manifest-1')).toThrow(
        'Unsupported review progress version: 2.',
    );
    writeFileSync(
        join(reviewDir, 'manifest-1.json'),
        JSON.stringify({
            version: 1,
            manifestId,
            revision: -1,
            acceptedTaskIds: [],
            decision: {},
        }),
    );
    expect(() => store.loadReviewProgress('manifest-1')).toThrow(
        'Invalid review progress revision.',
    );
});

test('rejects persisted review progress with unknown task keys', () => {
    const store = new SddStore(agentDir);
    const draft = draftManifest();
    store.createManifest(draft);

    const manifestId = 'manifest-1';
    const reviewDir = join(agentDir, '.sdd', 'reviews');
    const base = createInitialReviewProgress(draft);
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(
        join(reviewDir, `${manifestId}.json`),
        JSON.stringify({
            ...base,
            acceptedTaskIds: ['unknown'],
            decision: {
                ...base.decision,
                taskOverrides: { unknown: 'light' },
            },
        }),
    );

    expect(() => store.loadReviewProgress(manifestId)).toThrow(
        'Unknown review progress accepted task: unknown.',
    );
});

test('blocks symlinked review boundaries before read/write/delete', () => {
    const store = new SddStore(agentDir);
    const manifest = draftManifest();
    const draftState = reviewStateFromDraft(manifest);
    const expectSymlinkError = (operation: () => unknown) =>
        expect(operation).toThrow(/symbolic link/i);

    rmSync(join(agentDir, '.sdd'), { force: true, recursive: true });
    const sddReal = join(agentDir, 'real-sdd');
    mkdirSync(sddReal, { recursive: true });
    symlinkSync(sddReal, join(agentDir, '.sdd'), 'dir');
    expectSymlinkError(() => store.loadReviewProgress('manifest-1'));
    expectSymlinkError(() =>
        store.saveReviewProgress('manifest-1', 0, draftState),
    );
    expectSymlinkError(() => store.deleteReviewProgress('manifest-1'));

    rmSync(join(agentDir, '.sdd'), { force: true, recursive: true });
    mkdirSync(join(agentDir, '.sdd'), { recursive: true });
    const reviewsReal = join(agentDir, 'real-reviews');
    mkdirSync(reviewsReal, { recursive: true });
    symlinkSync(reviewsReal, join(agentDir, '.sdd', 'reviews'), 'dir');
    expectSymlinkError(() => store.loadReviewProgress('manifest-1'));
    expectSymlinkError(() =>
        store.saveReviewProgress('manifest-1', 0, draftState),
    );
    expectSymlinkError(() => store.deleteReviewProgress('manifest-1'));

    rmSync(join(agentDir, '.sdd', 'reviews'), { force: true });
    mkdirSync(join(agentDir, '.sdd', 'reviews'), { recursive: true });
    const reviewFileTarget = join(agentDir, 'manifest-review-target.json');
    writeFileSync(reviewFileTarget, JSON.stringify(draftState));
    store.createManifest(manifest);
    symlinkSync(reviewFileTarget, join(agentDir, '.sdd', 'reviews', 'manifest-1.json'), 'file');
    expectSymlinkError(() => store.loadReviewProgress('manifest-1'));
    expectSymlinkError(() =>
        store.saveReviewProgress('manifest-1', 0, draftState),
    );
    expectSymlinkError(() => store.deleteReviewProgress('manifest-1'));
});

test('deleteManifest refuses review-boundary symlinks and preserves manifest and external targets', () => {
    const store = new SddStore(agentDir);
    const draft = draftManifest();
    store.createManifest(draft);
    const manifestPath = join(agentDir, '.sdd', 'manifests', 'manifest-1.json');
    const reviewDirTarget = join(agentDir, 'real-reviews');
    const reviewDirMarker = join(reviewDirTarget, 'marker.txt');
    const fileReviewTarget = join(agentDir, 'review-file-target.json');

    rmSync(join(agentDir, '.sdd', 'reviews'), { force: true, recursive: true });
    mkdirSync(join(agentDir, '.sdd'), { recursive: true });
    mkdirSync(reviewDirTarget, { recursive: true });
    writeFileSync(reviewDirMarker, 'keep');
    symlinkSync(reviewDirTarget, join(agentDir, '.sdd', 'reviews'), 'dir');

    expect(() => store.deleteManifest('manifest-1')).toThrow(/symbolic link/i);
    expect(existsSync(manifestPath)).toBe(true);
    expect(readFileSync(reviewDirMarker, 'utf8')).toBe('keep');

    rmSync(join(agentDir, '.sdd', 'reviews'), { force: true, recursive: true });
    mkdirSync(join(agentDir, '.sdd', 'reviews'), { recursive: true });
    writeFileSync(fileReviewTarget, JSON.stringify({ keep: 'target' }));
    const reviewFilePath = join(agentDir, '.sdd', 'reviews', 'manifest-1.json');
    symlinkSync(fileReviewTarget, reviewFilePath, 'file');

    expect(() => store.deleteManifest('manifest-1')).toThrow(/symbolic link/i);
    expect(existsSync(manifestPath)).toBe(true);
    expect(readFileSync(fileReviewTarget, 'utf8')).toBe(JSON.stringify({ keep: 'target' }));
    expect(lstatSync(reviewFilePath).isSymbolicLink()).toBe(true);
});

test('deleteManifest rejects a symlinked .sdd root before creating lock files', () => {
    const store = new SddStore(agentDir);
    const externalSdd = join(agentDir, 'external-sdd');
    const marker = join(externalSdd, 'marker.txt');
    mkdirSync(externalSdd, { recursive: true });
    writeFileSync(marker, 'keep');
    symlinkSync(externalSdd, join(agentDir, '.sdd'), 'dir');

    expect(() => store.deleteManifest('manifest-1')).toThrow(/symbolic link/i);
    expect(readFileSync(marker, 'utf8')).toBe('keep');
    expect(existsSync(join(externalSdd, 'manifests'))).toBe(false);
});

test('review operations reject symlinked manifest storage before reading or locking it', () => {
    const store = new SddStore(agentDir);
    const externalManifests = join(agentDir, 'external-manifests');
    mkdirSync(join(agentDir, '.sdd'), { recursive: true });
    mkdirSync(externalManifests, { recursive: true });
    writeFileSync(
        join(externalManifests, 'manifest-1.json'),
        JSON.stringify(draftManifest()),
    );
    symlinkSync(
        externalManifests,
        join(agentDir, '.sdd', 'manifests'),
        'dir',
    );

    const state = reviewStateFromDraft(draftManifest());
    for (const operation of [
        () => store.loadReviewProgress('manifest-1'),
        () => store.saveReviewProgress('manifest-1', 0, state),
        () => store.deleteReviewProgress('manifest-1'),
    ]) {
        expect(operation).toThrow(/symbolic link/i);
    }
    expect(
        existsSync(join(externalManifests, 'manifest-1.lock-tickets')),
    ).toBe(false);
});

test('review operations reject a symlinked manifest file path', () => {
    const store = new SddStore(agentDir);
    const manifest = draftManifest();
    const state = reviewStateFromDraft(manifest);
    store.createManifest(manifest);

    const manifestPath = join(agentDir, '.sdd', 'manifests', 'manifest-1.json');
    const target = join(agentDir, 'external-manifest-file.json');
    writeFileSync(target, JSON.stringify(manifest, null, 2));
    unlinkSync(manifestPath);
    symlinkSync(target, manifestPath, 'file');

    for (const operation of [
        () => store.loadReviewProgress('manifest-1'),
        () => store.saveReviewProgress('manifest-1', 0, state),
        () => store.deleteReviewProgress('manifest-1'),
    ]) {
        expect(operation).toThrow(/symbolic link/i);
    }
    expect(readFileSync(target, 'utf8')).toBe(JSON.stringify(manifest, null, 2));
});

test('loadReviewProgress rejects review data whose manifestId does not match the path', () => {
    const store = new SddStore(agentDir);
    const draft = draftManifest();
    const reviewState = reviewStateFromDraft(draft);
    const reviewRoot = join(agentDir, '.sdd', 'reviews');
    const reviewPath = join(reviewRoot, 'manifest-1.json');

    mkdirSync(reviewRoot, { recursive: true });
    writeFileSync(reviewPath, JSON.stringify({
        ...reviewState,
        version: 1,
        manifestId: 'manifest-2',
        revision: 1,
    }));
    store.createManifest(draft);

    expect(() => store.loadReviewProgress('manifest-1')).toThrow(
        'Invalid review progress manifestId: expected manifest-1, received manifest-2.',
    );
});

test('loadReviewProgress rejects persisted review for invalid manifest state', () => {
    const store = new SddStore(agentDir);
    const draft = draftManifest();
    const reviewState = reviewStateFromDraft(draft);
    const manifestPath = join(agentDir, '.sdd', 'manifests', 'manifest-1.json');
    const reviewPath = join(agentDir, '.sdd', 'reviews', 'manifest-1.json');

    mkdirSync(join(agentDir, '.sdd', 'manifests'), { recursive: true });
    mkdirSync(join(agentDir, '.sdd', 'reviews'), { recursive: true });
    writeFileSync(
        manifestPath,
        JSON.stringify({ ...draft, state: 'invalid_state' }),
    );
    writeFileSync(
        reviewPath,
        JSON.stringify({
            ...reviewState,
            version: 1,
            manifestId: 'manifest-1',
            revision: 1,
        }),
    );

    expect(() => store.loadReviewProgress('manifest-1')).toThrow(
        'Invalid manifest state for review progress: invalid_state.',
    );
});

test('reports expected 0 when no review progress exists for an optimistic save', () => {
    const store = new SddStore(agentDir);
    store.createManifest(draftManifest());

    expect(() =>
        store.saveReviewProgress('manifest-1', 3, reviewStateFromDraft(draftManifest())),
    ).toThrow(
        'Review progress revision conflict: expected 0, received 3.',
    );
});

test('throws a typed revision conflict for both missing and stale review progress', () => {
    const store = new SddStore(agentDir);
    const draft = draftManifest();
    store.createManifest(draft);
    const state = reviewStateFromDraft(draft);

    expect(() => store.saveReviewProgress(draft.manifestId, 3, state)).toThrow(
        ReviewProgressConflictError,
    );
    try {
        store.saveReviewProgress(draft.manifestId, 3, state);
    } catch (error) {
        expect(error).toMatchObject({
            expectedRevision: 0,
            receivedRevision: 3,
            message: 'Review progress revision conflict: expected 0, received 3.',
        });
    }

    store.saveReviewProgress(draft.manifestId, 0, state);

    expect(() => store.saveReviewProgress(draft.manifestId, 0, state)).toThrow(
        ReviewProgressConflictError,
    );
    try {
        store.saveReviewProgress(draft.manifestId, 0, state);
    } catch (error) {
        expect(error).toMatchObject({
            expectedRevision: 1,
            receivedRevision: 0,
            message: 'Review progress revision conflict: expected 1, received 0.',
        });
    }
});

test('deletes review progress with its manifest', () => {
    const store = new SddStore(agentDir);
    const draft = draftManifest();
    store.createManifest(draft);
    store.saveReviewProgress('manifest-1', 0, reviewStateFromDraft(draft));

    expect(store.deleteManifest('manifest-1')).toBe(true);
    expect(store.loadManifest('manifest-1')).toBeNull();
    expect(() => store.loadReviewProgress('manifest-1')).toThrow(
        'Manifest not found: manifest-1.',
    );
    expect(store.deleteManifest('manifest-1')).toBe(false);
});

test('approving a draft keeps success even when review cleanup cannot remove symlinked review path', () => {
    const store = new SddStore(agentDir);
    const manifest = draftManifest();
    const approved = approvedManifest(manifest);
    const reviewTarget = join(agentDir, 'external-review-target.json');
    const reviewTargetPayload = {
        keep: 'external-target',
    };

    store.createManifest(manifest);
    store.saveReviewProgress('manifest-1', 0, reviewStateFromDraft(manifest));
    writeFileSync(reviewTarget, JSON.stringify(reviewTargetPayload));
    unlinkSync(join(agentDir, '.sdd', 'reviews', 'manifest-1.json'));
    symlinkSync(
        reviewTarget,
        join(agentDir, '.sdd', 'reviews', 'manifest-1.json'),
        'file',
    );

    const result = store.approveManifest(manifest, approved, initialRun());

    expect(result.reviewCleanupPending).toBe(true);
    expect(result.reviewCleanupError).toMatch(/symbolic link/i);
    expect(store.loadManifest('manifest-1')).toEqual({
        ...approved,
        state: 'approved',
    });
    expect(JSON.parse(readFileSync(reviewTarget, 'utf8'))).toEqual(
        reviewTargetPayload,
    );
    expect(store.load('manifest-1')).toEqual(initialRun());
});

test('rejects traversal at every review progress boundary', () => {
    const store = new SddStore(agentDir);
    const state = reviewStateFromDraft(draftManifest());
    for (const manifestId of ['../escape', 'nested/review', '', '-leading']) {
        for (const operation of [
            () => store.loadReviewProgress(manifestId),
            () => store.saveReviewProgress(manifestId, 0, state),
            () => store.deleteReviewProgress(manifestId),
            () => store.deleteManifest(manifestId),
        ]) {
            expect(operation).toThrow('Invalid manifest ID');
        }
    }
    expect(existsSync(join(agentDir, '.sdd'))).toBe(false);
});

test('approves a draft and initial run once with identical retry idempotency', () => {
    const store = new SddStore(agentDir);
    const draft = draftManifest();
    const approved = approvedManifest(draft);
    const initial = initialRun();
    store.createManifest(draft);

    expect(store.approveManifest(draft, approved, initial)).toMatchObject({
        created: true,
        manifest: approved,
        snapshot: initial,
    });
    const retry = approvedManifest(
        draft,
        'operator',
        '2026-07-21T12:01:00.000Z',
    );
    expect(store.approveManifest(draft, retry, initial)).toMatchObject({
        created: false,
        manifest: approved,
        snapshot: initial,
    });
    expect(store.loadManifest('manifest-1')).toEqual(approved);
    expect(store.load('manifest-1')).toEqual(initial);
});

test('approval removes review progress after the manifest and run persist', () => {
    const store = new SddStore(agentDir);
    const draft = draftManifest();
    store.createManifest(draft);
    store.saveReviewProgress('manifest-1', 0, reviewStateFromDraft(draft));

    expect(store.approveManifest(draft, approvedManifest(draft), initialRun())).toMatchObject({
        reviewCleanupPending: false,
    });
    expect(store.loadManifest('manifest-1')?.state).toBe('approved');
    expect(store.load('manifest-1')).toEqual(initialRun());
    expect(store.loadReviewProgress('manifest-1')).toBeNull();
});

test('keeps approval durable when review cleanup fails and retries it', () => {
    class CleanupFailingStore extends SddStore {
        cleanupAttempts = 0;

        protected override deleteReviewProgressUnderManifestTicket(
            manifestId: string,
        ): boolean {
            this.cleanupAttempts += 1;
            if (this.cleanupAttempts === 1) {
                throw new Error('injected review cleanup failure');
            }
            return super.deleteReviewProgressUnderManifestTicket(manifestId);
        }
    }
    const store = new CleanupFailingStore(agentDir);
    const draft = draftManifest();
    const approved = approvedManifest(draft);
    store.createManifest(draft);
    store.saveReviewProgress('manifest-1', 0, reviewStateFromDraft(draft));

    expect(store.approveManifest(draft, approved, initialRun())).toMatchObject({
        created: true,
        reviewCleanupPending: true,
        reviewCleanupError: 'injected review cleanup failure',
    });
    expect(store.loadManifest('manifest-1')).toEqual(approved);
    expect(store.load('manifest-1')).toEqual(initialRun());
    expect(store.loadReviewProgress('manifest-1')).not.toBeNull();

    expect(store.approveManifest(draft, approved, initialRun())).toMatchObject({
        created: false,
        reviewCleanupPending: false,
    });
    expect(store.cleanupAttempts).toBe(2);
    expect(store.loadReviewProgress('manifest-1')).toBeNull();
});

test('a conflicting approval cannot overwrite the winning decision', () => {
    const store = new SddStore(agentDir);
    const draft = draftManifest();
    const winner = approvedManifest(draft, 'first');
    store.createManifest(draft);
    store.approveManifest(draft, winner, initialRun());

    expect(() =>
        store.approveManifest(
            draft,
            approvedManifest(draft, 'second'),
            initialRun(),
        ),
    ).toThrow('Manifest approval conflict: manifest-1.');
    expect(store.loadManifest('manifest-1')).toEqual(winner);
});

test('approval rolls back the initial run when manifest persistence fails', () => {
    class FailingManifestStore extends SddStore {
        protected override writeManifestAtomically(
            manifest: DraftManifest | ApprovedManifest,
        ): void {
            if (manifest.state === 'approved') {
                throw new Error('injected manifest write failure');
            }
            super.writeManifestAtomically(manifest);
        }
    }
    const store = new FailingManifestStore(agentDir);
    const draft = draftManifest();
    store.createManifest(draft);

    expect(() =>
        store.approveManifest(draft, approvedManifest(draft), initialRun()),
    ).toThrow('injected manifest write failure');
    expect(store.loadManifest('manifest-1')).toEqual(draft);
    expect(store.load('manifest-1')).toBeNull();
});

test('approval leaves the draft untouched when initial run creation fails', () => {
    class FailingRunStore extends SddStore {
        override create(value: RunSnapshot): void {
            super.create(value);
            throw new Error('injected run create failure');
        }
    }
    const store = new FailingRunStore(agentDir);
    const draft = draftManifest();
    store.createManifest(draft);

    expect(() =>
        store.approveManifest(draft, approvedManifest(draft), initialRun()),
    ).toThrow('injected run create failure');
    expect(store.loadManifest('manifest-1')).toEqual(draft);
    expect(store.load('manifest-1')).toBeNull();
});
