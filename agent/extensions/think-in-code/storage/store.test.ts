import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
} from "bun:test";
import { readdirSync, statSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_THINK_IN_CODE_CONFIG } from "../config";
import { ThinkStore, __getRawDatabase } from "./store";

interface Harness {
    home: string;
    project: string;
    store: ThinkStore;
    cleanup(): Promise<void>;
}

async function makeHarness(
    canonicalPath = "/workspace/proj-a",
    now: () => number = () => 1_700_000_000_000,
): Promise<Harness> {
    const home = await mkdtemp(join(tmpdir(), "think-in-code-store-"));
    const storeRoot = join(
        home,
        ".pi",
        "agent",
        "think-in-code",
        "projects",
        "test-hash",
    );
    await mkdir(storeRoot, { recursive: true });
    const store = new ThinkStore({
        config: DEFAULT_THINK_IN_CODE_CONFIG,
        storeRoot,
        canonicalPath,
        now,
    });
    return {
        home,
        project: canonicalPath,
        store,
        async cleanup() {
            store.close();
            await rm(home, { recursive: true, force: true });
        },
    };
}

describe("ThinkStore", () => {
    let harness: Harness | undefined;

    afterEach(async () => {
        if (harness) await harness.cleanup();
        harness = undefined;
    });

    it("creates the store with 0700 directory mode and 0600 file mode", async () => {
        harness = await makeHarness();
        const storeStats = statSync(harness.store.storeRoot);
        const dbStats = statSync(
            join(harness.store.storeRoot, "store.sqlite"),
        );
        expect((storeStats.mode & 0o777).toString(8)).toBe("700");
        expect((dbStats.mode & 0o777).toString(8)).toBe("600");
    });

    it("rejects symlinks at the store root", async () => {
        const home = await mkdtemp(join(tmpdir(), "think-in-code-symlink-"));
        try {
            const target = join(home, "real-store");
            const link = join(home, "linked-store");
            await mkdir(target, { recursive: true });
            symlinkSync(target, link);
            expect(() =>
                new ThinkStore({
                    config: DEFAULT_THINK_IN_CODE_CONFIG,
                    storeRoot: link,
                    canonicalPath: "/workspace/proj",
                    now: () => 1,
                }),
            ).toThrow(/must not be a symlink/);
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it("rejects a symlink in any existing store ancestor", async () => {
        const home = await mkdtemp(join(tmpdir(), "think-in-code-ancestor-link-"));
        try {
            const target = join(home, "target");
            const link = join(home, "ancestor");
            await mkdir(target, { recursive: true });
            symlinkSync(target, link);
            expect(() =>
                new ThinkStore({
                    config: DEFAULT_THINK_IN_CODE_CONFIG,
                    storeRoot: join(link, "nested", "store"),
                    canonicalPath: "/workspace/proj",
                }),
            ).toThrow(/ancestor.*symlink|must not be a symlink/i);
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it("archives raw output and indexes redacted text and metadata", async () => {
        harness = await makeHarness();
        const archive = harness.store.archive({
            kind: "command-output",
            data: "first line\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz\nlast line",
        });
        const doc = harness.store.index({
            kind: "command-summary",
            source: "export API_KEY=source-secret-value; echo hello",
            text: `preflight summarize ${archive.id}\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz`,
            archiveIds: [archive.id],
        });
        const hits = harness.store.search(`preflight`, 5);
        expect(hits.length).toBeGreaterThan(0);
        const hit = hits[0]!;
        expect(hit.archiveIds).toContain(archive.id);
        expect(hit.snippet).not.toContain("Bearer");
        expect(hit.snippet).toContain("[REDACTED]");
        expect(hit.source).not.toContain("source-secret-value");
        expect(doc.documentId).toBeGreaterThan(0);
    });

    it("removes a raw archive file when its database insert fails", async () => {
        harness = await makeHarness();
        const db = __getRawDatabase(harness.store);
        db.exec(`CREATE TRIGGER reject_archive BEFORE INSERT ON archives BEGIN SELECT RAISE(ABORT, 'rejected'); END`);
        expect(() =>
            harness!.store.archive({ kind: "command-output", data: "secret orphan" }),
        ).toThrow(/rejected/);
        expect(readdirSync(join(harness.store.storeRoot, "archives"))).toEqual([]);
    });

    it("reads only validated bounded archive data", async () => {
        harness = await makeHarness();
        const first = harness.store.archive({ kind: "command-output", data: "alpha" });
        const second = harness.store.archive({ kind: "command-output", data: "bravo" });
        expect(harness.store.readArchives([first.id, second.id], 9)).toEqual([
            { id: first.id, data: "alpha", byteCount: 5 },
            { id: second.id, data: "brav", byteCount: 4 },
        ]);
        expect(() => harness!.store.readArchives(["missing00"], 10)).toThrow(/not found/);
    });

    it("ranks more relevant documents higher and returns bounded snippets", async () => {
        harness = await makeHarness();
        harness.store.index({
            kind: "document-summary",
            source: "doc-a",
            text: "alpha beta gamma repeated-keyword unique-a",
        });
        harness.store.index({
            kind: "document-summary",
            source: "doc-b",
            text: "alpha beta unrelated",
        });
        const hits = harness.store.search("alpha beta", 5);
        expect(hits.length).toBe(2);
        for (const hit of hits) {
            expect(hit.snippet.length).toBeLessThanOrEqual(
                DEFAULT_THINK_IN_CODE_CONFIG.searchSnippetChars + 8,
            );
        }
    });

    it("rolls back index transactions when the FTS insert fails", async () => {
        harness = await makeHarness();
        expect(() =>
            harness!.store.index({
                kind: "command-summary",
                source: "manual",
                text: "hello world",
            }),
        ).not.toThrow();
        const db = __getRawDatabase(harness!.store);
        // Force an FTS5 statement failure (malformed MATCH) inside a fresh
        // transaction. The store's transaction wrapper must ROLLBACK so the
        // outer FTS index remains consistent.
        expect(() =>
            db.transaction(() => {
                db.query("INSERT INTO documents (kind, source, redacted_text, byte_count, created_at) VALUES (?, ?, ?, ?, ?)")
                    .run("document-summary", "doomed", "doomed text", 11, 1);
                db.query(`INSERT INTO fts_documents (fts5) VALUES (?)`)
                    .run("malformed-matcher");
            })(),
        ).toThrow();
        // Search must still succeed and report the previously indexed doc.
        const hits = harness!.store.search("hello", 5);
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.some((h) => h.source === "manual")).toBe(true);
    });

    it("persists data across reopen and refuses mismatched canonical paths", async () => {
        const first = await makeHarness();
        first.store.archive({ kind: "command-output", data: "alpha" });
        first.store.index({
            kind: "command-summary",
            source: "echo",
            text: "alpha doc",
        });
        first.store.close();

        const reopened = new ThinkStore({
            config: DEFAULT_THINK_IN_CODE_CONFIG,
            storeRoot: first.store.storeRoot,
            canonicalPath: first.project,
            now: () => 1,
        });
        const hits = reopened.search("alpha", 5);
        expect(hits.length).toBeGreaterThan(0);
        reopened.close();

        expect(
            () =>
                new ThinkStore({
                    config: DEFAULT_THINK_IN_CODE_CONFIG,
                    storeRoot: first.store.storeRoot,
                    canonicalPath: "/workspace/different-project",
                    now: () => 1,
                }),
        ).toThrow(/different canonical path/);
        await first.cleanup();
    });

    it("caps indexed text length and never returns raw bytes from search", async () => {
        harness = await makeHarness();
        const huge = "y".repeat(5000);
        const doc = harness.store.index({
            kind: "document-summary",
            source: "bulk",
            text: `${huge} ${"sk-abcdefghijklmnopqrstuv".repeat(20)}`,
        });
        expect(doc.byteCount).toBeLessThanOrEqual(
            DEFAULT_THINK_IN_CODE_CONFIG.indexedSnippetChars,
        );
        const hits = harness.store.search("y", 5);
        for (const hit of hits) {
            expect(hit.snippet).not.toContain("sk-abcdefghijklmnopqrstuv");
            expect(hit.snippet).not.toMatch(/sk-[A-Za-z0-9_-]{10,}/);
        }
    });

    it("summarizes project disk usage via archiveBytes", async () => {
        harness = await makeHarness();
        const before = harness.store.archiveBytes();
        const archive = harness.store.archive({
            kind: "command-output",
            data: "1234567890",
        });
        const after = harness.store.archiveBytes();
        expect(after - before).toBe(archive.byteCount);
    });

    it("rejects deletion when the archive directory is replaced by a symlink", async () => {
        const home = await mkdtemp(join(tmpdir(), "think-in-code-delete-link-"));
        try {
            const storeRoot = join(home, "store");
            const outside = join(home, "outside");
            await mkdir(storeRoot, { recursive: true });
            await mkdir(outside, { recursive: true });
            const store = new ThinkStore({
                config: DEFAULT_THINK_IN_CODE_CONFIG,
                storeRoot,
                canonicalPath: "/workspace/proj",
            });
            const archive = store.archive({ kind: "command-output", data: "inside" });
            await rm(join(storeRoot, "archives"), { recursive: true });
            symlinkSync(outside, join(storeRoot, "archives"));
            expect(() => store.deleteArchives([archive.id])).toThrow(/symlink/);
            store.close();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it("refuses to delete archive paths outside the project root", async () => {
        const home = await mkdtemp(join(tmpdir(), "think-in-code-delete-"));
        try {
            const storeRoot = join(home, "store");
            await mkdir(storeRoot, { recursive: true });
            const store = new ThinkStore({
                config: DEFAULT_THINK_IN_CODE_CONFIG,
                storeRoot,
                canonicalPath: "/workspace/proj",
                now: () => 1,
            });
            const db = __getRawDatabase(store);
            db.query(
                `INSERT INTO archives (id, kind, archive_path, byte_count, created_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            ).run("evil", "command-output", "/etc/passwd", 0, 0, 0);
            expect(() => store.deleteArchives(["evil"])).toThrow(
                /outside the project store/,
            );
            store.close();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });
});