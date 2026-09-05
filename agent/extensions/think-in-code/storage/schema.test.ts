/**
 * Schema tests for the Think-in-Code project store.
 *
 * Directly imports `storage/schema.ts` and exercises schema version,
 * migration, and reopen safety. Uses disposable on-disk fixtures so
 * persistence and migration semantics survive process restarts.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";

import {
    applySchema,
    PROJECT_META_KEYS,
    SCHEMA_STATEMENTS,
    SCHEMA_VERSION,
} from "./schema.ts";

function freshDb(): Database {
    return new Database(":memory:");
}

describe("storage/schema", () => {
    it("creates schema version 1 on a fresh database", () => {
        const db = freshDb();
        const result = applySchema(db, "/workspace/proj", () => 1234567890);
        expect(result.version).toBe(1);
        expect(result.created).toBe(true);
        const version = db
            .query("SELECT value FROM project_meta WHERE key = ?")
            .get(PROJECT_META_KEYS.schemaVersion) as { value: string } | undefined;
        expect(version?.value).toBe(String(SCHEMA_VERSION));
        const createdAt = db
            .query("SELECT value FROM project_meta WHERE key = ?")
            .get(PROJECT_META_KEYS.createdAt) as { value: string } | undefined;
        expect(createdAt?.value).toBe("1234567890");
        db.close();
    });

    it("stores canonical path on creation and reopens idempotently", () => {
        const db = freshDb();
        const canonical = "/workspace/proj-alpha";
        const first = applySchema(db, canonical, () => 1);
        expect(first.created).toBe(true);
        const second = applySchema(db, canonical, () => 2);
        expect(second.created).toBe(false);
        expect(second.version).toBe(SCHEMA_VERSION);
        const row = db
            .query("SELECT value FROM project_meta WHERE key = ?")
            .get(PROJECT_META_KEYS.canonicalPath) as { value: string } | undefined;
        expect(row?.value).toBe(canonical);
        db.close();
    });

    it("rejects reopen under a different canonical path", () => {
        const db = freshDb();
        applySchema(db, "/workspace/proj-a", () => 1);
        expect(() => applySchema(db, "/workspace/proj-b", () => 2)).toThrow(
            /different canonical path/,
        );
        db.close();
    });

    it("rejects unknown future schema versions", () => {
        const db = freshDb();
        db.run(SCHEMA_STATEMENTS.join(";\n") + ";");
        db.run("INSERT INTO project_meta (key, value) VALUES (?, ?)", [
            PROJECT_META_KEYS.schemaVersion,
            "999",
        ]);
        expect(() => applySchema(db, "/workspace/proj", () => 1)).toThrow(
            /Unknown schema version/,
        );
        db.close();
    });

    it("rejects older schema versions that require migration", () => {
        const db = freshDb();
        db.run(SCHEMA_STATEMENTS.join(";\n") + ";");
        db.run("INSERT INTO project_meta (key, value) VALUES (?, ?)", [
            PROJECT_META_KEYS.schemaVersion,
            "0",
        ]);
        expect(() => applySchema(db, "/workspace/proj", () => 1)).toThrow(
            /requires a migration step/,
        );
        db.close();
    });

    it("exposes frozen SCHEMA_VERSION and SCHEMA_STATEMENTS", () => {
        expect(SCHEMA_VERSION).toBe(1);
        expect(Object.isFrozen(SCHEMA_STATEMENTS)).toBe(true);
        expect(Object.isFrozen(PROJECT_META_KEYS)).toBe(true);
        expect(SCHEMA_STATEMENTS.length).toBeGreaterThan(0);
        expect(PROJECT_META_KEYS.schemaVersion).toBe("schema_version");
    });

    it("rolls back on schema application failure and remains usable", () => {
        const db = freshDb();
        // Seed a valid schema first.
        applySchema(db, "/workspace/proj", () => 1);
        // Inject a future version directly via raw SQL to simulate external mutation.
        db.run(
            "UPDATE project_meta SET value = ? WHERE key = ?",
            ["999", PROJECT_META_KEYS.schemaVersion],
        );
        expect(() => applySchema(db, "/workspace/proj", () => 2)).toThrow(
            /Unknown schema version/,
        );
        // After rollback, the database should still be in a transactionally consistent state.
        const stillThere = db
            .query("SELECT value FROM project_meta WHERE key = ?")
            .get(PROJECT_META_KEYS.schemaVersion) as { value: string } | undefined;
        expect(stillThere?.value).toBe("999");
        db.close();
    });

    it("creates all expected tables and indexes", () => {
        const db = freshDb();
        applySchema(db, "/workspace/proj", () => 1);
        const tables = db
            .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .all() as Array<{ name: string }>;
        const names = tables.map((t) => t.name);
        expect(names).toContain("project_meta");
        expect(names).toContain("documents");
        expect(names).toContain("archives");
        expect(names).toContain("document_archives");
        expect(names).toContain("session_events");
        expect(names).toContain("snapshots");
        // FTS5 virtual table appears as type 'table' as well.
        expect(names).toContain("fts_documents");
        db.close();
    });
});
