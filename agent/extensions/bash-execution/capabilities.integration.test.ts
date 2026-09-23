import { expect, test } from "bun:test";
import {
    calls,
    createTestSession,
    says,
    when,
} from "@abdwhb-png/pi-test-harness";
import {
    mkdtemp,
    mkdir,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import {
    emptyGrants,
    publishShellRuntime,
    releaseShellRuntime,
} from "../_shared/shell-runtime/index.ts";
test("real Pi permission extension blocks an ordinary host-mode command before process launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-permission-mode-"));
    const cwd = join(root, "project");
    await mkdir(cwd);
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousPath = process.env.PATH;
    process.env.PI_CODING_AGENT_DIR = root;
    process.env.PATH = [root, previousPath ?? ""].join(delimiter);
    const marker = join(root, "git-ran");
    await writeFile(
        join(root, "git"),
        `#!/bin/sh\nprintf ran > '${marker}'\n`,
        { mode: 0o700 },
    );
    const configDir = join(root, "extensions/pi-permission-system");
    await mkdir(configDir, { recursive: true });
    await writeFile(
        join(configDir, "config.json"),
        JSON.stringify({
            authorizerChain: [],
            shellTools: { safe_bash: { commandArgument: "command" } },
            permission: { "*": "allow", bash: { "git *": "deny" } },
        }),
    );
    const owner = Symbol("ordinary-host-permission");
    publishShellRuntime(owner, () => ({
        state: "ready",
        projectRoot: cwd,
        mode: "host",
        requestedMode: "host",
        profile: "host",
        requestedProfile: "host",
        grants: emptyGrants(),
        requestedGrants: emptyGrants(),
        authorityPath: join(root, "sandbox.json"),
    }));
    let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
    try {
        session = await createTestSession({
            cwd,
            propagateErrors: false,
            extensions: [
                resolve(
                    import.meta.dir,
                    "../../npm/node_modules/@gotgenes/pi-permission-system/src/index.ts",
                ),
                resolve(import.meta.dir, "index.ts"),
            ],
        });
        await session.run(
            when("Try the denied ordinary Git operation", [
                calls("safe_bash", {
                    command: "git checkout HEAD -- sample.ts",
                }),
                says("Refusal observed"),
            ]),
        );
        const result = session.events.toolResultsFor("safe_bash")[0];
        expect(result?.isError).toBe(true);
        expect(result?.text).toContain(
            "[pi-permission-system] Denied by policy: 'bash' (invoked as 'safe_bash')",
        );
        expect(result?.text).toContain("rule 'git *'");
        await expect(readFile(marker, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    } finally {
        await session?.session.extensionRunner?.emit({
            type: "session_shutdown",
            reason: "quit",
        });
        session?.dispose();
        releaseShellRuntime(owner);
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);

test("real Pi rejects legacy safe_bash hostCapability payload before execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-capability-legacy-"));
    const cwd = join(root, "project");
    await mkdir(cwd);
    const marker = join(root, "legacy-host-capability-ran");
    let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
    try {
        session = await createTestSession({
            cwd,
            extensions: [resolve(import.meta.dir, "index.ts")],
            propagateErrors: false,
        });
        await session.run(
            when("Send legacy safe_bash hostCapability", [
                calls("safe_bash", {
                    command: `printf legacy > '${marker}'`,
                    hostCapability: null,
                }),
                says("Observed refusal"),
            ]),
        );
        const result = session.events.toolResultsFor("safe_bash")[0];
        expect(result?.isError).toBe(true);
        expect(result?.text).toContain("migration-required");
        await expect(readFile(marker, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    } finally {
        await session?.session.extensionRunner?.emit({
            type: "session_shutdown",
            reason: "quit",
        });
        session?.dispose();
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);

test("real Pi records explicit host mode and descriptive host profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-host-mode-provenance-"));
    const cwd = join(root, "project");
    await mkdir(cwd);
    const owner = Symbol("host-mode-provenance");
    publishShellRuntime(owner, () => ({
        state: "ready",
        projectRoot: cwd,
        mode: "host",
        requestedMode: "host",
        profile: "host",
        requestedProfile: "host",
        grants: emptyGrants(),
        requestedGrants: emptyGrants(),
        authorityPath: join(root, "sandbox.json"),
    }));
    let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
    try {
        session = await createTestSession({
            cwd,
            extensions: [resolve(import.meta.dir, "index.ts")],
            propagateErrors: false,
        });
        await session.run(
            when("Use the selected host mode", [
                calls("safe_bash", { command: "printf host-mode" }),
                says("Observed host provenance"),
            ]),
        );
        expect(session.events.toolResultsFor("safe_bash")[0]).toMatchObject({
            isError: false,
            mocked: false,
            details: {
                execution: {
                    mode: "host",
                    shellProfile: "host",
                    status: "unsandboxed",
                    backend: "local",
                    tmpNamespace: "host",
                    outcome: "succeeded",
                },
            },
        });
    } finally {
        await session?.session.extensionRunner?.emit({
            type: "session_shutdown",
            reason: "quit",
        });
        session?.dispose();
        releaseShellRuntime(owner);
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);
