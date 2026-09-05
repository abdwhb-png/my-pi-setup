import { afterEach, describe, expect, it } from "bun:test";
import {
    access,
    appendFile,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTelemetryWriter,
    purgeExpiredTelemetry,
    readRecentTelemetry,
    resolveTelemetryRoot,
} from "./storage.ts";
import {
    SAFE_BASH_TELEMETRY_SCHEMA_VERSION,
    type SafeBashTelemetryEvent,
} from "./types.ts";

const fixtures: string[] = [];

afterEach(async () => {
    await Promise.all(
        fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

async function makeFixture(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "safe-bash-telemetry-"));
    fixtures.push(path);
    return path;
}

function makeEvent(
    sequence: number,
    overrides: Partial<SafeBashTelemetryEvent> = {},
): SafeBashTelemetryEvent {
    return {
        schemaVersion: SAFE_BASH_TELEMETRY_SCHEMA_VERSION,
        eventId: `event-${sequence}`,
        timestamp: "2026-08-25T12:00:00.000Z",
        sessionId: "session-1",
        origin: "safe_bash",
        toolCallId: `call-${sequence}`,
        cwd: "/workspace/project",
        project: "/workspace/project",
        sequence,
        decision: "allowed",
        outcome: "succeeded",
        command: `printf ${sequence}`,
        commandLength: 8,
        ...overrides,
    };
}

describe("safe-bash telemetry storage", () => {
    it("expands portable home-relative roots", () => {
        expect(resolveTelemetryRoot("~/.pi/agent/safe-bash-telemetry")).toBe(
            join(process.env.HOME!, ".pi/agent/safe-bash-telemetry"),
        );
    });

    it("appends ordered JSONL with private permissions", async () => {
        const root = await makeFixture();
        const writer = createTelemetryWriter(root, "session-1");

        await Promise.all([writer.append(makeEvent(1)), writer.append(makeEvent(2))]);
        await writer.flush();

        const dateDirectory = join(root, "2026-08-25");
        const telemetryFile = join(dateDirectory, "session-1.jsonl");
        const lines = (await readFile(telemetryFile, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as SafeBashTelemetryEvent);

        expect(lines.map((event) => event.sequence)).toEqual([1, 2]);
        expect((await stat(root)).mode & 0o777).toBe(0o700);
        expect((await stat(dateDirectory)).mode & 0o777).toBe(0o700);
        expect((await stat(telemetryFile)).mode & 0o777).toBe(0o600);
    });

    it("refuses to append through a symlinked telemetry file", async () => {
        const root = await makeFixture();
        const outside = join(await makeFixture(), "outside.jsonl");
        const dateDirectory = join(root, "2026-08-25");
        await mkdir(dateDirectory);
        await writeFile(outside, "seed\n");
        await symlink(outside, join(dateDirectory, "session-1.jsonl"));
        const writer = createTelemetryWriter(root, "session-1");

        await expect(writer.append(makeEvent(1))).rejects.toThrow();
        expect(await readFile(outside, "utf8")).toBe("seed\n");
    });

    it("rejects a symlinked telemetry root for reads and cleanup", async () => {
        const outside = await makeFixture();
        const fixture = await makeFixture();
        const root = join(fixture, "linked-root");
        await symlink(outside, root);

        await expect(
            readRecentTelemetry(root, {
                days: 30,
                limit: 10,
                project: "/workspace/project",
                now: new Date("2026-08-25T23:00:00.000Z"),
            }),
        ).rejects.toThrow("symbolic link");
        await expect(
            purgeExpiredTelemetry(
                root,
                30,
                new Date("2026-08-25T23:00:00.000Z"),
            ),
        ).rejects.toThrow("symbolic link");
    });

    it("purges only expired managed date directories and skips symlinks", async () => {
        const root = await makeFixture();
        const outside = await makeFixture();
        await mkdir(join(root, "2026-01-01"));
        await mkdir(join(root, "2026-08-20"));
        await symlink(outside, join(root, "2025-01-01"));

        await purgeExpiredTelemetry(
            root,
            30,
            new Date("2026-08-25T12:00:00.000Z"),
        );

        expect(await exists(join(root, "2026-01-01"))).toBe(false);
        expect(await exists(join(root, "2026-08-20"))).toBe(true);
        expect(await exists(join(root, "2025-01-01"))).toBe(true);
        expect(await exists(outside)).toBe(true);
    });

    it("migrates schema-v1 records to safe_bash origin", async () => {
        const root = await makeFixture();
        const directory = join(root, "2026-08-25");
        await mkdir(directory);
        await writeFile(
            join(directory, "legacy.jsonl"),
            `${JSON.stringify({
                schemaVersion: 1,
                eventId: "legacy-1",
                timestamp: "2026-08-25T12:00:00.000Z",
                sessionId: "legacy-session",
                toolCallId: "legacy-call",
                cwd: "/workspace/project",
                project: "/workspace/project",
                sequence: 1,
                decision: "allowed",
                outcome: "succeeded",
                commandLength: 9,
            })}\n`,
        );

        const events = await readRecentTelemetry(root, {
            days: 30,
            limit: 10,
            project: "/workspace/project",
            now: new Date("2026-08-25T23:00:00.000Z"),
        });

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            schemaVersion: 2,
            origin: "safe_bash",
            eventId: "legacy-1",
        });
    });

    it("ignores legacy Think records while retaining Safe Bash and v1 records", async () => {
        const root = await makeFixture();
        const directory = join(root, "2026-08-25");
        await mkdir(directory);
        const base = makeEvent(1);
        await writeFile(
            join(directory, "mixed.jsonl"),
            [
                JSON.stringify(base),
                JSON.stringify({ ...base, eventId: "think-1", origin: "think_execute" }),
                JSON.stringify({
                    ...base,
                    eventId: "think-v1-1",
                    schemaVersion: 1,
                    origin: "think_execute",
                }),
                JSON.stringify({
                    ...base,
                    eventId: "think-v1-2",
                    schemaVersion: 1,
                    origin: "think_batch_execute",
                }),
                JSON.stringify({ ...base, eventId: "legacy-1", schemaVersion: 1, origin: undefined }),
            ].join("\n") + "\n",
        );

        const events = await readRecentTelemetry(root, {
            days: 30,
            limit: 10,
            project: "/workspace/project",
            now: new Date("2026-08-25T23:00:00.000Z"),
        });

        expect(events.map((event) => event.eventId)).toEqual([
            "event-1",
            "legacy-1",
        ]);
    });

    it("reads bounded recent events for only the requested project", async () => {
        const root = await makeFixture();
        const writer = createTelemetryWriter(root, "session-1");
        await writer.append(
            makeEvent(1, { timestamp: "2026-07-01T12:00:00.000Z" }),
        );
        await writer.append(
            makeEvent(2, { timestamp: "2026-08-24T12:00:00.000Z" }),
        );
        await writer.append(makeEvent(3));
        await writer.append(
            makeEvent(4, {
                project: "/workspace/other",
                cwd: "/workspace/other",
            }),
        );
        await writer.flush();
        await appendFile(
            join(root, "2026-08-25", "session-1.jsonl"),
            "not-json\n",
        );

        const events = await readRecentTelemetry(root, {
            days: 30,
            limit: 10,
            project: "/workspace/project",
            now: new Date("2026-08-25T23:00:00.000Z"),
        });

        expect(events.map((event) => event.sequence)).toEqual([2, 3]);
    });

    it("returns all date-window candidates before audit ranking", async () => {
        const root = await makeFixture();
        const writer = createTelemetryWriter(root, "session-1");
        await writer.append(
            makeEvent(1, {
                decision: "blocked",
                outcome: "blocked",
                groupId: "rm",
            }),
        );
        await writer.append(makeEvent(2));
        await writer.append(makeEvent(3));
        await writer.flush();

        const events = await readRecentTelemetry(root, {
            days: 30,
            limit: 2,
            project: "/workspace/project",
            now: new Date("2026-08-25T23:00:00.000Z"),
        });

        expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    });
});
