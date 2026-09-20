import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    managedOutputArchive,
    managedOutputArchiveFileName,
    managedOutputArchiveTimestamp,
} from "./tool-output-archive.ts";

let archiveRoot: string;
let previousArchiveRoot: string | undefined;

beforeEach(() => {
    archiveRoot = mkdtempSync(join(tmpdir(), "pi-shared-tool-archive-"));
    previousArchiveRoot = process.env.PI_TOOL_RESULT_ARCHIVE_DIR;
    process.env.PI_TOOL_RESULT_ARCHIVE_DIR = archiveRoot;
});

afterEach(() => {
    if (previousArchiveRoot === undefined) {
        delete process.env.PI_TOOL_RESULT_ARCHIVE_DIR;
    } else {
        process.env.PI_TOOL_RESULT_ARCHIVE_DIR = previousArchiveRoot;
    }
    rmSync(archiveRoot, { recursive: true, force: true });
});

describe("managed tool-output archives", () => {
    it("owns the safe filename format and timestamp parser", () => {
        const name = managedOutputArchiveFileName({
            timestamp: 123,
            toolName: "safe bash",
            toolCallId: "call/1",
            digest: "abcdef012345",
        });
        expect(name).toBe("123-safe_bash-call_1-abcdef012345.txt");
        expect(managedOutputArchiveTimestamp(name)).toBe(123);
        expect(managedOutputArchiveTimestamp("notes.txt")).toBeUndefined();
    });

    it("recognizes legacy archives without inventing source provenance", async () => {
        const path = join(
            archiveRoot,
            managedOutputArchiveFileName({
                timestamp: Date.now(),
                toolName: "bash",
                toolCallId: "call",
                digest: "aaaaaaaaaaa1",
            }),
        );
        writeFileSync(path, "legacy bytes");
        expect(await managedOutputArchive(path)).toMatchObject({
            sourceMetadata: "missing",
            sourceExecution: { status: "unknown" },
            storage: { status: "unsandboxed" },
        });
    });

    it("keeps an archive recognizable when its sidecar cannot be read", async () => {
        const path = join(
            archiveRoot,
            managedOutputArchiveFileName({
                timestamp: Date.now(),
                toolName: "bash",
                toolCallId: "call",
                digest: "aaaaaaaaaaa2",
            }),
        );
        writeFileSync(path, "exact bytes");
        writeFileSync(`${path}.meta.json`, "{}");
        unlinkSync(`${path}.meta.json`);
        mkdirSync(`${path}.meta.json`);
        expect(await managedOutputArchive(path)).toMatchObject({
            kind: "output-text",
            sourceExecution: { status: "unknown" },
            sourceMetadata: "unavailable",
        });
    });
});
