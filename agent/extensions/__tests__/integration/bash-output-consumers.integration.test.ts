import { afterEach, expect, test } from "bun:test";
import {
    calls,
    createTestSession,
    says,
    when,
} from "@abdwhb-png/pi-test-harness";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { hostExecution } from "../../_shared/execution-provenance/index.ts";
import {
    managedOutputArchiveFileName,
    type ManagedOutputArchiveMetadataV1,
} from "../../_shared/tool-output-archive.ts";
import {
    claimSandboxRuntime,
    publishSandboxRuntime,
    releaseSandboxRuntime,
} from "../../_shared/sandbox-runtime/index.ts";
import {
    emptyGrants,
    publishShellRuntime,
    releaseShellRuntime,
} from "../../_shared/shell-runtime/index.ts";
import { publicExtensionEntrypoints } from "./public-extension-session.ts";

const sessions: Array<Awaited<ReturnType<typeof createTestSession>>> = [];
const roots: string[] = [];
const owners: symbol[] = [];
const previousArchiveRoot = process.env.PI_TOOL_RESULT_ARCHIVE_DIR;

afterEach(async () => {
    for (const session of sessions.splice(0)) session.dispose();
    for (const owner of owners.splice(0)) {
        releaseSandboxRuntime(owner);
        releaseShellRuntime(owner);
    }
    for (const root of roots.splice(0))
        await rm(root, { recursive: true, force: true });
    if (previousArchiveRoot === undefined)
        delete process.env.PI_TOOL_RESULT_ARCHIVE_DIR;
    else process.env.PI_TOOL_RESULT_ARCHIVE_DIR = previousArchiveRoot;
});

test.each(["before", "after"] as const)(
    "Save Tokens preserves Bash provenance when loaded %s Bash",
    async (order) => {
        const cwd = await mkdtemp(join(tmpdir(), "pi-compressed-provenance-"));
        roots.push(cwd);
        await mkdir(join(cwd, ".pi"));
        await writeFile(
            join(cwd, ".pi/settings.json"),
            JSON.stringify({
                safeBash: {
                    mode: "coexist",
                    telemetry: { enabled: false },
                },
                saveTokens: {
                    compressor: {
                        enabled: true,
                        archiveOriginal: true,
                        minTokensByGroup: { shell: 0 },
                        capFallbackTokens: 64,
                    },
                    telemetry: { enabled: false },
                },
            }),
        );
        process.env.PI_TOOL_RESULT_ARCHIVE_DIR = join(cwd, "archives");
        const owner = Symbol("compressed-provenance");
        owners.push(owner);
        claimSandboxRuntime(owner);
        publishSandboxRuntime(owner, { state: "disabled" });
        publishShellRuntime(owner, () => ({
            state: "ready",
            projectRoot: cwd,
            mode: "host",
            requestedMode: "host",
            requestedProfile: "host",
            profile: "host",
            grants: emptyGrants(),
            requestedGrants: emptyGrants(),
            authorityPath: "/unused",
        }));
        const bash = publicExtensionEntrypoints("bash-execution")[0];
        const saveTokens = publicExtensionEntrypoints("save-tokens")[0];
        const session = await createTestSession({
            cwd,
            extensions:
                order === "before"
                    ? [saveTokens, bash]
                    : [bash, saveTokens],
        });
        sessions.push(session);

        await session.run(
            when("Produce output", [
                calls("safe_bash", {
                    command: "printf 'datum\\n%.0s' {1..500}",
                }),
                says("done"),
            ]),
        );
        const result = session.events.toolResultsFor("safe_bash").at(-1)!;
        expect(result.isError, result.text).toBe(false);
        expect(result.details).toMatchObject({
            execution: { status: "unsandboxed", exitCode: 0 },
        });
        if (
            result.details &&
            typeof result.details === "object" &&
            "compression" in result.details
        ) {
            expect(result.details).toMatchObject({
                compression: {
                    sourceExecution: {
                        status: "unsandboxed",
                        exitCode: 0,
                    },
                },
            });
        }
    },
    30_000,
);

test("Pi Overrides preserves exact archive pagination and source provenance", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-archive-pages-"));
    roots.push(cwd);
    const archiveRoot = join(cwd, "archives");
    await mkdir(archiveRoot);
    process.env.PI_TOOL_RESULT_ARCHIVE_DIR = archiveRoot;
    const sourceExecution = hostExecution("process");
    const archivePath = join(
        archiveRoot,
        managedOutputArchiveFileName({
            timestamp: Date.now(),
            toolName: "bash",
            toolCallId: "paged",
            digest: "1234567890ab",
        }),
    );
    await writeFile(
        archivePath,
        Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join(
            "\n",
        ),
    );
    await writeFile(
        `${archivePath}.meta.json`,
        JSON.stringify({
            version: 1,
            kind: "output-text",
            toolName: "bash",
            sourceExecution,
            storage: hostExecution(),
        } satisfies ManagedOutputArchiveMetadataV1),
    );
    const session = await createTestSession({
        cwd,
        extensions: publicExtensionEntrypoints(
            "bash-execution",
            "pi-overrides",
            "tool-groups",
        ),
    });
    sessions.push(session);

    await session.run(
        when("Read the archived page", [
            calls("read", { path: archivePath, offset: 101, limit: 3 }),
            says("done"),
        ]),
    );
    const result = session.events.toolResultsFor("read").at(-1)!;
    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    expect(JSON.stringify(result.content)).toContain(
        "line 101\\nline 102\\nline 103",
    );
    expect(JSON.stringify(result.content)).not.toContain("line 100");
    expect(result.details).toMatchObject({
        execution: { status: "unsandboxed", tmpNamespace: "host" },
        outputArchive: { kind: "output-text", sourceExecution },
    });
    expect(await readFile(archivePath, "utf8")).toContain("line 120");
});

test("Pi Overrides native file tools identify their host namespace", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-native-provenance-"));
    roots.push(cwd);
    await writeFile(resolve(cwd, "sample.txt"), "needle\n");
    const session = await createTestSession({
        cwd,
        extensions: publicExtensionEntrypoints(
            "bash-execution",
            "pi-overrides",
            "tool-groups",
        ),
    });
    sessions.push(session);

    await session.run(
        when("Inspect the file", [
            calls("read", { path: resolve(cwd, "sample.txt") }),
            calls("ls", { path: cwd }),
            calls("grep", { pattern: "needle", path: cwd }),
            calls("find", { pattern: "*.txt", path: cwd }),
            says("Finished"),
        ]),
    );
    for (const name of ["read", "ls", "grep", "find"]) {
        const result = session.events.toolResultsFor(name).at(-1);
        expect(result, name).toMatchObject({ mocked: false, isError: false });
        expect(result?.details, name).toMatchObject({
            execution: {
                status: "unsandboxed",
                backend: "host",
                tmpNamespace: "host",
            },
        });
    }
});
