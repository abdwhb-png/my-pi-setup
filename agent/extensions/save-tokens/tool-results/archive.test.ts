import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    spyOn,
} from 'bun:test';
import {
    lstatSync,
    mkdtempSync,
    mkdirSync,
    unlinkSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    archiveOriginalToolResult,
    pruneToolResultArchive,
    managedOutputArchive,
} from './archive';

const ARCHIVE_NAME = (timestamp: number, suffix: string) =>
    `${timestamp}-bash-call-${suffix.padStart(12, 'a')}.txt`;

let archiveRoot: string;
let previousArchiveRoot: string | undefined;

beforeEach(() => {
    archiveRoot = mkdtempSync(join(tmpdir(), 'pi-tool-archive-'));
    previousArchiveRoot = process.env.PI_TOOL_RESULT_ARCHIVE_DIR;
    process.env.PI_TOOL_RESULT_ARCHIVE_DIR = archiveRoot;
});

afterEach(() => {
    if (previousArchiveRoot === undefined) {
        delete process.env.PI_TOOL_RESULT_ARCHIVE_DIR;
    } else {
        process.env.PI_TOOL_RESULT_ARCHIVE_DIR = previousArchiveRoot;
    }
    rmSync(archiveRoot, { recursive: true, force: true });
});

describe('archiveOriginalToolResult', () => {
    it('preserves an existing archive pair when a filename collides', async () => {
        const clock = spyOn(Date, 'now').mockReturnValue(12345);
        try {
            const input = { toolCallId: 'same-call', toolName: 'bash', text: 'keep original' };
            const path = await archiveOriginalToolResult(input);
            await expect(archiveOriginalToolResult(input)).rejects.toThrow();
            expect(readFileSync(path, 'utf8')).toBe(input.text);
            expect(JSON.parse(readFileSync(`${path}.meta.json`, 'utf8')).kind).toBe('output-text');
        } finally { clock.mockRestore(); }
    });
    it('identifies legacy archives without inventing source provenance', async () => {
        const path = join(archiveRoot, ARCHIVE_NAME(Date.now(), '1'));
        writeFileSync(path, 'legacy bytes');
        expect(await managedOutputArchive(path)).toMatchObject({ sourceMetadata: 'missing', sourceExecution: { status: 'unknown' }, storage: { status: 'unsandboxed' } });
    });
    it('keeps archive bytes readable when its sidecar cannot be read', async () => {
        const path = await archiveOriginalToolResult({ toolCallId: 'sidecar-failure', toolName: 'bash', text: 'exact bytes' });
        unlinkSync(`${path}.meta.json`);
        mkdirSync(`${path}.meta.json`);
        expect(await managedOutputArchive(path)).toMatchObject({ kind: 'output-text', sourceExecution: { status: 'unknown' }, sourceMetadata: 'unavailable' });
        expect(readFileSync(path, 'utf8')).toBe('exact bytes');
    });
    it('stores text exactly without a metadata header', async () => {
        const path = await archiveOriginalToolResult({
            toolCallId: 'call-1',
            toolName: 'bash',
            text: 'alpha\nbêta',
        });

        expect(readFileSync(path, 'utf8')).toBe('alpha\nbêta');
        expect(JSON.parse(readFileSync(`${path}.meta.json`, 'utf8'))).toMatchObject({ version: 1, kind: 'output-text', storage: { status: 'unsandboxed', tmpNamespace: 'host' }, sourceExecution: { status: 'unknown' } });
        expect(lstatSync(archiveRoot).mode & 0o777).toBe(0o700);
        expect(lstatSync(path).mode & 0o777).toBe(0o600);
    });

    it('copies a full-output source byte for byte', async () => {
        const sourcePath = join(archiveRoot, 'source.bin');
        writeFileSync(sourcePath, Buffer.from([0, 1, 2, 255]));

        const path = await archiveOriginalToolResult({
            toolCallId: 'call-2',
            toolName: 'bash',
            text: 'truncated display',
            sourcePath,
        });

        expect(readFileSync(path)).toEqual(Buffer.from([0, 1, 2, 255]));
        expect(lstatSync(path).mode & 0o777).toBe(0o600);
    });

    it('rejects an unreadable declared full-output source', async () => {
        await expect(
            archiveOriginalToolResult({
                toolCallId: 'call-3',
                toolName: 'bash',
                text: 'truncated display',
                sourcePath: join(archiveRoot, 'missing.txt'),
            }),
        ).rejects.toThrow();
    });
});

describe('pruneToolResultArchive', () => {
    it('removes expired managed files but preserves unknown entries', async () => {
        const nowMs = Date.UTC(2026, 6, 19);
        const old = join(archiveRoot, ARCHIVE_NAME(nowMs - 31 * 86_400_000, '1'));
        const fresh = join(archiveRoot, ARCHIVE_NAME(nowMs - 1_000, '2'));
        const unknown = join(archiveRoot, 'notes.txt');
        writeFileSync(old, 'old');
        writeFileSync(`${old}.meta.json`, '{}');
        writeFileSync(fresh, 'fresh');
        writeFileSync(unknown, 'keep');

        const summary = await pruneToolResultArchive({
            archiveRoot,
            maxAgeDays: 30,
            maxBytes: 1_000,
            nowMs,
        });

        expect(summary.removedFiles).toBe(1);
        expect(() => lstatSync(old)).toThrow();
        expect(() => lstatSync(`${old}.meta.json`)).toThrow();
        expect(readFileSync(fresh, 'utf8')).toBe('fresh');
        expect(readFileSync(unknown, 'utf8')).toBe('keep');
    });

    it('deletes oldest managed files until within the size limit', async () => {
        const nowMs = Date.UTC(2026, 6, 19);
        const oldest = join(archiveRoot, ARCHIVE_NAME(nowMs - 3_000, '1'));
        const middle = join(archiveRoot, ARCHIVE_NAME(nowMs - 2_000, '2'));
        const newest = join(archiveRoot, ARCHIVE_NAME(nowMs - 1_000, '3'));
        writeFileSync(oldest, '1111');
        writeFileSync(middle, '2222');
        writeFileSync(newest, '3333');

        const summary = await pruneToolResultArchive({
            archiveRoot,
            maxAgeDays: 30,
            maxBytes: 8,
            nowMs,
        });

        expect(summary.removedFiles).toBe(1);
        expect(() => lstatSync(oldest)).toThrow();
        expect(readFileSync(middle, 'utf8')).toBe('2222');
        expect(readFileSync(newest, 'utf8')).toBe('3333');
    });

    it('ignores symlinks and retains one oversized newest archive', async () => {
        const nowMs = Date.UTC(2026, 6, 19);
        const managed = join(archiveRoot, ARCHIVE_NAME(nowMs - 1_000, '1'));
        const target = join(archiveRoot, 'target.txt');
        const link = join(archiveRoot, ARCHIVE_NAME(nowMs - 2_000, '2'));
        writeFileSync(managed, 'oversized');
        writeFileSync(target, 'target');
        symlinkSync(target, link);

        const summary = await pruneToolResultArchive({
            archiveRoot,
            maxAgeDays: 30,
            maxBytes: 2,
            nowMs,
        });

        expect(summary.limitExceeded).toBe(true);
        expect(readFileSync(managed, 'utf8')).toBe('oversized');
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
    });

    it('treats a missing archive directory as a no-op', async () => {
        const missing = join(archiveRoot, 'missing');
        await expect(
            pruneToolResultArchive({
                archiveRoot: missing,
                maxAgeDays: 30,
                maxBytes: 100,
                nowMs: Date.now(),
            }),
        ).resolves.toEqual({
            removedFiles: 0,
            removedBytes: 0,
            remainingBytes: 0,
            limitExceeded: false,
        });
    });
});
