import { createHash, randomUUID } from 'node:crypto';
import {
    appendFileSync,
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmdirSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import {
    approvalDecisionDigest,
    type ApprovedManifest,
    type DraftManifest,
} from './manifest.ts';
import {
    normalizeReviewProgressState,
    parseReviewProgress,
    type ManifestReviewProgressState,
    type ManifestReviewProgressV1,
} from './review-progress.ts';
import type { RunEvent, RunSnapshot } from './state-machine.ts';

type StoredManifest = DraftManifest | ApprovedManifest;

export interface ManifestApprovalResult {
    readonly created: boolean;
    readonly manifest: ApprovedManifest;
    readonly snapshot: RunSnapshot;
    readonly reviewCleanupPending: boolean;
    readonly reviewCleanupError?: string;
}

export class ReviewProgressConflictError extends Error {
    readonly expectedRevision: number;
    readonly receivedRevision: number;

    constructor(expectedRevision: number, receivedRevision: number) {
        super(
            `Review progress revision conflict: expected ${expectedRevision}, received ${receivedRevision}.`,
        );
        this.name = 'ReviewProgressConflictError';
        this.expectedRevision = expectedRevision;
        this.receivedRevision = receivedRevision;
    }
}

export interface TransitionRecord {
    runId: string;
    revision: number;
    event: RunEvent;
    timestamp: string;
    snapshotDigest: string;
}

interface LockOwner {
    pid: number;
    createdAt: string;
    nonce: string;
}

interface ObservedLock {
    device: number;
    inode: number;
    owner: LockOwner;
    path: string;
    number: number;
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .toSorted(([left], [right]) =>
                left < right ? -1 : left > right ? 1 : 0,
            )
            .map(
                ([key, entry]) =>
                    `${JSON.stringify(key)}:${canonicalJson(entry)}`,
            )
            .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

function approvalIdentity(manifest: ApprovedManifest): string {
    const {
        approvalDigest: _approvalDigest,
        decision,
        ...stableManifest
    } = manifest;
    return canonicalJson({
        ...stableManifest,
        decisionDigest: approvalDecisionDigest(decision),
    });
}

export function snapshotDigest(snapshot: RunSnapshot): string {
    return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

function hasErrorCode(error: unknown, code: string): boolean {
    return (
        !!error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === code
    );
}

function readLock(lockPath: string): ObservedLock | null {
    try {
        const stats = lstatSync(lockPath);
        const owner: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (
            !owner ||
            typeof owner !== 'object' ||
            !('pid' in owner) ||
            !('createdAt' in owner) ||
            !('nonce' in owner) ||
            !Number.isInteger(owner.pid) ||
            typeof owner.pid !== 'number' ||
            owner.pid <= 0 ||
            typeof owner.createdAt !== 'string' ||
            !owner.createdAt ||
            Number.isNaN(Date.parse(owner.createdAt)) ||
            typeof owner.nonce !== 'string' ||
            !/^[A-Za-z0-9_-]+$/.test(owner.nonce)
        ) {
            return null;
        }
        return {
            device: stats.dev,
            inode: stats.ino,
            owner: {
                pid: owner.pid,
                createdAt: owner.createdAt,
                nonce: owner.nonce,
            },
            path: lockPath,
            number: Number.parseInt(basename(lockPath), 10),
        };
    } catch {
        return null;
    }
}

function hasDeadOwner(lock: ObservedLock): boolean {
    try {
        process.kill(lock.owner.pid, 0);
        return false;
    } catch (error) {
        return hasErrorCode(error, 'ESRCH');
    }
}

function sameLock(left: ObservedLock, right: ObservedLock): boolean {
    return (
        left.device === right.device &&
        left.inode === right.inode &&
        left.owner.pid === right.owner.pid &&
        left.owner.createdAt === right.owner.createdAt &&
        left.owner.nonce === right.owner.nonce
    );
}

interface ReviewCleanupResult {
    readonly reviewCleanupPending: boolean;
    readonly reviewCleanupError?: string;
}

function assertNoSymlink(path: string, pathForError: string): void {
    try {
        const stats = lstatSync(path);
        if (stats.isSymbolicLink()) {
            throw new Error(`Refusing review operation through symbolic link: ${pathForError}.`);
        }
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) throw error;
    }
}

export class SddStore {
    private readonly root: string;
    private readonly manifestRoot: string;
    private readonly reviewRoot: string;
    private readonly sddRoot: string;

    constructor(agentDir: string = getAgentDir()) {
        this.root = resolve(agentDir, '.sdd', 'runs');
        this.manifestRoot = resolve(agentDir, '.sdd', 'manifests');
        this.sddRoot = resolve(agentDir, '.sdd');
        this.reviewRoot = resolve(agentDir, '.sdd', 'reviews');
    }

    create(snapshot: RunSnapshot): void {
        const runDir = this.runDir(snapshot.runId);
        mkdirSync(this.root, { recursive: true });
        if (existsSync(runDir)) {
            throw new Error(`Run already exists: ${snapshot.runId}.`);
        }
        mkdirSync(runDir);
        try {
            this.save(snapshot);
        } catch (error) {
            try {
                rmdirSync(runDir);
            } catch {
                // Only remove the directory when the failed save left it empty.
            }
            throw error;
        }
    }

    load(runId: string): RunSnapshot | null {
        const path = join(this.runDir(runId), 'snapshot.json');
        if (!existsSync(path)) return null;
        return JSON.parse(readFileSync(path, 'utf8'));
    }

    save(snapshot: RunSnapshot): void {
        const runDir = this.runDir(snapshot.runId);
        const path = join(runDir, 'snapshot.json');
        const ticketDir = join(runDir, 'snapshot.lock-tickets');
        mkdirSync(runDir, { recursive: true });
        const ticket = this.acquireTicket(ticketDir);

        let temporaryPath: string | undefined;
        try {
            const persisted = this.load(snapshot.runId);
            if (persisted && snapshot.revision === persisted.revision) {
                if (snapshotDigest(snapshot) !== snapshotDigest(persisted)) {
                    throw new Error(
                        `Snapshot revision conflict: ${snapshot.revision}.`,
                    );
                }
                return;
            }
            if (persisted && snapshot.revision !== persisted.revision + 1) {
                throw new Error(
                    `Snapshot revision conflict: expected ${persisted.revision + 1}, received ${snapshot.revision}.`,
                );
            }

            temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
            writeFileSync(
                temporaryPath,
                `${JSON.stringify(snapshot, null, 2)}\n`,
            );
            renameSync(temporaryPath, path);
            temporaryPath = undefined;
        } finally {
            try {
                if (temporaryPath && existsSync(temporaryPath)) {
                    unlinkSync(temporaryPath);
                }
            } catch {
                // Preserve the save error while leaving unrelated files alone.
            }
            this.releaseTicket(ticket);
            try {
                rmdirSync(ticketDir);
            } catch {
                // Dead or concurrent tickets intentionally keep the directory.
            }
        }
    }

    list(): RunSnapshot[] {
        if (!existsSync(this.root)) return [];
        const snapshots: RunSnapshot[] = [];
        for (const entry of readdirSync(this.root, {
            withFileTypes: true,
        }).toSorted((left, right) =>
            left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
        )) {
            if (
                !entry.isDirectory() ||
                !existsSync(join(this.root, entry.name, 'snapshot.json'))
            ) {
                continue;
            }
            const snapshot = this.load(entry.name);
            if (snapshot) snapshots.push(snapshot);
        }
        return snapshots;
    }

    appendTransition(record: TransitionRecord): void {
        const runDir = this.runDir(record.runId);
        mkdirSync(runDir, { recursive: true });
        appendFileSync(
            join(runDir, 'transitions.jsonl'),
            `${JSON.stringify({
                revision: record.revision,
                event: record.event,
                timestamp: record.timestamp,
                snapshotDigest: record.snapshotDigest,
            })}\n`,
        );
    }

    loadManifest(manifestId: string): StoredManifest | null {
        const path = this.manifestPath(manifestId);
        if (!existsSync(path)) return null;
        return JSON.parse(readFileSync(path, 'utf8'));
    }

    createManifest(manifest: DraftManifest): DraftManifest {
        this.manifestPath(manifest.manifestId);
        const ticket = this.acquireManifestTicket(manifest.manifestId);
        try {
            const current = this.loadManifest(manifest.manifestId);
            if (current?.state === 'approved') {
                throw new Error(
                    `Manifest ${manifest.manifestId} is already approved.`,
                );
            }
            if (current) {
                if (canonicalJson(current) === canonicalJson(manifest)) {
                    return current;
                }
                throw new Error(
                    `Manifest already exists with different content: ${manifest.manifestId}.`,
                );
            }
            this.writeManifestAtomically(manifest);
            return manifest;
        } finally {
            this.releaseManifestTicket(ticket);
        }
    }

    approveManifest(
        expectedDraft: DraftManifest,
        approved: ApprovedManifest,
        initialSnapshot: RunSnapshot,
    ): ManifestApprovalResult {
        if (
            expectedDraft.manifestId !== approved.manifestId ||
            approved.manifestId !== initialSnapshot.runId
        ) {
            throw new Error('Manifest approval IDs do not match.');
        }
        this.manifestPath(approved.manifestId);
        const ticket = this.acquireManifestTicket(approved.manifestId);
        try {
            const current = this.loadManifest(approved.manifestId);
            if (!current) {
                throw new Error(`Manifest not found: ${approved.manifestId}.`);
            }
            if (current.state === 'approved') {
                if (approvalIdentity(current) !== approvalIdentity(approved)) {
                    throw new Error(
                        `Manifest approval conflict: ${approved.manifestId}.`,
                    );
                }
                const snapshot = this.load(approved.manifestId);
                if (!snapshot) {
                    throw new Error(
                        `Approved manifest ${approved.manifestId} has no initial run.`,
                    );
                }
                const reviewCleanup = this.attemptReviewCleanup(
                    approved.manifestId,
                );
                return {
                    created: false,
                    manifest: current,
                    snapshot,
                    ...reviewCleanup,
                };
            }
            if (canonicalJson(current) !== canonicalJson(expectedDraft)) {
                throw new Error(
                    `Manifest draft conflict: ${approved.manifestId}.`,
                );
            }
            if (this.load(approved.manifestId)) {
                throw new Error(
                    `Run already exists before approval: ${approved.manifestId}.`,
                );
            }

            try {
                this.create(initialSnapshot);
            } catch (error) {
                this.removeInitialRun(initialSnapshot);
                throw error;
            }
            try {
                this.writeManifestAtomically(approved);
            } catch (error) {
                this.removeInitialRun(initialSnapshot);
                throw error;
            }
            const reviewCleanup = this.attemptReviewCleanup(
                approved.manifestId,
            );
            return {
                created: true,
                manifest: approved,
                snapshot: initialSnapshot,
                ...reviewCleanup,
            };
        } finally {
            this.releaseManifestTicket(ticket);
        }
    }

    loadReviewProgress(manifestId: string): ManifestReviewProgressV1 | null {
        this.assertNoReviewBoundaries(manifestId);
        const manifest = this.loadManifest(manifestId);
        if (!manifest) {
            throw new Error(`Manifest not found: ${manifestId}.`);
        }
        return this.loadReviewProgressNoBoundaries(manifest, manifestId);
    }

    saveReviewProgress(
        manifestId: string,
        expectedRevision: number,
        state: ManifestReviewProgressState,
    ): ManifestReviewProgressV1 {
        this.assertNoReviewBoundaries(manifestId);
        const ticket = this.acquireManifestTicket(manifestId);
        try {
            const manifest = this.loadManifest(manifestId);
            if (!manifest) {
                throw new Error(`Manifest not found: ${manifestId}.`);
            }
            if (manifest.state !== 'awaiting_approval') {
                throw new Error(
                    `Review progress can only be saved while awaiting approval: ${manifestId}.`,
                );
            }

            const current = this.loadReviewProgressNoBoundaries(
                manifest,
                manifestId,
            );
            if (!current && expectedRevision !== 0) {
                throw new ReviewProgressConflictError(
                    0,
                    expectedRevision,
                );
            }
            if (current && current.revision !== expectedRevision) {
                throw new ReviewProgressConflictError(
                    current.revision,
                    expectedRevision,
                );
            }
            const normalized = normalizeReviewProgressState(manifest, state);
            const next: ManifestReviewProgressV1 = {
                version: 1 as const,
                manifestId,
                revision: expectedRevision + 1,
                ...normalized,
            };
            const path = this.reviewPath(manifestId);
            mkdirSync(this.reviewRoot, { recursive: true });
            let temporaryPath: string | undefined;
            try {
                temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
                writeFileSync(
                    temporaryPath,
                    `${JSON.stringify(next, null, 2)}\n`,
                );
                renameSync(temporaryPath, path);
                temporaryPath = undefined;
            } finally {
                try {
                    if (temporaryPath && existsSync(temporaryPath)) {
                        unlinkSync(temporaryPath);
                    }
                } catch {
                    // Preserve the write error while leaving unrelated files alone.
                }
            }
            return next;
        } finally {
            this.releaseManifestTicket(ticket);
        }
    }

    deleteReviewProgress(manifestId: string): boolean {
        this.assertNoReviewBoundaries(manifestId);
        if (!this.loadManifest(manifestId)) {
            throw new Error(`Manifest not found: ${manifestId}.`);
        }
        const ticket = this.acquireManifestTicket(manifestId);
        try {
            return this.deleteReviewProgressUnderManifestTicket(manifestId);
        } finally {
            this.releaseManifestTicket(ticket);
        }
    }

    private loadReviewProgressNoBoundaries(
        manifest: StoredManifest,
        manifestId: string,
    ): ManifestReviewProgressV1 | null {
        const manifestState: string = manifest.state;
        if (
            manifestState !== 'awaiting_approval' &&
            manifestState !== 'approved'
        ) {
            throw new Error(
                `Invalid manifest state for review progress: ${manifestState}.`,
            );
        }
        const path = this.reviewPath(manifestId);
        if (!existsSync(path)) return null;
        const raw = parseReviewProgress(
            JSON.parse(readFileSync(path, 'utf8')),
        );
        if (raw.manifestId !== manifestId) {
            throw new Error(
                `Invalid review progress manifestId: expected ${manifestId}, received ${raw.manifestId}.`,
            );
        }
        const normalized = normalizeReviewProgressState(manifest, {
            acceptedTaskIds: raw.acceptedTaskIds,
            decision: raw.decision,
        });
        return {
            version: 1,
            manifestId: raw.manifestId,
            revision: raw.revision,
            ...normalized,
        };
    }

    private attemptReviewCleanup(manifestId: string): ReviewCleanupResult {
        try {
            assertNoSymlink(this.reviewRoot, '.sdd/reviews');
            assertNoSymlink(
                this.reviewPath(manifestId),
                `.sdd/reviews/${manifestId}.json`,
            );
            this.deleteReviewProgressUnderManifestTicket(manifestId);
            return { reviewCleanupPending: false };
        } catch (error) {
            return {
                reviewCleanupPending: true,
                reviewCleanupError: error instanceof Error
                    ? error.message
                    : String(error),
            };
        }
    }

    protected deleteReviewProgressUnderManifestTicket(
        manifestId: string,
    ): boolean {
        const path = this.reviewPath(manifestId);
        try {
            unlinkSync(path);
            return true;
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) return false;
            throw error;
        }
    }

    protected writeManifestAtomically(manifest: StoredManifest): void {
        const path = this.manifestPath(manifest.manifestId);
        mkdirSync(this.manifestRoot, { recursive: true });
        const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
        try {
            writeFileSync(
                temporaryPath,
                `${JSON.stringify(manifest, null, 2)}\n`,
                { flag: 'wx' },
            );
            renameSync(temporaryPath, path);
        } finally {
            try {
                if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
            } catch {
                // Preserve the write error while leaving unrelated files alone.
            }
        }
    }

    listManifests(): StoredManifest[] {
        if (!existsSync(this.manifestRoot)) return [];
        return readdirSync(this.manifestRoot)
            .filter((name) => name.endsWith('.json'))
            .toSorted()
            .map((name) =>
                JSON.parse(readFileSync(join(this.manifestRoot, name), 'utf8')),
            );
    }

    deleteManifest(manifestId: string): boolean {
        this.assertNoReviewBoundaries(manifestId);
        const path = this.manifestPath(manifestId);
        if (!this.loadManifest(manifestId)) {
            return false;
        }
        const ticket = this.acquireManifestTicket(manifestId);
        try {
            this.deleteReviewProgressUnderManifestTicket(manifestId);
            unlinkSync(path);
            return true;
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) return false;
            throw error;
        } finally {
            this.releaseManifestTicket(ticket);
        }
    }

    private acquireManifestTicket(manifestId: string): ObservedLock {
        mkdirSync(this.manifestRoot, { recursive: true });
        return this.acquireTicket(
            join(this.manifestRoot, `${manifestId}.lock-tickets`),
        );
    }

    private releaseManifestTicket(ticket: ObservedLock): void {
        this.releaseTicket(ticket);
        try {
            rmdirSync(resolve(ticket.path, '..'));
        } catch {
            // Concurrent or dead tickets intentionally keep the directory.
        }
    }

    private removeInitialRun(expected: RunSnapshot): void {
        const current = this.load(expected.runId);
        if (!current) return;
        if (snapshotDigest(current) !== snapshotDigest(expected)) {
            throw new Error(
                `Refusing to roll back changed run: ${expected.runId}.`,
            );
        }
        const runDir = this.runDir(expected.runId);
        unlinkSync(join(runDir, 'snapshot.json'));
        try {
            rmdirSync(join(runDir, 'snapshot.lock-tickets'));
        } catch {
            // create() normally removes its ticket directory.
        }
        rmdirSync(runDir);
    }

    private publishTicket(
        ticketDir: string,
        ticketNumber: number,
    ): ObservedLock {
        const nonce = randomUUID();
        const owner: LockOwner = {
            pid: process.pid,
            createdAt: new Date().toISOString(),
            nonce,
        };
        const candidate = join(ticketDir, `.${process.pid}.${nonce}.candidate`);
        const ticketPath = join(
            ticketDir,
            `${String(ticketNumber).padStart(6, '0')}.lock`,
        );
        let published: ObservedLock | undefined;
        try {
            writeFileSync(candidate, JSON.stringify(owner), { flag: 'wx' });
            const stats = lstatSync(candidate);
            linkSync(candidate, ticketPath);
            published = {
                device: stats.dev,
                inode: stats.ino,
                owner,
                path: ticketPath,
                number: ticketNumber,
            };
            unlinkSync(candidate);
            return published;
        } catch (error) {
            try {
                unlinkSync(candidate);
            } catch {
                // Preserve the publish error; the candidate is uniquely ours.
            }
            if (published) this.releaseTicket(published);
            throw error;
        }
    }

    private acquireTicket(ticketDir: string): ObservedLock {
        for (let attempt = 0; attempt < 8; attempt++) {
            mkdirSync(ticketDir, { recursive: true });
            const ticketNumbers = readdirSync(ticketDir)
                .map((name) => /^([0-9]+)\.lock$/.exec(name))
                .filter((match): match is RegExpExecArray => !!match)
                .map((match) => Number.parseInt(match[1], 10));
            const next = Math.max(0, ...ticketNumbers) + 1;
            let ticket: ObservedLock;
            try {
                ticket = this.publishTicket(ticketDir, next);
            } catch (error) {
                if (hasErrorCode(error, 'EEXIST')) continue;
                throw error;
            }
            try {
                this.assertLowerTickets(ticketDir, ticket);
                return ticket;
            } catch (error) {
                this.releaseTicket(ticket);
                throw error;
            }
        }
        throw new Error('Snapshot ticket acquisition contention.');
    }

    private assertLowerTickets(
        ticketDir: string,
        ownTicket: ObservedLock,
    ): void {
        for (const name of readdirSync(ticketDir).toSorted()) {
            const match = /^([0-9]+)\.lock$/.exec(name);
            if (!match) continue;
            const number = Number.parseInt(match[1], 10);
            if (number >= ownTicket.number) continue;
            const path = join(ticketDir, name);
            const lower = readLock(path);
            if (!lower || !hasDeadOwner(lower)) {
                throw new Error(
                    `Snapshot save blocked by lower ticket: ${name}.`,
                );
            }
            // ponytail: dead tickets are append-only; compact only if measured directory growth matters.
        }
    }

    private releaseTicket(expected: ObservedLock): boolean {
        const current = readLock(expected.path);
        if (!current || !sameLock(current, expected)) return false;
        try {
            unlinkSync(expected.path);
            return true;
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) return false;
            throw error;
        }
    }

    private runDir(runId: string): string {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(runId)) {
            throw new Error(`Invalid run ID: ${JSON.stringify(runId)}.`);
        }
        const resolved = resolve(this.root, runId);
        const relativePath = relative(this.root, resolved);
        if (
            !relativePath ||
            relativePath === '..' ||
            relativePath.startsWith(`..${sep}`) ||
            isAbsolute(relativePath)
        ) {
            throw new Error(`Invalid run ID: ${JSON.stringify(runId)}.`);
        }
        return resolved;
    }

    private manifestPath(manifestId: string): string {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(manifestId)) {
            throw new Error(
                `Invalid manifest ID: ${JSON.stringify(manifestId)}.`,
            );
        }
        const resolved = resolve(this.manifestRoot, `${manifestId}.json`);
        const relativePath = relative(this.manifestRoot, resolved);
        if (
            !relativePath ||
            relativePath === '..' ||
            relativePath.startsWith(`..${sep}`) ||
            isAbsolute(relativePath)
        ) {
            throw new Error(
                `Invalid manifest ID: ${JSON.stringify(manifestId)}.`,
            );
        }
        return resolved;
    }

    private reviewPath(manifestId: string): string {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(manifestId)) {
            throw new Error(
                `Invalid manifest ID: ${JSON.stringify(manifestId)}.`,
            );
        }
        const resolved = resolve(this.reviewRoot, `${manifestId}.json`);
        const relativePath = relative(this.reviewRoot, resolved);
        if (
            !relativePath ||
            relativePath === '..' ||
            relativePath.startsWith(`..${sep}`) ||
            isAbsolute(relativePath)
        ) {
            throw new Error(
                `Invalid manifest ID: ${JSON.stringify(manifestId)}.`,
            );
        }
        return resolved;
    }

    private assertNoReviewBoundaries(manifestId: string): void {
        assertNoSymlink(this.sddRoot, '.sdd');
        assertNoSymlink(this.manifestRoot, '.sdd/manifests');
        assertNoSymlink(this.manifestPath(manifestId), `.sdd/manifests/${manifestId}.json`);
        assertNoSymlink(this.reviewRoot, '.sdd/reviews');
        assertNoSymlink(
            this.reviewPath(manifestId),
            join('.sdd', 'reviews', `${manifestId}.json`),
        );
    }
}
