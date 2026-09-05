import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createThinkTelemetryWriter,
    purgeExpiredThinkTelemetry,
    readRecentThinkTelemetry,
} from "./storage.ts";
import type { ThinkTelemetryEvent } from "./types.ts";

let fixture: string | undefined;

afterEach(async () => {
    if (fixture) await rm(fixture, { recursive: true, force: true });
    fixture = undefined;
});

function event(
    origin: ThinkTelemetryEvent["origin"],
    sequence: number,
    project = "/workspace/project",
): ThinkTelemetryEvent {
    return {
        schemaVersion: 1,
        eventId: `event-${sequence}`,
        timestamp: "2026-09-05T10:00:00.000Z",
        sessionId: "session-1",
        origin,
        toolCallId: `call-${sequence}`,
        cwd: project,
        project,
        sequence,
        decision: "allowed",
        outcome: "succeeded",
        commandLength: 9,
    };
}

describe("think-in-code telemetry storage", () => {
    it("stores both Think operations with private permissions", async () => {
        fixture = await mkdtemp(join(tmpdir(), "think-telemetry-"));
        const root = join(fixture, "telemetry");
        const writer = createThinkTelemetryWriter(root, "session-1");
        await writer.append(event("think_execute", 1));
        await writer.append(event("think_batch_execute", 2));
        await writer.flush();

        const directory = join(root, "2026-09-05");
        const file = join(directory, "session-1.jsonl");
        expect((await stat(root)).mode & 0o777).toBe(0o700);
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(2);
    });

    it("reads only current-project Think events and ignores Safe Bash records", async () => {
        fixture = await mkdtemp(join(tmpdir(), "think-telemetry-read-"));
        const root = join(fixture, "telemetry");
        const directory = join(root, "2026-09-05");
        await mkdir(directory, { recursive: true });
        await writeFile(
            join(directory, "mixed.jsonl"),
            [
                JSON.stringify(event("think_execute", 1)),
                JSON.stringify(event("think_batch_execute", 2, "/other")),
                JSON.stringify({ ...event("think_execute", 3), origin: "safe_bash" }),
            ].join("\n") + "\n",
        );

        const events = await readRecentThinkTelemetry(root, {
            days: 30,
            project: "/workspace/project",
            now: new Date("2026-09-05T20:00:00.000Z"),
        });

        expect(events.map((item) => item.eventId)).toEqual(["event-1"]);
    });

    it("purges only telemetry directories older than the configured retention", async () => {
        fixture = await mkdtemp(join(tmpdir(), "think-telemetry-retention-"));
        const root = join(fixture, "telemetry");
        const expired = join(root, "2026-08-05");
        const retained = join(root, "2026-09-05");
        await mkdir(expired, { recursive: true });
        await mkdir(retained, { recursive: true });
        await writeFile(join(expired, "old.jsonl"), "old\n");
        await writeFile(join(retained, "current.jsonl"), "current\n");

        await purgeExpiredThinkTelemetry(
            root,
            30,
            new Date("2026-09-05T20:00:00.000Z"),
        );

        await expect(stat(expired)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(join(retained, "current.jsonl"), "utf8")).toBe(
            "current\n",
        );
    });
});
