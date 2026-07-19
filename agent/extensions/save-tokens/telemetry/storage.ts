/**
 * Secure JSONL storage for telemetry events.
 *
 * Provides:
 * - Session ID sanitization (path traversal protection)
 * - Date-partitioned directory structure (root/YYYY-MM-DD/<safe-id>.jsonl)
 * - Append-only writer with ordered Promise queue per file
 * - Line-by-line reader tolerant of empty/invalid/truncated lines
 * - TTL-based purge with "at most once per day" guard
 *
 * Dependencies: Node.js standard library only (fs/promises, path)
 */

import { mkdir, open, readFile, rm, stat, lstat, readdir, chmod, rename, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { TelemetryEvent } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Allowlist regex for safe session IDs: alphanumeric, dots, hyphens, underscores. */
const SAFE_SESSION_RE = /^[a-zA-Z0-9._-]+$/;

/** Regex to extract YYYY-MM-DD date prefix from an ISO timestamp. */
const ISO_DATE_RE = /^(\d{4}-\d{2}-\d{2})/;

/** Strict YYYY-MM-DD directory name pattern. */
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Schema version required for valid records. */
const REQUIRED_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Calendar date validation
// ---------------------------------------------------------------------------

/**
 * Validate that a YYYY-MM-DD string represents a real calendar date.
 *
 * Uses round-trip through Date constructor in UTC to verify:
 * - Month is 01-12
 * - Day is valid for the given month/year (including leap years)
 * - No trailing content after the date
 */
export function isValidCalendarDate(dateStr: string): boolean {
    if (!DATE_DIR_RE.test(dateStr)) return false;
    const d = new Date(dateStr + 'T00:00:00.000Z');
    if (isNaN(d.getTime())) return false;
    return d.toISOString().slice(0, 10) === dateStr;
}

// ---------------------------------------------------------------------------
// Session ID sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize a session ID for safe filesystem use.
 *
 * Rules:
 * - Must be a non-empty string
 * - Must not be `.` or `..`
 * - Must match `[a-zA-Z0-9._-]+` only
 *
 * @throws {Error} If the ID is invalid or contains unsafe characters.
 */
export function sanitizeSessionId(id: string): string {
    if (typeof id !== 'string' || id.length === 0) {
        throw new Error('Invalid sessionId: must be a non-empty string');
    }
    if (id === '.' || id === '..') {
        throw new Error(`Invalid sessionId: cannot be "${id}"`);
    }
    if (!SAFE_SESSION_RE.test(id)) {
        throw new Error(
            'Invalid sessionId: contains unsafe characters (only a-zA-Z0-9._- allowed)',
        );
    }
    return id;
}

// ---------------------------------------------------------------------------
// ISO date extraction
// ---------------------------------------------------------------------------

/**
 * Extract the YYYY-MM-DD date partition from an ISO timestamp string.
 * Falls back to the current UTC date if the timestamp is missing or invalid.
 */
export function datePartition(timestamp?: string): string {
    if (!timestamp) {
        return new Date().toISOString().slice(0, 10);
    }
    const match = timestamp.match(ISO_DATE_RE);
    if (!match) return new Date().toISOString().slice(0, 10);
    const extracted = match[1];
    if (!isValidCalendarDate(extracted)) {
        return new Date().toISOString().slice(0, 10);
    }
    return extracted;
}

// ---------------------------------------------------------------------------
// Path resolution with traversal protection
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute file path for a telemetry JSONL file.
 *
 * Validates the session ID and verifies the resolved path stays within the
 * root directory to prevent path traversal attacks.
 *
 * @throws {Error} If the session ID is invalid or traversal is detected.
 */
export function resolveTelemetryPath(
    root: string,
    dateStr: string,
    safeSessionId: string,
): string {
    // Validate calendar date (prevents impossible dates and path traversal via date)
    if (!isValidCalendarDate(dateStr)) {
        throw new Error(
            `Invalid date: "${dateStr}" (expected valid YYYY-MM-DD)`,
        );
    }
    const safeSession = sanitizeSessionId(safeSessionId);
    const rootResolved = resolve(root);
    const filePath = resolve(join(rootResolved, dateStr, `${safeSession}.jsonl`));

    // Verify the resolved path starts with root (stays within boundaries)
    if (!filePath.startsWith(rootResolved + sep)) {
        throw new Error(
            `Path traversal detected: resolved path "${filePath}" is outside root "${rootResolved}"`,
        );
    }

    return filePath;
}

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

/**
 * Ensure a directory exists with the given POSIX permissions.
 *
 * Uses two-step create-then-chmod to neutralize umask effects and handle
 * pre-existing directories.
 */
async function ensureDirMode(dir: string, mode: number): Promise<void> {
    await mkdir(dir, { recursive: true });
    try {
        await chmod(dir, mode);
    } catch {
        // Best-effort on non-POSIX systems
    }
}

/**
 * Ensure a file has the given POSIX permissions.
 * Best-effort — non-POSIX systems silently ignore.
 */
async function ensureFileMode(file: string, mode: number): Promise<void> {
    try {
        await chmod(file, mode);
    } catch {
        // Best-effort on non-POSIX systems
    }
}

// ---------------------------------------------------------------------------
// Writer types
// ---------------------------------------------------------------------------

export interface TelemetryWriter {
    /** Append one telemetry event as a JSON line. Ordered via Promise chain. */
    append(record: TelemetryEvent): Promise<void>;
    /** Wait for all pending writes to complete. */
    flush(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Writer factory
// ---------------------------------------------------------------------------

/**
 * Create an append-only writer for a telemetry JSONL file.
 *
 * The writer:
 * - Date-partitions each record by its timestamp (falls back to clock)
 * - Creates root directory with 0700 and date directories with 0700 permissions
 * - Creates files with 0600 permissions
 * - Chains writes via per-writer Promise chain for ordered concurrent access
 * - Isolates write errors so a single failure doesn't block subsequent writes
 *
 * @param root - Base directory for telemetry storage
 * @param sessionId - Session identifier (sanitized for safe filesystem use)
 */
export function createWriter(root: string, sessionId: string): TelemetryWriter {
    const safeSession = sanitizeSessionId(sessionId);
    const rootResolved = resolve(root);

    // Per-writer ordered queue using a single promise chain.
    // Captured synchronously inside append() before any yield ensures
    // concurrent calls see consistent queue state.
    let chain = Promise.resolve<void>(undefined);

    const append = async (record: TelemetryEvent): Promise<void> => {
        const recordDate = datePartition(record.timestamp);
        const filePath = resolveTelemetryPath(rootResolved, recordDate, safeSession);
        const line = JSON.stringify(record) + '\n';

        // Capture previous chain entry synchronously
        const prev = chain;

        const writeOp = async (): Promise<void> => {
            // Ensure root directory exists with correct permissions.
            // Done every time for simplicity — mkdir/chmod are no-ops when
            // the directory already has correct state.
            await ensureDirMode(rootResolved, 0o700);
            await ensureDirMode(join(rootResolved, recordDate), 0o700);

            // Wait for previous write, ignoring its error so failures
            // never block subsequent writes.
            await prev.catch(() => undefined);

            // Append this line to the file
            const fd = await open(filePath, 'a', 0o600);
            try {
                await fd.writeFile(line);
                await ensureFileMode(filePath, 0o600);
            } finally {
                await fd.close();
            }
        };

        const promise = writeOp();
        // Update chain so next write waits for this one (ignore error)
        chain = promise.catch(() => undefined);

        return promise;
    };

    const flush = async (): Promise<void> => {
        await chain;
    };

    return { append, flush };
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export interface TelemetryReadResult {
    records: TelemetryEvent[];
    invalidLines: number;
    emptyLines: number;
}

/**
 * Minimal event shape validation.
 * Checks for required identity fields and exact schema version.
 */
function isValidTelemetryEvent(value: unknown): value is TelemetryEvent {
    if (!value || typeof value !== 'object') return false;
    const obj = value as Record<string, unknown>;

    // Schema version must match exactly
    if (obj.schemaVersion !== REQUIRED_SCHEMA_VERSION) return false;

    // Required string identity fields
    if (typeof obj.eventId !== 'string') return false;
    if (typeof obj.timestamp !== 'string') return false;
    if (typeof obj.sessionId !== 'string') return false;
    if (typeof obj.event !== 'string') return false;

    return true;
}

/**
 * Read a telemetry JSONL file and return parsed records plus diagnostic counters.
 *
 * Features:
 * - Returns empty result for missing files (not an error)
 * - Streams lines via readline (never loads entire file into memory)
 * - Tolerates empty lines and invalid JSON lines
 * - Accepts the last line without trailing newline (handles in-flight writes)
 * - Counts invalid and empty lines separately
 * - Only returns records matching the minimal event shape (schemaVersion, identity)
 *
 * @param root - Base directory for telemetry storage
 * @param dateStr - Date partition in YYYY-MM-DD format
 * @param sessionId - Session identifier (sanitized)
 * @throws {Error} If dateStr is not valid YYYY-MM-DD format
 */
export async function readTelemetryFile(
    root: string,
    dateStr: string,
    sessionId: string,
): Promise<TelemetryReadResult> {
    const rootResolved = resolve(root);
    const filePath = resolveTelemetryPath(rootResolved, dateStr, sessionId);

    // Fast existence check — avoids stream error handling for missing files
    try {
        await stat(filePath);
    } catch (err: unknown) {
        const nodeErr = err as { code?: string };
        if (nodeErr.code === 'ENOENT') {
            return { records: [], invalidLines: 0, emptyLines: 0 };
        }
        throw err;
    }

    // Stream line-by-line using readline (never loads entire file)
    return new Promise<TelemetryReadResult>((resolvePromise, reject) => {
        const records: TelemetryEvent[] = [];
        let invalidLines = 0;
        let emptyLines = 0;

        const rl = createInterface({
            input: createReadStream(filePath, { encoding: 'utf-8' }),
            crlfDelay: Infinity,
        });

        rl.on('line', (line: string) => {
            if (line.length === 0) {
                emptyLines++;
                return;
            }

            let parsed: unknown;
            try {
                parsed = JSON.parse(line);
            } catch {
                invalidLines++;
                return;
            }

            if (isValidTelemetryEvent(parsed)) {
                records.push(parsed);
            } else {
                invalidLines++;
            }
        });

        rl.on('close', () => {
            resolvePromise({ records, invalidLines, emptyLines });
        });

        rl.on('error', (err: Error) => {
            reject(err);
        });
    });
}

// ---------------------------------------------------------------------------
// Purge
// ---------------------------------------------------------------------------

export interface TelemetryPurgeResult {
    deleted: number;
    skipped: number;
    errors: number;
}

export interface PurgeOptions {
    /** Number of days to retain. Directories older than this are deleted. */
    retentionDays: number;
    /** Injected "now" for testability. Defaults to new Date(). */
    now?: Date;
    /**
     * Injected last-purge date (YYYY-MM-DD) for "at most once per day" guard.
     * When set, purge checks if this matches today and skips if so.
     * Default undefined: no guard applied (useful for tests and first run).
     */
    lastPurgedAt?: string;
}

/**
 * Purge telemetry directories older than the retention period.
 *
 * Safety guarantees:
 * - Only deletes directories matching YYYY-MM-DD format directly under root
 * - Does NOT follow symlinks (uses lstat)
 * - Does NOT delete the root directory itself
 * - Continues on individual errors (returns count in result.errors)
 * - Never deletes non-date files or directories directly under root
 * - Never follows symlinked marker files
 *
 * At-most-once-per-day guard:
 * - If `lastPurgedAt` is provided, uses it directly (for tests)
 * - Otherwise checks/sets a `.last-purge` marker file under root
 * - Marker is written atomically (temp + rename) even with partial errors
 *
 * @param root - Base telemetry directory
 * @param options - Retention period and optional overrides
 */
export async function purgeTelemetry(
    root: string,
    options: PurgeOptions,
): Promise<TelemetryPurgeResult> {
    const { retentionDays, now, lastPurgedAt } = options;

    if (
        typeof retentionDays !== 'number' ||
        !Number.isInteger(retentionDays) ||
        retentionDays < 0
    ) {
        throw new Error(`Invalid retentionDays: ${retentionDays}`);
    }

    const today = (now ?? new Date()).toISOString().slice(0, 10);

    // At-most-once-per-day guard — check injected override OR persisted marker
    if (lastPurgedAt !== undefined) {
        if (lastPurgedAt === today) {
            return { deleted: 0, skipped: 0, errors: 0 };
        }
    } else {
        // Check persisted marker file — skip if today already purged
        const markerPath = join(root, '.last-purge');
        try {
            const markerStat = await lstat(markerPath);
            // Never follow symlinks — treat symlinked marker as absent
            if (!markerStat.isSymbolicLink()) {
                const content = await readFile(markerPath, 'utf-8');
                if (content.trim() === today) {
                    return { deleted: 0, skipped: 0, errors: 0 };
                }
            }
        } catch {
            // Marker doesn't exist or can't be read → proceed
        }
    }

    const cutoff = new Date(now ?? new Date());
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const result: TelemetryPurgeResult = { deleted: 0, skipped: 0, errors: 0 };

    let entries: string[];
    try {
        entries = await readdir(root);
    } catch (err: unknown) {
        const nodeErr = err as { code?: string };
        if (nodeErr.code === 'ENOENT') {
            return result;
        }
        result.errors++;
        return result;
    }

    for (const entry of entries) {
        const fullPath = join(root, entry);

        try {
            const st = await lstat(fullPath);

            // Only process real directories (skip symlinks, files)
            if (!st.isDirectory()) {
                result.skipped++;
                continue;
            }

            // Only process directories matching YYYY-MM-DD
            if (!DATE_DIR_RE.test(entry)) {
                result.skipped++;
                continue;
            }

            // Only delete if strictly older than cutoff
            if (entry >= cutoffStr) {
                result.skipped++;
                continue;
            }

            await rm(fullPath, { recursive: true, force: true });
            result.deleted++;
        } catch {
            result.errors++;
        }
    }

    // Write marker atomically even with partial errors —
    // prevents repeated purge attempts on failure days.
    try {
        const markerPath = join(root, '.last-purge');
        const tmpPath = markerPath + '.tmp';
        await writeFile(tmpPath, today, 'utf-8');
        await rename(tmpPath, markerPath);
        await chmod(markerPath, 0o600);
    } catch {
        result.errors++;
    }

    return result;
}
