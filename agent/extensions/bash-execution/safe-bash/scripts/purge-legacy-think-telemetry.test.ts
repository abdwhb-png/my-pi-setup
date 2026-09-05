import { afterEach, describe, expect, it } from "bun:test";
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    formatPurgeSummary,
    purgeLegacyThinkEvents,
} from "./purge-legacy-think-telemetry.ts";

let fixture: string | undefined;

afterEach(async () => {
    if (fixture) await rm(fixture, { recursive: true, force: true });
    fixture = undefined;
});

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

describe("legacy Think telemetry purge", () => {
    it("dry-runs, applies atomically, preserves Safe Bash/v1, and is idempotent", async () => {
        fixture = await mkdtemp(join(tmpdir(), "purge-think-telemetry-"));
        const pureDate = join(fixture, "2026-09-01");
        const mixedDate = join(fixture, "2026-09-02");
        await mkdir(pureDate);
        await mkdir(mixedDate);
        const pureFile = join(pureDate, "pure.jsonl");
        const mixedFile = join(mixedDate, "mixed.jsonl");
        const secret = "DO_NOT_PRINT_THIS_COMMAND";
        const think = (origin: string, id: string) =>
            JSON.stringify({ origin, eventId: id, command: secret });
        const safe = JSON.stringify({
            schemaVersion: 2,
            origin: "safe_bash",
            eventId: "safe-1",
            command: "printf safe",
        });
        const legacyV1 = JSON.stringify({
            schemaVersion: 1,
            eventId: "legacy-1",
            command: "printf historical",
        });
        await writeFile(
            pureFile,
            `${think("think_execute", "think-1")}\n${think("think_batch_execute", "think-2")}\n`,
        );
        const mixedOriginal = `${safe}\n${think("think_execute", "think-3")}\n${legacyV1}\nnot-json\n`;
        await writeFile(mixedFile, mixedOriginal);

        const dryRun = await purgeLegacyThinkEvents(fixture, {
            apply: false,
        });
        expect(dryRun).toMatchObject({
            apply: false,
            filesScanned: 2,
            filesChanged: 2,
            filesDeleted: 1,
            thinkEventsRemoved: 3,
            preservedLines: 3,
        });
        expect(await readFile(mixedFile, "utf8")).toBe(mixedOriginal);
        expect(await exists(pureFile)).toBe(true);
        expect(formatPurgeSummary(dryRun)).not.toContain(secret);

        const applied = await purgeLegacyThinkEvents(fixture, {
            apply: true,
        });
        expect(applied.directoriesDeleted).toBe(1);
        expect(await exists(pureFile)).toBe(false);
        expect(await exists(pureDate)).toBe(false);
        const mixed = await readFile(mixedFile, "utf8");
        expect(mixed).toContain("safe-1");
        expect(mixed).toContain("legacy-1");
        expect(mixed).toContain("not-json");
        expect(mixed).not.toContain("think-3");
        expect((await stat(mixedFile)).mode & 0o777).toBe(0o600);

        const repeated = await purgeLegacyThinkEvents(fixture, {
            apply: true,
        });
        expect(repeated.thinkEventsRemoved).toBe(0);
        expect(repeated.filesChanged).toBe(0);
        expect(await readFile(mixedFile, "utf8")).toBe(mixed);
    });
});
