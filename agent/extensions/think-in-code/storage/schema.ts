/**
 * SQLite schema for the Think-in-Code project store.
 *
 * The schema is versioned via `project_meta`. Opening an unknown or older
 * version triggers a clean rebuild — the store never silently migrates user
 * data without a deliberate migration step.
 *
 * Tables:
 * - project_meta(key, value): singleton metadata (canonical path, version).
 * - documents(id, kind, source, redacted_text, byte_count, created_at): indexed
 *   text. Only redacted/bounded text is stored; raw output is referenced by
 *   archive ID.
 * - archives(id, kind, archive_path, byte_count, created_at, expires_at):
 *   raw archives. Stored unredacted so isolated analysis remains lossless.
 * - document_archives(document_id, archive_id): M:N binding.
 * - fts_documents: FTS5 virtual table mirroring `documents.redacted_text`.
 * - session_events(id, session_id, turn_index, kind, payload, created_at):
 *   compact per-turn state records for restoration.
 * - snapshots(id, session_id, turn_index, content, byte_count, created_at,
 *   consumed): post-compaction snapshots with deterministic content.
 */

import type { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 1;

export const PROJECT_META_KEYS = Object.freeze({
    schemaVersion: "schema_version",
    canonicalPath: "canonical_path",
    createdAt: "created_at",
});

export const SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
    `CREATE TABLE IF NOT EXISTS project_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        redacted_text TEXT NOT NULL,
        byte_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS archives (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        archive_path TEXT NOT NULL,
        byte_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS document_archives (
        document_id INTEGER NOT NULL,
        archive_id TEXT NOT NULL,
        PRIMARY KEY (document_id, archive_id),
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY (archive_id) REFERENCES archives(id) ON DELETE CASCADE
    )`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS fts_documents USING fts5(
        redacted_text,
        content='documents',
        content_rowid='id',
        tokenize='porter unicode61'
    )`,
    `CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        byte_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_documents_kind ON documents(kind)`,
    `CREATE INDEX IF NOT EXISTS idx_archives_expires ON archives(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id, turn_index)`,
    `CREATE INDEX IF NOT EXISTS idx_snapshots_session ON snapshots(session_id, consumed)`,
]);

export interface AppliedSchema {
    version: number;
    created: boolean;
}

/**
 * Apply schema migrations to the database. Returns whether a fresh install
 * was performed and the resulting schema version. Fails closed on an unknown
 * or older schema.
 */
export function applySchema(
    db: Database,
    canonicalPath: string,
    now: () => number = Date.now,
): AppliedSchema {
    db.run("BEGIN");
    try {
        db.run(SCHEMA_STATEMENTS.join(";\n") + ";");

        const existing = db
            .query("SELECT value FROM project_meta WHERE key = ?")
            .get(PROJECT_META_KEYS.schemaVersion) as
            | { value: string }
            | undefined;

        if (existing) {
            const version = Number.parseInt(existing.value, 10);
            if (!Number.isInteger(version) || version > SCHEMA_VERSION) {
                throw new Error(
                    `Unknown schema version ${existing.value}; expected ≤ ${SCHEMA_VERSION}`,
                );
            }
            if (version !== SCHEMA_VERSION) {
                throw new Error(
                    `Schema version ${version} requires a migration step that is not implemented`,
                );
            }
            const canonicalRow = db
                .query("SELECT value FROM project_meta WHERE key = ?")
                .get(PROJECT_META_KEYS.canonicalPath) as
                | { value: string }
                | undefined;
            if (
                canonicalRow &&
                canonicalRow.value !== canonicalPath &&
                canonicalPath.length > 0
            ) {
                throw new Error(
                    "Cannot reopen project store under a different canonical path",
                );
            }
            db.run("COMMIT");
            return { version: SCHEMA_VERSION, created: false };
        }

        db.run("INSERT INTO project_meta (key, value) VALUES (?, ?)", [
            PROJECT_META_KEYS.schemaVersion,
            String(SCHEMA_VERSION),
        ]);
        if (canonicalPath.length > 0) {
            db.run("INSERT INTO project_meta (key, value) VALUES (?, ?)", [
                PROJECT_META_KEYS.canonicalPath,
                canonicalPath,
            ]);
        }
        db.run("INSERT INTO project_meta (key, value) VALUES (?, ?)", [
            PROJECT_META_KEYS.createdAt,
            String(now()),
        ]);
        db.run("COMMIT");
        return { version: SCHEMA_VERSION, created: true };
    } catch (error) {
        try {
            db.run("ROLLBACK");
        } catch {
            // ignore secondary errors
        }
        throw error;
    }
}
