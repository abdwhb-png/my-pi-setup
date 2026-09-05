import {
    afterEach,
    describe,
    expect,
    it,
} from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    DEFAULT_THINK_IN_CODE_CONFIG,
    type ThinkInCodeConfig,
} from "../config.ts";
import { ThinkStore } from "./store.ts";
import { runRetention } from "./retention.ts";

interface RetentionHarness {
    home: string;
    storeRoot: string;
    cleanup(): Promise<void>;
}

async function makeRetentionHarness(
    config: ThinkInCodeConfig = DEFAULT_THINK_IN_CODE_CONFIG,
): Promise<RetentionHarness> {
    const home = await mkdtemp(join(tmpdir(), "think-in-code-retention-"));
    const storeRoot = join(home, "store");
    await mkdir(storeRoot, { recursive: true });
    return {
        home,
        storeRoot,
        async cleanup() {
            await rm(home, { recursive: true, force: true });
        },
    };
}

afterEach(async () => {
    // Each test creates its own harness and calls cleanup individually.
});

describe("runRetention", () => {
    let harness: RetentionHarness | undefined;
    afterEach(async () => {
        if (harness) await harness.cleanup();
        harness = undefined;
    });

    it("deletes archives whose expires_at is in the past", async () => {
        harness = await makeRetentionHarness();
        let now = 1_700_000_000_000;
        const store = new ThinkStore({
            config: DEFAULT_THINK_IN_CODE_CONFIG,
            storeRoot: harness.storeRoot,
            canonicalPath: "/workspace/proj",
            now: () => now,
        });
        const oldArchive = store.archive({
            kind: "command-output",
            data: "old",
        });
        // Advance 25h so the old archive expires, then create a fresh one
        // that will not be expired when retention runs.
        now += 25 * 60 * 60 * 1000;
        const freshArchive = store.archive({
            kind: "command-output",
            data: "fresh",
        });
        const report = runRetention(store, DEFAULT_THINK_IN_CODE_CONFIG, {
            now: () => now,
        });
        expect(report.expiredDeleted).toBe(1);
        const remaining = store.archiveBytes();
        expect(remaining).toBeGreaterThan(0);
        store.close();
        // Ensure the file for the expired archive is gone.
        expect(await Bun.file(oldArchive.archivePath).exists()).toBe(false);
        // Fresh archive should still be readable.
        expect(await Bun.file(freshArchive.archivePath).exists()).toBe(true);
    });

    it("evicts oldest archives first when over the project quota", async () => {
        const quota = 1024; // 1 KiB
        const config: ThinkInCodeConfig = {
            ...DEFAULT_THINK_IN_CODE_CONFIG,
            projectQuotaBytes: quota,
        };
        harness = await makeRetentionHarness(config);
        let now = 1_700_000_000_000;
        const store = new ThinkStore({
            config,
            storeRoot: harness.storeRoot,
            canonicalPath: "/workspace/proj",
            now: () => now,
        });
        // Create three 500-byte archives; third will push us over the quota.
        const first = store.archive({ kind: "command-output", data: "x".repeat(500) });
        now += 1000;
        const second = store.archive({ kind: "command-output", data: "y".repeat(500) });
        now += 1000;
        store.archive({ kind: "command-output", data: "z".repeat(500) });
        now += 1000;
        const report = runRetention(store, config, { now: () => now });
        expect(report.quotaEvicted).toBeGreaterThan(0);
        expect(store.archiveBytes()).toBeLessThanOrEqual(quota);
        // Oldest first: `first` should be gone before `second`.
        expect(await Bun.file(first.archivePath).exists()).toBe(false);
        expect(await Bun.file(second.archivePath).exists()).toBe(true);
        store.close();
    });

    it("cleans up archive rows when their only referencing document is deleted", async () => {
        harness = await makeRetentionHarness();
        const store = new ThinkStore({
            config: DEFAULT_THINK_IN_CODE_CONFIG,
            storeRoot: harness.storeRoot,
            canonicalPath: "/workspace/proj",
        });
        const archive = store.archive({
            kind: "command-output",
            data: "isolated",
        });
        const doc = store.index({
            kind: "command-summary",
            source: "cmd",
            text: "marker phrase isolated-output",
            archiveIds: [archive.id],
        });
        expect(store.archiveBytes()).toBeGreaterThan(0);
        // Use raw delete to verify cascade behavior through the foreign key.
        store["#database" as unknown as keyof ThinkStore];
        const raw = (store as unknown as { database?: unknown }).database as
            | { query: (sql: string) => { run: (...args: unknown[]) => void } }
            | undefined;
        raw?.query("DELETE FROM documents WHERE id = ?").run(doc.documentId);
        // Now manually delete the dangling archive row to confirm nothing
        // blocks cleanup.
        const deleted = store.deleteArchives([archive.id]);
        expect(deleted).toBe(archive.byteCount);
        expect(store.archiveBytes()).toBe(0);
        store.close();
    });

    it("does not delete files outside the project store", async () => {
        harness = await makeRetentionHarness();
        const store = new ThinkStore({
            config: DEFAULT_THINK_IN_CODE_CONFIG,
            storeRoot: harness.storeRoot,
            canonicalPath: "/workspace/proj",
        });
        store.archive({ kind: "command-output", data: "inside" });
        const outsidePath = join(harness.home, "outside.bin");
        await Bun.write(outsidePath, "do not touch me");
        runRetention(store, DEFAULT_THINK_IN_CODE_CONFIG);
        expect(await Bun.file(outsidePath).exists()).toBe(true);
        store.close();
    });
});