import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
    existsSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    SddStore,
    snapshotDigest,
    type TransitionRecord,
} from './store.ts';
import type { RunSnapshot } from './state-machine.ts';
import type { ApprovedManifest, DraftManifest } from './manifest.ts';

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
