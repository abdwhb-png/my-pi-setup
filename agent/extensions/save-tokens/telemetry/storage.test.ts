/**
 * Comprehensive test suite for secure JSONL telemetry storage.
 *
 * Covers:
 * - Session ID sanitization (pure, no I/O)
 * - Date partition extraction (pure, no I/O)
 * - Path resolution with traversal protection
 * - Append-only writer with Promise queue ordering
 * - Error isolation in concurrent writes
 * - Line-by-line reader (empty, invalid, truncated lines)
 * - TTL purge with at-most-once-per-day guard
 *
 * All I/O tests use real temporary directories via mkdtemp.
 */

import { describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    sanitizeSessionId,
    datePartition,
    isValidCalendarDate,
    resolveTelemetryPath,
    createWriter,
    readTelemetryFile,
    purgeTelemetry,
    type TelemetryWriter,
    type TelemetryReadResult,
    type TelemetryPurgeResult,
} from './storage';
import { TELEMETRY_SCHEMA_VERSION } from './types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal valid telemetry event for writer tests.
 */
function makeEvent(overrides: Record<string, unknown> = {}) {
    return {
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        eventId: 'evt-test-001',
        timestamp: new Date().toISOString(),
        sessionId: 'sess-test-abc',
        event: 'experiment_tag',
        tag: 'test',
        ...overrides,
    };
}

/**
 * Create a temporary directory for I/O tests.
 */
async function tempDir(): Promise<string> {
    return await mkdtemp(join(tmpdir(), 'st-test-'));
}

/**
 * Check if the current platform appears to support POSIX permissions.
 */
function isPosix(): boolean {
    return process.platform !== 'win32';
}

// ===========================================================================
// 1. Session ID sanitization
// ===========================================================================

describe('sanitizeSessionId', () => {
    it('accepts normal alphanumeric IDs', () => {
        expect(sanitizeSessionId('abc123')).toBe('abc123');
    });

    it('accepts hyphens, underscores, and dots', () => {
        expect(sanitizeSessionId('sess-abc_123.def')).toBe('sess-abc_123.def');
    });

    it('rejects empty string', () => {
        expect(() => sanitizeSessionId('')).toThrow('non-empty string');
    });

    it('rejects "."', () => {
        expect(() => sanitizeSessionId('.')).toThrow('cannot be "."');
    });

    it('rejects ".."', () => {
        expect(() => sanitizeSessionId('..')).toThrow('cannot be ".."');
    });

    it('rejects forward slash', () => {
        expect(() => sanitizeSessionId('a/b')).toThrow('unsafe characters');
    });

    it('rejects backslash', () => {
        expect(() => sanitizeSessionId('a\\b')).toThrow('unsafe characters');
    });

    it('rejects whitespace', () => {
        expect(() => sanitizeSessionId('a b')).toThrow('unsafe characters');
    });

    it('rejects null characters', () => {
        expect(() => sanitizeSessionId('a\x00b')).toThrow('unsafe characters');
    });

    it('rejects undefined input', () => {
        // @ts-expect-error undefined is not a string
        expect(() => sanitizeSessionId(undefined)).toThrow('non-empty string');
    });
});

// ===========================================================================
// 2. Date partition
// ===========================================================================

describe('datePartition', () => {
    it('extracts YYYY-MM-DD from valid ISO timestamp', () => {
        expect(datePartition('2026-07-18T12:34:56.789Z')).toBe('2026-07-18');
    });

    it('returns current date for undefined timestamp', () => {
        const got = datePartition(undefined);
        expect(got).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(got).toBe(new Date().toISOString().slice(0, 10));
    });

    it('returns current date for invalid timestamp string', () => {
        const got = datePartition('not-a-date');
        expect(got).toBe(new Date().toISOString().slice(0, 10));
    });

    it('handles timestamp with timezone offset', () => {
        expect(datePartition('2026-06-15T00:00:00+02:00')).toBe('2026-06-15');
    });

    it('handles date-only string', () => {
        expect(datePartition('2026-01-01')).toBe('2026-01-01');
    });
});

// ===========================================================================
// 2b. Calendar date validation
// ===========================================================================

describe('isValidCalendarDate', () => {
    it('accepts valid dates', () => {
        expect(isValidCalendarDate('2026-07-18')).toBe(true);
        expect(isValidCalendarDate('2024-02-29')).toBe(true); // leap year
        expect(isValidCalendarDate('2000-02-29')).toBe(true); // leap year
        expect(isValidCalendarDate('2023-02-28')).toBe(true);
        expect(isValidCalendarDate('2026-01-01')).toBe(true);
        expect(isValidCalendarDate('2026-12-31')).toBe(true);
    });

    it('rejects impossible months', () => {
        expect(isValidCalendarDate('2026-13-01')).toBe(false);
        expect(isValidCalendarDate('2026-00-01')).toBe(false);
        expect(isValidCalendarDate('2026-99-01')).toBe(false);
    });

    it('rejects impossible days', () => {
        expect(isValidCalendarDate('2026-01-32')).toBe(false);
        expect(isValidCalendarDate('2026-04-31')).toBe(false);
        expect(isValidCalendarDate('2026-02-29')).toBe(false); // not leap year
        expect(isValidCalendarDate('2026-02-30')).toBe(false);
        expect(isValidCalendarDate('2026-02-00')).toBe(false);
    });

    it('rejects non-date strings', () => {
        expect(isValidCalendarDate('not-a-date')).toBe(false);
        expect(isValidCalendarDate('')).toBe(false);
        expect(isValidCalendarDate('2026-07-18extra')).toBe(false);
        expect(isValidCalendarDate('2026-07-18 ')).toBe(false);
    });

    it('rejects date with time suffix', () => {
        expect(isValidCalendarDate('2026-07-18T00:00:00Z')).toBe(false);
        expect(isValidCalendarDate('2026-07-18T12:00:00.000Z')).toBe(false);
    });
});

describe('datePartition — calendar validation', () => {
    it('falls back to today for impossible calendar date in timestamp', () => {
        const got = datePartition('2026-99-99T12:00:00Z');
        expect(got).toBe(new Date().toISOString().slice(0, 10));
    });

    it('falls back to today for impossible day in timestamp', () => {
        const got = datePartition('2026-02-30T12:00:00Z');
        expect(got).toBe(new Date().toISOString().slice(0, 10));
    });

    it('accepts valid leap year date', () => {
        expect(datePartition('2024-02-29T12:00:00Z')).toBe('2024-02-29');
    });

    it('rejects non-leap-year Feb 29', () => {
        const got = datePartition('2023-02-29T12:00:00Z');
        expect(got).toBe(new Date().toISOString().slice(0, 10));
    });
});

// ===========================================================================
// 3. Path resolution
// ===========================================================================

describe('resolveTelemetryPath', () => {
    it('produces correct path for valid inputs', () => {
        const root = '/tmp/telemetry';
        const path = resolveTelemetryPath(root, '2026-07-18', 'sess-abc');
        expect(path).toBe('/tmp/telemetry/2026-07-18/sess-abc.jsonl');
    });

    it('throws on invalid sessionId', () => {
        expect(() =>
            resolveTelemetryPath('/tmp', '2026-07-18', '../evil'),
        ).toThrow();
    });

    it('throws when resolved path escapes root via ..', () => {
        const root = '/tmp';
        expect(() =>
            resolveTelemetryPath(root, '2026-07-18', '..'),
        ).toThrow();
    });

    it('resolves the root correctly when path is relative', () => {
        const root = 'relative/path';
        const resolved = resolveTelemetryPath(root, '2026-07-18', 'sess-abc');
        expect(resolved).toContain('2026-07-18/sess-abc.jsonl');
        expect(resolved).not.toBe(root + '/2026-07-18/sess-abc.jsonl');
    });
});

describe('resolveTelemetryPath — date validation', () => {
    it('throws on invalid calendar date', () => {
        expect(() =>
            resolveTelemetryPath('/tmp', '2026-99-99', 'sess-abc'),
        ).toThrow('Invalid date');
    });

    it('throws on impossible month', () => {
        expect(() =>
            resolveTelemetryPath('/tmp', '2026-13-01', 'sess-abc'),
        ).toThrow('Invalid date');
    });

    it('throws on impossible day', () => {
        expect(() =>
            resolveTelemetryPath('/tmp', '2026-02-30', 'sess-abc'),
        ).toThrow('Invalid date');
    });

    it('throws on date with suffix', () => {
        expect(() =>
            resolveTelemetryPath('/tmp', '2026-07-18extra', 'sess-abc'),
        ).toThrow();
    });
});

// ===========================================================================
// 4. Writer — structure and basic I/O
// ===========================================================================

describe('createWriter', () => {
    it('returns an object with append and flush methods', () => {
        const w = createWriter('/tmp', 'sess-test');
        expect(typeof w.append).toBe('function');
        expect(typeof w.flush).toBe('function');
    });

    it('throws on invalid sessionId', () => {
        expect(() => createWriter('/tmp', '../evil')).toThrow();
    });
});

describe('writer — file creation and content', () => {
    it('creates the JSONL file and writes one record', async () => {
        const root = await tempDir();
        const writer = createWriter(root, 'sess-001');
        await writer.append(makeEvent());
        await writer.flush();

        const result = await readTelemetryFile(root, datePartition(), 'sess-001');
        expect(result.records).toHaveLength(1);
        expect(result.records[0].eventId).toBe('evt-test-001');
    });

    it('multiple appends create multiple valid lines', async () => {
        const root = await tempDir();
        const writer = createWriter(root, 'sess-002');
        await writer.append(makeEvent({ eventId: 'evt-1' }));
        await writer.append(makeEvent({ eventId: 'evt-2' }));
        await writer.append(makeEvent({ eventId: 'evt-3' }));
        await writer.flush();

        const result = await readTelemetryFile(root, datePartition(), 'sess-002');
        expect(result.records).toHaveLength(3);
        expect(result.records[0].eventId).toBe('evt-1');
        expect(result.records[1].eventId).toBe('evt-2');
        expect(result.records[2].eventId).toBe('evt-3');
    });

    it('append is append-only (does not truncate)', async () => {
        const root = await tempDir();
        const writer = createWriter(root, 'sess-003');

        // First write
        await writer.append(makeEvent({ eventId: 'evt-first' }));
        await writer.flush();

        // Second write with same writer instance
        await writer.append(makeEvent({ eventId: 'evt-second' }));
        await writer.flush();

        const result = await readTelemetryFile(root, datePartition(), 'sess-003');
        expect(result.records).toHaveLength(2);
        expect(result.records[0].eventId).toBe('evt-first');
        expect(result.records[1].eventId).toBe('evt-second');
    });
});

describe('writer — directory structure', () => {
    it('creates nested root/YYYY-MM-DD/ path', async () => {
        const root = await tempDir();
        const today = datePartition();
        const writer = createWriter(root, 'sess-dir');
        await writer.append(makeEvent());
        await writer.flush();

        const { stat } = await import('node:fs/promises');
        const dirStat = await stat(join(root, today));
        expect(dirStat.isDirectory()).toBe(true);
    });

    it('file has .jsonl extension', async () => {
        const root = await tempDir();
        const today = datePartition();
        const writer = createWriter(root, 'sess-ext');
        await writer.append(makeEvent());
        await writer.flush();

        const { stat } = await import('node:fs/promises');
        const fileStat = await stat(join(root, today, 'sess-ext.jsonl'));
        expect(fileStat.isFile()).toBe(true);
    });
});

describe('writer — directory permissions (POSIX)', () => {
    it('creates date directory with 0700 permissions', async () => {
        if (!isPosix()) return;
        const root = await tempDir();
        const today = datePartition();
        const writer = createWriter(root, 'sess-perm-dir');
        await writer.append(makeEvent());
        await writer.flush();

        const { stat } = await import('node:fs/promises');
        const dirStat = await stat(join(root, today));
        const mode = dirStat.mode & 0o777;
        expect(mode).toBe(0o700);
    });

    it('forces root directory to 0700 even if initially permissive', async () => {
        if (!isPosix()) return;
        const root = await tempDir();
        // Make root permissive first
        const { chmod } = await import('node:fs/promises');
        await chmod(root, 0o777);

        const writer = createWriter(root, 'sess-root-perm');
        await writer.append(makeEvent());
        await writer.flush();

        const { stat } = await import('node:fs/promises');
        const rootStat = await stat(root);
        const mode = rootStat.mode & 0o777;
        expect(mode).toBe(0o700);
    });
});

describe('writer — file permissions (POSIX)', () => {
    it('creates JSONL file with 0600 permissions', async () => {
        if (!isPosix()) return;
        const root = await tempDir();
        const today = datePartition();
        const writer = createWriter(root, 'sess-perm-file');
        await writer.append(makeEvent());
        await writer.flush();

        const { stat } = await import('node:fs/promises');
        const fileStat = await stat(join(root, today, 'sess-perm-file.jsonl'));
        const mode = fileStat.mode & 0o777;
        expect(mode).toBe(0o600);
    });
});

// ===========================================================================
// 5. Concurrent writes and error isolation
// ===========================================================================

describe('writer — concurrent writes ordering', () => {
    it('maintains order of concurrent append calls', async () => {
        const root = await tempDir();
        const writer = createWriter(root, 'sess-concur');

        // Fire three appends concurrently (no await between them)
        const p1 = writer.append(makeEvent({ eventId: 'evt-con-1', timestamp: '2026-07-18T00:00:01Z' }));
        const p2 = writer.append(makeEvent({ eventId: 'evt-con-2', timestamp: '2026-07-18T00:00:02Z' }));
        const p3 = writer.append(makeEvent({ eventId: 'evt-con-3', timestamp: '2026-07-18T00:00:03Z' }));

        await Promise.all([p1, p2, p3]);
        await writer.flush();

        const result = await readTelemetryFile(root, datePartition(), 'sess-concur');
        expect(result.records).toHaveLength(3);
        expect(result.records[0].eventId).toBe('evt-con-1');
        expect(result.records[1].eventId).toBe('evt-con-2');
        expect(result.records[2].eventId).toBe('evt-con-3');
    });
});

describe('writer — error recovery', () => {
    it('a write error does not block subsequent writes', async () => {
        const root = await tempDir();
        const writer = createWriter(root, 'sess-err-recovery');

        // Write one valid record
        await writer.append(makeEvent({ eventId: 'evt-before' }));
        await writer.flush();

        const today = datePartition();

        // Force a failure by making the file read-only on POSIX
        // On non-POSIX, simulate by closing the fd differently.
        if (isPosix()) {
            const { chmod } = await import('node:fs/promises');
            const filePath = join(root, today, 'sess-err-recovery.jsonl');
            await chmod(filePath, 0o000); // remove all permissions

            // This append should reject (no write permission)
            const badWrite = writer.append(makeEvent({ eventId: 'evt-fail' }));
            await expect(badWrite).rejects.toThrow();

            // Restore permissions
            await chmod(filePath, 0o600);
        } else {
            // On non-POSIX, simulate by passing an invalid record that
            // triggers a file error. Use a non-serializable value.
            // Actually, all JSON values are serializable. Skip error test.
            // Just verify that two sequential writes work.
        }

        // This append should succeed even though previous failed
        await writer.append(makeEvent({ eventId: 'evt-after' }));
        await writer.flush();

        const result = await readTelemetryFile(root, today, 'sess-err-recovery');
        if (isPosix()) {
            expect(result.records).toHaveLength(2);
            expect(result.records[0].eventId).toBe('evt-before');
            expect(result.records[1].eventId).toBe('evt-after');
        } else {
            // On non-POSIX without error, we should have 2 records
            expect(result.records).toHaveLength(2);
        }
    });
});

describe('writer — timestamp-based partitioning', () => {
    it('writes records with different dates to different files', async () => {
        const root = await tempDir();
        const writer = createWriter(root, 'sess-part');

        await writer.append(makeEvent({ eventId: 'evt-day1', timestamp: '2026-07-01T12:00:00Z' }));
        await writer.append(makeEvent({ eventId: 'evt-day2', timestamp: '2026-07-02T12:00:00Z' }));
        await writer.append(makeEvent({ eventId: 'evt-day3', timestamp: '2026-07-03T12:00:00Z' }));
        await writer.flush();

        const day1 = await readTelemetryFile(root, '2026-07-01', 'sess-part');
        const day2 = await readTelemetryFile(root, '2026-07-02', 'sess-part');
        const day3 = await readTelemetryFile(root, '2026-07-03', 'sess-part');

        expect(day1.records).toHaveLength(1);
        expect(day1.records[0].eventId).toBe('evt-day1');
        expect(day2.records).toHaveLength(1);
        expect(day2.records[0].eventId).toBe('evt-day2');
        expect(day3.records).toHaveLength(1);
        expect(day3.records[0].eventId).toBe('evt-day3');
    });

    it('maintains append order across different dates', async () => {
        const root = await tempDir();
        const writer = createWriter(root, 'sess-part-order');

        await writer.append(makeEvent({ eventId: 'evt-1', timestamp: '2026-07-01T12:00:00Z' }));
        await writer.append(makeEvent({ eventId: 'evt-2', timestamp: '2026-07-02T12:00:00Z' }));
        await writer.append(makeEvent({ eventId: 'evt-3', timestamp: '2026-07-01T12:00:00Z' }));
        await writer.flush();

        const day1 = await readTelemetryFile(root, '2026-07-01', 'sess-part-order');
        const day2 = await readTelemetryFile(root, '2026-07-02', 'sess-part-order');

        expect(day1.records).toHaveLength(2);
        expect(day1.records[0].eventId).toBe('evt-1');
        expect(day1.records[1].eventId).toBe('evt-3');
        expect(day2.records).toHaveLength(1);
        expect(day2.records[0].eventId).toBe('evt-2');
    });

    it('flush waits for all partitions', async () => {
        const root = await tempDir();
        const writer = createWriter(root, 'sess-part-flush');

        writer.append(makeEvent({ eventId: 'evt-a', timestamp: '2026-07-01T12:00:00Z' }));
        writer.append(makeEvent({ eventId: 'evt-b', timestamp: '2026-07-02T12:00:00Z' }));
        await writer.flush();

        const day1 = await readTelemetryFile(root, '2026-07-01', 'sess-part-flush');
        const day2 = await readTelemetryFile(root, '2026-07-02', 'sess-part-flush');

        expect(day1.records).toHaveLength(1);
        expect(day2.records).toHaveLength(1);
    });
});

// ===========================================================================
// 6. Reader — edge cases
// ===========================================================================

describe('readTelemetryFile', () => {
    it('returns empty result for non-existent file', async () => {
        const root = await tempDir();
        const result = await readTelemetryFile(root, '2026-07-18', 'sess-nonexist');
        expect(result.records).toEqual([]);
        expect(result.invalidLines).toBe(0);
        expect(result.emptyLines).toBe(0);
    });

    it('returns empty result for empty file', async () => {
        const root = await tempDir();
        const today = datePartition();
        const dir = join(root, today);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'sess-empty.jsonl'), '', 'utf-8');

        const result = await readTelemetryFile(root, today, 'sess-empty');
        expect(result.records).toEqual([]);
        expect(result.invalidLines).toBe(0);
        expect(result.emptyLines).toBe(0);
    });

    it('tolerates empty lines in the middle of the file', async () => {
        const root = await tempDir();
        const today = datePartition();
        const dir = join(root, today);
        await mkdir(dir, { recursive: true });
        const content =
            JSON.stringify(makeEvent({ eventId: 'evt-1' })) + '\n\n\n' +
            JSON.stringify(makeEvent({ eventId: 'evt-2' })) + '\n';
        await writeFile(join(dir, 'sess-empty-mid.jsonl'), content, 'utf-8');

        const result = await readTelemetryFile(root, today, 'sess-empty-mid');
        expect(result.records).toHaveLength(2);
        expect(result.emptyLines).toBe(2);
    });

    it('ignores invalid JSON lines', async () => {
        const root = await tempDir();
        const today = datePartition();
        const dir = join(root, today);
        await mkdir(dir, { recursive: true });
        const content =
            JSON.stringify(makeEvent({ eventId: 'evt-1' })) + '\n' +
            'not-json\n' +
            JSON.stringify(makeEvent({ eventId: 'evt-2' })) + '\n';
        await writeFile(join(dir, 'sess-invalid.jsonl'), content, 'utf-8');

        const result = await readTelemetryFile(root, today, 'sess-invalid');
        expect(result.records).toHaveLength(2);
        expect(result.invalidLines).toBe(1);
    });

    it('accepts last line without trailing newline', async () => {
        const root = await tempDir();
        const today = datePartition();
        const dir = join(root, today);
        await mkdir(dir, { recursive: true });
        const content =
            JSON.stringify(makeEvent({ eventId: 'evt-1' })) + '\n' +
            JSON.stringify(makeEvent({ eventId: 'evt-2' }));
        await writeFile(join(dir, 'sess-notrunc.jsonl'), content, 'utf-8');

        const result = await readTelemetryFile(root, today, 'sess-notrunc');
        expect(result.records).toHaveLength(2);
        expect(result.invalidLines).toBe(0);
    });

    it('counts truncated (invalid) last line', async () => {
        const root = await tempDir();
        const today = datePartition();
        const dir = join(root, today);
        await mkdir(dir, { recursive: true });
        // Last line is truncated JSON
        const content = JSON.stringify(makeEvent({ eventId: 'evt-1' })) + '\n{"incomplete": ';
        await writeFile(join(dir, 'sess-trunc.jsonl'), content, 'utf-8');

        const result = await readTelemetryFile(root, today, 'sess-trunc');
        expect(result.records).toHaveLength(1);
        expect(result.invalidLines).toBe(1);
    });

    it('only returns records matching schema version and minimal shape', async () => {
        const root = await tempDir();
        const today = datePartition();
        const dir = join(root, today);
        await mkdir(dir, { recursive: true });

        const valid = makeEvent({ eventId: 'evt-valid' });
        const wrongVersion = { ...makeEvent({ eventId: 'evt-wrong-ver' }), schemaVersion: 999 };
        const missingField = { ...makeEvent(), eventId: undefined, event: 'session_start' };
        const notObject = '"just a string"';

        const content = [
            JSON.stringify(valid),
            JSON.stringify(wrongVersion),
            JSON.stringify(missingField),
            notObject,
        ].join('\n') + '\n';

        await writeFile(join(dir, 'sess-validate.jsonl'), content, 'utf-8');

        const result = await readTelemetryFile(root, today, 'sess-validate');
        expect(result.records).toHaveLength(1);
        expect(result.records[0].eventId).toBe('evt-valid');
        expect(result.invalidLines).toBe(3);
    });

    it('throws on invalid date format', async () => {
        await expect(
            readTelemetryFile('/tmp', 'not-a-date', 'sess-abc'),
        ).rejects.toThrow('Invalid date');
    });

    it('handles CRLF line endings', async () => {
        const root = await tempDir();
        const today = datePartition();
        const dir = join(root, today);
        await mkdir(dir, { recursive: true });
        const content =
            JSON.stringify(makeEvent({ eventId: 'evt-crlf-1' })) + '\r\n' +
            JSON.stringify(makeEvent({ eventId: 'evt-crlf-2' })) + '\r\n';
        await writeFile(join(dir, 'sess-crlf.jsonl'), content, 'utf-8');

        const result = await readTelemetryFile(root, today, 'sess-crlf');
        expect(result.records).toHaveLength(2);
    });
});

// ===========================================================================
// 7. Purge
// ===========================================================================

describe('purgeTelemetry', () => {
    it('throws on invalid retentionDays', async () => {
        await expect(
            purgeTelemetry('/tmp', { retentionDays: -1.5 } as never),
        ).rejects.toThrow();
    });

    it('returns zeroes for non-existent root', async () => {
        const root = join(await tempDir(), 'nonexistent');
        const result = await purgeTelemetry(root, { retentionDays: 30 });
        expect(result).toEqual({ deleted: 0, skipped: 0, errors: 0 });
    });

    it('deletes directories older than the cutoff', async () => {
        const root = await tempDir();

        await mkdir(join(root, '2025-01-01'), { recursive: true });
        await writeFile(join(root, '2025-01-01', 'data.jsonl'), 'content');
        await mkdir(join(root, '2026-07-18'), { recursive: true });

        const result = await purgeTelemetry(root, {
            retentionDays: 30,
            now: new Date('2026-07-18T12:00:00Z'),
        });

        expect(result.deleted).toBe(1);
        expect(result.skipped).toBe(1);

        const { stat } = await import('node:fs/promises');
        await expect(stat(join(root, '2025-01-01'))).rejects.toThrow('ENOENT');
        await expect(stat(join(root, '2026-07-18'))).resolves.toBeDefined();
    });

    it('keeps directories within retention period', async () => {
        const root = await tempDir();

        for (const d of ['2026-06-18', '2026-07-01', '2026-07-17']) {
            await mkdir(join(root, d), { recursive: true });
        }

        const result = await purgeTelemetry(root, {
            retentionDays: 30,
            now: new Date('2026-07-18T12:00:00Z'),
        });

        // cutoff = 2026-07-18 - 30 = 2026-06-18
        // All entries >= cutoff → kept
        expect(result.deleted).toBe(0);
        expect(result.skipped).toBe(3);
    });

    it('deletes directories strictly older than cutoff (boundary test)', async () => {
        const root = await tempDir();

        await mkdir(join(root, '2026-06-17'), { recursive: true });
        await mkdir(join(root, '2026-06-18'), { recursive: true });
        await mkdir(join(root, '2026-06-19'), { recursive: true });

        const result = await purgeTelemetry(root, {
            retentionDays: 30,
            now: new Date('2026-07-18T12:00:00Z'),
        });

        expect(result.deleted).toBe(1); // only 2026-06-17 (< cutoff)
        expect(result.skipped).toBe(2); // 2026-06-18 and 2026-06-19 kept
    });

    it('ignores non-date directories', async () => {
        const root = await tempDir();

        await mkdir(join(root, '2026-01-01'), { recursive: true });
        await mkdir(join(root, 'config'), { recursive: true });
        await mkdir(join(root, '.last-purge'), { recursive: true });
        await mkdir(join(root, 'notes'), { recursive: true });

        const result = await purgeTelemetry(root, {
            retentionDays: 30,
            now: new Date('2026-07-18T12:00:00Z'),
        });

        expect(result.deleted).toBe(1);
        expect(result.skipped).toBe(3);

        const { stat } = await import('node:fs/promises');
        await expect(stat(join(root, 'config'))).resolves.toBeDefined();
        await expect(stat(join(root, '.last-purge'))).resolves.toBeDefined();
    });

    it('ignores files directly in root', async () => {
        const root = await tempDir();

        await mkdir(join(root, '2026-01-01'), { recursive: true });
        await writeFile(join(root, 'readme.md'), 'hello');
        await writeFile(join(root, 'data.jsonl'), '{}');

        const result = await purgeTelemetry(root, {
            retentionDays: 30,
            now: new Date('2026-07-18T12:00:00Z'),
        });

        expect(result.deleted).toBe(1);
        expect(result.skipped).toBe(2);
    });

    it('does not follow symlinks during purge', async () => {
        const root = await tempDir();
        const outsideDir = await tempDir();

        await mkdir(join(root, '2026-01-01'), { recursive: true });
        try {
            await symlink(outsideDir, join(root, 'linked-dir'));
        } catch {
            return; // symlink creation may fail on some systems
        }

        const result = await purgeTelemetry(root, {
            retentionDays: 30,
            now: new Date('2026-07-18T12:00:00Z'),
        });

        expect(result.deleted).toBe(1);
        expect(result.skipped).toBe(1);

        const { stat } = await import('node:fs/promises');
        await expect(stat(outsideDir)).resolves.toBeDefined();
    });

    it('distinguishes dirs at the boundary of cutoff string comparison', async () => {
        const root = await tempDir();

        await mkdir(join(root, '2026-06-17'), { recursive: true });
        await mkdir(join(root, '2026-06-18'), { recursive: true });

        const result = await purgeTelemetry(root, {
            retentionDays: 30,
            now: new Date('2026-07-18T23:59:59Z'),
        });

        // cutoff = 2026-07-18 - 30 = 2026-06-18
        expect(result.deleted).toBe(1);
        expect(result.skipped).toBe(1);
    });

    it('continues past individual errors', async () => {
        const root = await tempDir();

        await mkdir(join(root, '2025-01-01'), { recursive: true });
        await mkdir(join(root, '2025-01-02'), { recursive: true });
        await mkdir(join(root, '2025-01-03'), { recursive: true });

        // Make one directory read-only so rm fails (POSIX only)
        if (isPosix()) {
            const { chmod } = await import('node:fs/promises');
            await chmod(join(root, '2025-01-02'), 0o000);
        }

        const result = await purgeTelemetry(root, {
            retentionDays: 0,
            now: new Date('2026-07-18T12:00:00Z'),
        });

        expect(result.deleted).toBeGreaterThanOrEqual(2);
        if (isPosix()) {
            expect(result.errors).toBeGreaterThanOrEqual(1);
        }

        // Restore permissions for cleanup
        if (isPosix()) {
            const { chmod } = await import('node:fs/promises');
            try { await chmod(join(root, '2025-01-02'), 0o755); } catch { /* ignore */ }
        }
    });
});

// ===========================================================================
// 8. Purge — at-most-once-per-day guard
// ===========================================================================

describe('purgeTelemetry — at-most-once-per-day guard', () => {
    it('skips purge when lastPurgedAt matches today', async () => {
        const root = await tempDir();
        await mkdir(join(root, '2025-01-01'), { recursive: true });

        const result = await purgeTelemetry(root, {
            retentionDays: 30,
            now: new Date('2026-07-18T12:00:00Z'),
            lastPurgedAt: '2026-07-18',
        });

        expect(result).toEqual({ deleted: 0, skipped: 0, errors: 0 });
    });

    it('allows purge when lastPurgedAt is a different date', async () => {
        const root = await tempDir();
        await mkdir(join(root, '2025-01-01'), { recursive: true });
        await mkdir(join(root, '2026-07-18'), { recursive: true });

        const result = await purgeTelemetry(root, {
            retentionDays: 30,
            now: new Date('2026-07-18T12:00:00Z'),
            lastPurgedAt: '2026-07-17',
        });

        expect(result.deleted).toBe(1);
        expect(result.skipped).toBe(1);
    });

    it('allows purge when lastPurgedAt is undefined', async () => {
        const root = await tempDir();
        await mkdir(join(root, '2025-01-01'), { recursive: true });

        const result = await purgeTelemetry(root, {
            retentionDays: 30,
            now: new Date('2026-07-18T12:00:00Z'),
        });

        expect(result.deleted).toBe(1);
    });
});

describe('purgeTelemetry — marker persistence', () => {
    it('creates .last-purge marker after successful purge', async () => {
        const root = await tempDir();
        await mkdir(join(root, '2025-01-01'), { recursive: true });

        await purgeTelemetry(root, {
            retentionDays: 30,
            now: new Date('2026-07-18T12:00:00Z'),
        });

        const { readFile, stat } = await import('node:fs/promises');
        const markerStat = await stat(join(root, '.last-purge'));
        expect(markerStat.isFile()).toBe(true);
        const content = await readFile(join(root, '.last-purge'), 'utf-8');
        expect(content.trim()).toBe('2026-07-18');
    });

    it('marker has 0600 permissions (POSIX)', async () => {
        if (!isPosix()) return;
        const root = await tempDir();
        await mkdir(join(root, '2025-01-01'), { recursive: true });

        await purgeTelemetry(root, {
            retentionDays: 30,
            now: new Date('2026-07-18T12:00:00Z'),
        });

        const { stat } = await import('node:fs/promises');
        const markerStat = await stat(join(root, '.last-purge'));
        const mode = markerStat.mode & 0o777;
        expect(mode).toBe(0o600);
    });

    it('skips purge when marker equals today and no lastPurgedAt option', async () => {
        const root = await tempDir();
        await mkdir(join(root, '2025-01-01'), { recursive: true });

        // First purge creates marker
        await purgeTelemetry(root, {
            retentionDays: 30,
            now: new Date('2026-07-18T12:00:00Z'),
        });

        // Second purge should skip (marker says today)
        const result = await purgeTelemetry(root, {
            retentionDays: 30,
            now: new Date('2026-07-18T12:00:00Z'),
        });

        expect(result).toEqual({ deleted: 0, skipped: 0, errors: 0 });
    });

    it('allows purge when marker is from a previous day', async () => {
        const root = await tempDir();

        // First purge creates marker for yesterday (nothing old to delete)
        await purgeTelemetry(root, {
            retentionDays: 30,
            now: new Date('2026-07-17T12:00:00Z'),
        });

        // Add old directory AFTER first purge (first purge already deleted it)
        await mkdir(join(root, '2025-01-01'), { recursive: true });

        // Next day: purge should run (marker is from 2026-07-17)
        const result = await purgeTelemetry(root, {
            retentionDays: 30,
            now: new Date('2026-07-18T12:00:00Z'),
        });

        expect(result.deleted).toBe(1);
    });

    it('lastPurgedAt option overrides marker check', async () => {
        const root = await tempDir();

        // Create marker for today (no old dirs to delete)
        await purgeTelemetry(root, {
            retentionDays: 30,
            now: new Date('2026-07-18T12:00:00Z'),
        });

        // Add old directory AFTER first purge
        await mkdir(join(root, '2025-01-01'), { recursive: true });

        // With explicit lastPurgedAt=yesterday → should run
        const result = await purgeTelemetry(root, {
            retentionDays: 30,
            now: new Date('2026-07-18T12:00:00Z'),
            lastPurgedAt: '2026-07-17',
        });

        expect(result.deleted).toBe(1);
    });

    it('writes marker even when partial errors occur', async () => {
        const root = await tempDir();
        await mkdir(join(root, '2025-01-01'), { recursive: true });
        await mkdir(join(root, '2025-01-02'), { recursive: true });

        if (isPosix()) {
            const { chmod } = await import('node:fs/promises');
            try { await chmod(join(root, '2025-01-02'), 0o000); } catch { /* */ }
        }

        const result = await purgeTelemetry(root, {
            retentionDays: 0,
            now: new Date('2026-07-18T12:00:00Z'),
        });

        // Marker should exist even with partial errors
        const { readFile, stat } = await import('node:fs/promises');
        const markerStat = await stat(join(root, '.last-purge'));
        expect(markerStat.isFile()).toBe(true);
        const content = await readFile(join(root, '.last-purge'), 'utf-8');
        expect(content.trim()).toBe('2026-07-18');

        // Restore permissions
        if (isPosix()) {
            const { chmod } = await import('node:fs/promises');
            try { await chmod(join(root, '2025-01-02'), 0o755); } catch { /* */ }
        }
    });

    it('does not follow symlinked .last-purge marker', async () => {
        const root = await tempDir();
        const outsideDir = await tempDir();
        const outsideFile = join(outsideDir, 'outside.txt');
        await writeFile(outsideFile, '2026-07-18', 'utf-8');

        // Create a symlink marker pointing outside root
        try {
            await symlink(outsideFile, join(root, '.last-purge'));
        } catch {
            return; // symlink creation may fail
        }

        // Purge should NOT read the symlinked marker (treat as if no marker)
        await mkdir(join(root, '2025-01-01'), { recursive: true });
        const result = await purgeTelemetry(root, {
            retentionDays: 30,
            now: new Date('2026-07-18T12:00:00Z'),
        });

        expect(result.deleted).toBe(1);
    });
});

// ===========================================================================
// 9. Integration — write then read
// ===========================================================================

describe('write-then-read integration', () => {
    it('round-trips multiple event types', async () => {
        const root = await tempDir();
        const writer = createWriter(root, 'sess-roundtrip');

        const events = [
            makeEvent({ eventId: 'evt-1', event: 'session_start' }),
            makeEvent({ eventId: 'evt-2', event: 'turn_start', runId: 'run-1', turnIndex: 0 }),
            makeEvent({ eventId: 'evt-3', event: 'raw_tool_result', toolCallId: 'tc-1', toolName: 'read' }),
            makeEvent({ eventId: 'evt-4', event: 'experiment_tag', tag: 'test-tag' }),
        ];

        for (const evt of events) {
            await writer.append(evt);
        }
        await writer.flush();

        const result = await readTelemetryFile(root, datePartition(), 'sess-roundtrip');
        expect(result.records).toHaveLength(4);
        expect(result.records.map((r) => r.event)).toEqual([
            'session_start',
            'turn_start',
            'raw_tool_result',
            'experiment_tag',
        ]);
    });
});

// ===========================================================================
// 10. Export surface
// ===========================================================================

describe('storage module exports', () => {
    it('exports all expected symbols', async () => {
        const mod = await import('./storage');
        expect(typeof mod.sanitizeSessionId).toBe('function');
        expect(typeof mod.datePartition).toBe('function');
        expect(typeof mod.resolveTelemetryPath).toBe('function');
        expect(typeof mod.createWriter).toBe('function');
        expect(typeof mod.readTelemetryFile).toBe('function');
        expect(typeof mod.purgeTelemetry).toBe('function');
    });
});
