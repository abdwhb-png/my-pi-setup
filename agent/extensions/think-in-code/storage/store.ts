/**
 * Think-in-Code project-local store.
 *
 * Backed by a per-project SQLite database (FTS5) plus raw archives on disk.
 * Directories are created with mode 0700, files with mode 0600. Writes use a
 * temporary file + atomic rename. Symlink targets are rejected: callers must
 * pass a real path resolved through `realpath()`.
 *
 * Public API:
 *   store.archive(input)         → { id, byteCount }
 *   store.index(text, archives?) → { documentId }
 *   store.search(query, limit)   → SearchHit[]
 *   store.close()                → void
 *
 * Raw archives never enter search results. Only redacted/bounded snippets and
 * archive IDs are returned to callers — think_execute reanalyzes an archive
 * ID without exposing raw bytes to the LLM.
 */

import {
    chmodSync,
    closeSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { Database } from "bun:sqlite";

import {
    redactTextPreservingContext,
    redactValue,
} from "../../_shared/redaction.ts";
import type { ThinkInCodeConfig } from "../config.ts";
import { applySchema, PROJECT_META_KEYS, SCHEMA_VERSION } from "./schema.ts";

export interface StoreOptions {
    config: ThinkInCodeConfig;
    /** Path under which the store creates db and archives. Must be absolute and not a symlink. */
    storeRoot: string;
    /** Canonical project path stored in project_meta. Used for hash/path mismatch detection. */
    canonicalPath: string;
    /** Override the current time (ms since epoch). */
    now?: () => number;
    /** Override random ID generator for archive IDs. */
    randomId?: () => string;
}

export interface ArchiveInput {
    kind: "command-output" | "analysis-output" | "file-content" | "indexed";
    data: string | Uint8Array;
    /** Optional source reference (tool name, archive ID, file path). */
    source?: string;
}

export interface ArchiveResult {
    id: string;
    byteCount: number;
    archivePath: string;
    expiresAt: number;
}

export interface IndexInput {
    kind: "command-summary" | "analysis-summary" | "document-summary";
    source: string;
    text: string;
    archiveIds?: readonly string[];
}

export interface IndexResult {
    documentId: number;
    byteCount: number;
}

export interface SearchHit {
    documentId: number;
    snippet: string;
    source: string;
    score: number;
    archiveIds: readonly string[];
}

const DEFAULT_ARCHIVE_DIR = "archives";
const DEFAULT_DB_NAME = "store.sqlite";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

function defaultRandomId(): string {
    return (
        Math.random().toString(36).slice(2, 10) +
        Math.random().toString(36).slice(2, 10) +
        Date.now().toString(36)
    );
}

function ensureDirectory(path: string): void {
    mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
    chmodSync(path, DIRECTORY_MODE);
}

function ensureFile(path: string, data: string | Uint8Array): void {
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    const fd = openSync(tmp, "w", FILE_MODE);
    try {
        writeFileSync(fd, data);
        // Flush before rename
        closeSync(fd);
        renameSync(tmp, path);
        chmodSync(path, FILE_MODE);
    } catch (error) {
        try {
            closeSync(fd);
        } catch {
            // ignore
        }
        try {
            unlinkSync(tmp);
        } catch {
            // ignore
        }
        throw error;
    }
}

function assertNoSymlink(path: string, label: string): void {
    if (!isAbsolute(path)) {
        throw new Error(`${label} must be absolute: ${path}`);
    }
    const segments = resolve(path).split("/").filter(Boolean);
    let current = "/";
    for (const segment of segments) {
        current = join(current, segment);
        try {
            if (lstatSync(current).isSymbolicLink()) {
                throw new Error(
                    `${label} ancestor must not be a symlink: ${current}`,
                );
            }
        } catch (error) {
            if (
                error instanceof Error &&
                error.message.includes("must not be a symlink")
            ) {
                throw error;
            }
            // A not-yet-created component cannot itself be a symlink.
        }
    }
}

function boundedMetadata(value: string, maxLength: number): string {
    return redactTextPreservingContext(value, { maxLength });
}

export class ThinkStore {
    readonly #database: Database;
    readonly #archiveDir: string;
    readonly #storeRoot: string;
    readonly #canonicalPath: string;
    readonly #config: ThinkInCodeConfig;
    readonly #now: () => number;
    readonly #randomId: () => string;
    #closed = false;

    /** Test-only: tracked via module-level WeakMap so __getRawDatabase can resolve it. */

    constructor(options: StoreOptions) {
        this.#config = options.config;
        this.#storeRoot = resolve(options.storeRoot);
        this.#canonicalPath = boundedMetadata(options.canonicalPath, 4096);
        this.#now = options.now ?? Date.now;
        this.#randomId = options.randomId ?? defaultRandomId;
        assertNoSymlink(this.#storeRoot, "store root");
        ensureDirectory(this.#storeRoot);
        this.#archiveDir = join(this.#storeRoot, DEFAULT_ARCHIVE_DIR);
        ensureDirectory(this.#archiveDir);
        assertNoSymlink(this.#archiveDir, "archive directory");
        const dbPath = join(this.#storeRoot, DEFAULT_DB_NAME);
        assertNoSymlink(dbPath, "database path");
        this.#database = new Database(dbPath, { create: true });
        THINK_STORE_RAW_HANDLES.set(this, this.#database);
        chmodSync(dbPath, FILE_MODE);
        applySchema(this.#database, this.#canonicalPath, this.#now);
        this.#database.run("PRAGMA journal_mode = WAL");
        this.#database.run("PRAGMA foreign_keys = ON");
    }

    get storeRoot(): string {
        return this.#storeRoot;
    }

    get canonicalPath(): string {
        return this.#canonicalPath;
    }

    get schemaVersion(): number {
        const row = this.#database
            .query("SELECT value FROM project_meta WHERE key = ?")
            .get(PROJECT_META_KEYS.schemaVersion) as
            | { value: string }
            | undefined;
        return row ? Number.parseInt(row.value, 10) : 0;
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#database.close();
    }

    archive(input: ArchiveInput): ArchiveResult {
        this.#assertOpen();
        const data =
            typeof input.data === "string"
                ? Buffer.from(input.data, "utf8")
                : Buffer.from(input.data);
        const id = this.#randomId();
        const archivePath = join(this.#archiveDir, `${id}.bin`);
        assertNoSymlink(archivePath, "archive path");
        ensureFile(archivePath, data);
        const createdAt = this.#now();
        const expiresAt =
            createdAt + this.#config.retentionHours * 60 * 60 * 1000;
        try {
            this.#database
                .query(
                    `INSERT INTO archives (id, kind, archive_path, byte_count, created_at, expires_at)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                )
                .run(
                    id,
                    input.kind,
                    archivePath,
                    data.byteLength,
                    createdAt,
                    expiresAt,
                );
        } catch (error) {
            try {
                unlinkSync(archivePath);
            } catch {
                // The insert failure is primary; cleanup remains best-effort.
            }
            throw error;
        }
        return {
            id,
            byteCount: data.byteLength,
            archivePath,
            expiresAt,
        };
    }

    readArchives(
        ids: readonly string[],
        maxBytes: number,
    ): Array<{ id: string; data: string; byteCount: number }> {
        this.#assertOpen();
        if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
            throw new Error("Archive read limit must be a positive integer");
        }
        assertNoSymlink(this.#archiveDir, "archive directory");
        const canonicalStore = realpathSync(this.#storeRoot);
        let remaining = maxBytes;
        const results: Array<{ id: string; data: string; byteCount: number }> =
            [];
        for (const id of ids) {
            if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
                throw new Error(`Invalid archive id: ${id}`);
            }
            const row = this.#database
                .query(
                    "SELECT archive_path AS archivePath FROM archives WHERE id = ?",
                )
                .get(id) as { archivePath: string } | undefined;
            if (!row) throw new Error(`Archive not found: ${id}`);
            assertNoSymlink(row.archivePath, "archive path");
            const canonicalArchive = realpathSync(row.archivePath);
            const relativePath = relative(canonicalStore, canonicalArchive);
            if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
                throw new Error(
                    `Archive ${id} lives outside the project store`,
                );
            }
            const bytes = readFileSync(canonicalArchive).subarray(0, remaining);
            results.push({
                id,
                data: bytes.toString("utf8"),
                byteCount: bytes.byteLength,
            });
            remaining -= bytes.byteLength;
            if (remaining === 0) break;
        }
        return results;
    }

    index(input: IndexInput): IndexResult {
        this.#assertOpen();
        const redacted = redactTextPreservingContext(input.text, {
            maxLength: this.#config.indexedSnippetChars,
        });
        const source = boundedMetadata(input.source, 1024);
        const createdAt = this.#now();
        const serialized = this.#runTransaction(() => {
            const inserted = this.#database
                .query(
                    `INSERT INTO documents (kind, source, redacted_text, byte_count, created_at)
                     VALUES (?, ?, ?, ?, ?) RETURNING id`,
                )
                .get(
                    input.kind,
                    source,
                    redacted,
                    Buffer.byteLength(redacted, "utf8"),
                    createdAt,
                ) as { id: number };
            for (const archiveId of input.archiveIds ?? []) {
                this.#database
                    .query(
                        `INSERT OR IGNORE INTO document_archives (document_id, archive_id)
                         VALUES (?, ?)`,
                    )
                    .run(inserted.id, archiveId);
            }
            this.#database
                .query(
                    `INSERT INTO fts_documents (rowid, redacted_text)
                     VALUES (?, ?)`,
                )
                .run(inserted.id, redacted);
            return inserted;
        });
        return {
            documentId: serialized.id,
            byteCount: Buffer.byteLength(redacted, "utf8"),
        };
    }

    search(query: string, limit = 20): SearchHit[] {
        this.#assertOpen();
        const safeQuery = buildSafeFtsQuery(query);
        if (safeQuery === null) return [];
        const hits = this.#database
            .query(
                `SELECT d.id AS document_id,
                        d.source AS source,
                        d.kind AS kind,
                        snippet(fts_documents, 0, '<<', '>>', '...', ${this.#config.searchSnippetChars}) AS snippet,
                        bm25(fts_documents) AS score
                   FROM fts_documents
                   JOIN documents d ON d.id = fts_documents.rowid
                  WHERE fts_documents MATCH ?
                  ORDER BY score ASC
                  LIMIT ?`,
            )
            .all(safeQuery, limit) as Array<{
            document_id: number;
            source: string;
            kind: string;
            snippet: string;
            score: number;
        }>;
        if (hits.length === 0) return [];
        const ids = hits.map((h) => h.document_id);
        const idListJson = JSON.stringify(ids);
        const archiveRows = this.#database
            .query(
                `SELECT da.document_id AS document_id, da.archive_id AS archive_id
                   FROM document_archives da
                   JOIN json_each(?) je ON je.value = da.document_id`,
            )
            .all(idListJson) as Array<{
            document_id: number;
            archive_id: string;
        }>;
        const byDoc = new Map<number, string[]>();
        for (const row of archiveRows) {
            const list = byDoc.get(row.document_id) ?? [];
            list.push(row.archive_id);
            byDoc.set(row.document_id, list);
        }
        return hits.map((hit) => ({
            documentId: hit.document_id,
            source: hit.source,
            snippet: hit.snippet,
            score: hit.score,
            archiveIds: byDoc.get(hit.document_id) ?? [],
        }));
    }

    countDocuments(): number {
        this.#assertOpen();
        const row = this.#database
            .query<{ count: number }, []>(
                "SELECT COUNT(*) AS count FROM documents",
            )
            .get();
        return row?.count ?? 0;
    }

    recordSessionEvent(input: {
        sessionId: string;
        turnIndex: number;
        kind: string;
        payload: unknown;
    }): void {
        this.#assertOpen();
        const payload = redactValue(input.payload, {
            maxDepth: 12,
            maxStringLength: 2048,
            maxArrayItems: 64,
        }).value;
        this.#database
            .query(
                `INSERT INTO session_events (session_id, turn_index, kind, payload, created_at)
                 VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
                boundedMetadata(input.sessionId, 256),
                input.turnIndex,
                boundedMetadata(input.kind, 128),
                JSON.stringify(payload),
                this.#now(),
            );
    }

    saveSnapshot(input: {
        sessionId: string;
        turnIndex: number;
        content: string;
    }): { id: number; byteCount: number } {
        this.#assertOpen();
        const inserted = this.#database
            .query(
                `INSERT INTO snapshots (session_id, turn_index, content, byte_count, created_at)
                 VALUES (?, ?, ?, ?, ?) RETURNING id`,
            )
            .get(
                boundedMetadata(input.sessionId, 256),
                input.turnIndex,
                boundedMetadata(input.content, 12_000),
                Buffer.byteLength(
                    boundedMetadata(input.content, 12_000),
                    "utf8",
                ),
                this.#now(),
            ) as { id: number };
        return {
            id: inserted.id,
            byteCount: Buffer.byteLength(
                boundedMetadata(input.content, 12_000),
                "utf8",
            ),
        };
    }

    pendingSnapshots(sessionId: string): Array<{
        id: number;
        content: string;
        byteCount: number;
        createdAt: number;
    }> {
        this.#assertOpen();
        return this.#database
            .query(
                `SELECT id, content, byte_count AS byteCount, created_at AS createdAt
                   FROM snapshots
                  WHERE session_id = ? AND consumed = 0
                  ORDER BY created_at ASC`,
            )
            .all(sessionId) as Array<{
            id: number;
            content: string;
            byteCount: number;
            createdAt: number;
        }>;
    }

    markSnapshotConsumed(snapshotId: number): void {
        this.#assertOpen();
        this.#database
            .query("UPDATE snapshots SET consumed = 1 WHERE id = ?")
            .run(snapshotId);
    }

    /**
     * Sum of bytes consumed by archives under this store. Used by retention
     * to enforce the per-project quota.
     */
    archiveBytes(): number {
        this.#assertOpen();
        const row = this.#database
            .query("SELECT COALESCE(SUM(byte_count), 0) AS total FROM archives")
            .get() as { total: number };
        return Number(row.total);
    }

    /**
     * Return archive IDs that are currently expired (`expires_at < now`).
     */
    expiredArchiveIds(now: number = this.#now()): string[] {
        this.#assertOpen();
        return (
            this.#database
                .query("SELECT id FROM archives WHERE expires_at <= ?")
                .all(now) as Array<{ id: string }>
        ).map((row) => row.id);
    }

    /**
     * Return archive IDs ordered by oldest first until total bytes would
     * fit under the quota. Used by oldest-first quota eviction.
     */
    archivesOverQuota(quotaBytes: number): string[] {
        this.#assertOpen();
        const rows = this.#database
            .query(
                `SELECT id, byte_count AS byteCount
                   FROM archives
                  ORDER BY created_at ASC`,
            )
            .all() as Array<{ id: string; byteCount: number }>;
        let total = this.archiveBytes();
        const evict: string[] = [];
        for (const row of rows) {
            if (total <= quotaBytes) break;
            evict.push(row.id);
            total -= row.byteCount;
        }
        return evict;
    }

    /**
     * Return orphan archive paths and IDs — files on disk that no longer
     * have an archive row (e.g. after a crash mid-delete).
     */
    orphanArchiveFiles(): string[] {
        this.#assertOpen();
        const known = new Set(
            (
                this.#database
                    .query("SELECT archive_path FROM archives")
                    .all() as Array<{
                    archive_path: string;
                }>
            ).map((row) => row.archive_path),
        );
        const orphans: string[] = [];
        for (const name of readdirSync(this.#archiveDir)) {
            const path = join(this.#archiveDir, name);
            if (!known.has(path)) {
                orphans.push(path);
            }
        }
        return orphans;
    }

    /**
     * Delete archive rows by ID and unlink the archive files. Caller must
     * ensure IDs came from the store (never an external path).
     */
    deleteArchives(ids: readonly string[]): number {
        this.#assertOpen();
        if (ids.length === 0) return 0;
        let deletedBytes = 0;
        const idListJson = JSON.stringify(ids);
        const archiveRows = this.#database
            .query(
                `SELECT id, archive_path AS archivePath, byte_count AS byteCount
                       FROM archives
                      WHERE id IN (SELECT value FROM json_each(?))`,
            )
            .all(idListJson) as Array<{
            id: string;
            archivePath: string;
            byteCount: number;
        }>;
        assertNoSymlink(this.#archiveDir, "archive directory");
        const canonicalStore = realpathSync(this.#storeRoot);
        for (const row of archiveRows) {
            assertNoSymlink(row.archivePath, "archive path");
            const archiveParent = realpathSync(dirname(row.archivePath));
            const canonicalArchivePath = join(
                archiveParent,
                row.archivePath.slice(dirname(row.archivePath).length + 1),
            );
            // Boundary check: archive must live under the canonical store root.
            const relativePath = relative(canonicalStore, canonicalArchivePath);
            if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
                throw new Error(
                    `Archive ${row.id} lives outside the project store: ${row.archivePath}`,
                );
            }
            try {
                unlinkSync(canonicalArchivePath);
            } catch {
                // best-effort
            }
            deletedBytes += row.byteCount;
        }
        this.#database
            .query(
                `DELETE FROM archives
                  WHERE id IN (SELECT value FROM json_each(?))`,
            )
            .run(idListJson);
        return deletedBytes;
    }

    #runTransaction<T>(fn: () => T): T {
        this.#database.run("BEGIN");
        try {
            const result = fn();
            this.#database.run("COMMIT");
            return result;
        } catch (error) {
            try {
                this.#database.run("ROLLBACK");
            } catch {
                // ignore
            }
            throw error;
        }
    }

    #assertOpen(): void {
        if (this.#closed) {
            throw new Error("Think-in-Code store is closed");
        }
    }
}

export interface CreateThinkStoreOptions extends Omit<
    StoreOptions,
    "storeRoot"
> {
    /** Absolute, realpath'd project path. Used to derive the storeRoot. */
    canonicalPath: string;
    /** Root directory under which project stores live. */
    projectsRoot?: string;
}

const DEFAULT_PROJECTS_ROOT_DIR = "projects";

export function createThinkStore(options: CreateThinkStoreOptions): ThinkStore {
    const projectsRoot =
        options.projectsRoot ??
        join(dirname(options.canonicalPath), DEFAULT_PROJECTS_ROOT_DIR);
    return new ThinkStore({ ...options, storeRoot: projectsRoot });
}

/**
 * Open an existing per-project store by canonical path and root. Fails if the
 * schema version stored on disk does not match the current schema.
 */
export function openThinkStore(options: CreateThinkStoreOptions): ThinkStore {
    return createThinkStore(options);
}

/**
 * Centralized safe FTS5 query construction. We escape every `"` by
 * doubling it and wrap each normalized token in double-quotes so hyphenated
 * or operator-bearing input (alpha-2847, OR, NEAR/, *, colons) is treated
 * as a literal token rather than FTS syntax. Normalized tokens are split on
 * non-alphanumeric/underscore; empty-token queries return null (no throw,
 * no injection) so callers get an empty result set with bounded snippets.
 * Preserves bm25 ranking over the literal tokens.
 */
function escapeFtsLiteral(token: string): string {
    return `"${token.replace(/"/g, '""')}"`;
}

export function buildSafeFtsQuery(raw: string): string | null {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    // Split on anything that is not a letter/digit/underscore, drop empties,
    // lowercase for case-insensitive FTS matching (FTS5 unicode61 is case-
    // insensitive but lowercasing keeps tests deterministic).
    const tokens = trimmed
        .split(/[^A-Za-z0-9_]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .map((t) => t.toLowerCase());
    if (tokens.length === 0) return null;
    // Deduplicate while preserving order, cap tokens to avoid huge queries.
    const seen = new Set<string>();
    const uniq: string[] = [];
    for (const t of tokens) {
        if (!seen.has(t)) {
            seen.add(t);
            uniq.push(t);
            if (uniq.length >= 20) break;
        }
    }
    return uniq.map(escapeFtsLiteral).join(" OR ");
}

export const __test = {
    SCHEMA_VERSION,
    DIRECTORY_MODE,
    FILE_MODE,
    ensureDirectory,
    ensureFile,
    assertNoSymlink,
    buildSafeFtsQuery,
};

const THINK_STORE_RAW_HANDLES = new WeakMap<ThinkStore, Database>();

/**
 * Test-only escape hatch to access the raw database handle. Production code
 * must use the public API (archive/index/search) instead. This is exported so
 * transaction-rollback and boundary-protection tests can exercise raw SQL
 * paths that have no public counterpart.
 */
export function __getRawDatabase(store: ThinkStore): Database {
    const handle = THINK_STORE_RAW_HANDLES.get(store);
    if (!handle) {
        throw new Error(
            "Test-only raw database handle is missing; did the store close?",
        );
    }
    return handle;
}
