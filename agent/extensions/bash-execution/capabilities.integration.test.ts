import { expect, spyOn, test } from "bun:test";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import {
    calls,
    createTestSession,
    says,
    when,
} from "@abdwhb-png/pi-test-harness";
import {
    link,
    mkdtemp,
    mkdir,
    readFile,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import {
    emptyGrants,
    localMachineId,
} from "../sandbox/capabilities/authority.ts";
import {
    publishShellRuntime,
    releaseShellRuntime,
} from "../sandbox/capabilities/runtime.ts";
import { createSandboxExtension } from "../sandbox/index.ts";
import { createPrivateTempLease, recoverStalePrivateTempLeases } from "../sandbox/runtime/private-temp.ts";

// Native authority tests start the real Sandbox extension. Require an explicit
// candidate so running this file never silently starts a personal backend.
test.skipIf(process.platform !== "linux" ||
    !process.env.PI_SANDBOX_ZEROBOX_BINARY || !process.env.PI_SANDBOX_ZEROBOX_SHA256).each([true, false])(
    "real Pi blocks native write and edit of active v2 authority and aliases (exists=%s)",
    async (exists) => {
        const binaryPath = process.env.PI_SANDBOX_ZEROBOX_BINARY;
        const binarySha256 = process.env.PI_SANDBOX_ZEROBOX_SHA256;
        if (!binaryPath || !binarySha256) throw new Error("Explicit Zerobox binary and SHA256 are required");
        const root = await mkdtemp("/var/tmp/pi-authority-tools-");
        const leaseRoot = await mkdtemp("/var/tmp/z-");
        const cwd = join(root, "project");
        await mkdir(cwd);
        const previous = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = root;
        const authority = join(root, "sandbox.json");
        const original = JSON.stringify({
            version: 2,
            machineId: localMachineId(),
        });
        if (exists) await writeFile(authority, original, { mode: 0o600 });
        await symlink(authority, join(cwd, "alias"));
        if (exists) await link(authority, join(cwd, "hardlink"));
        else await symlink(authority, join(cwd, "hardlink"));
        let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
        const analysisRequests: string[] = [];
        const extensionErrors = spyOn(ExtensionRunner.prototype, "emitError");
        try {
            session = await createTestSession({
                cwd,
                extensionFactories: [(pi) => createSandboxExtension(pi, {
                    zeroboxBackend: {
                        binaryPath,
                        expectedProvenance: {
                            version: "0.3.3-fork.17",
                            binarySha256,
                        },
                        probeRoot: join(root, "probe"),
                    },
                    sandboxServiceOptions: {
                        createLease: () => createPrivateTempLease({ rootDir: leaseRoot }),
                        recoverStaleLeases: async () => { await recoverStalePrivateTempLeases({ rootDir: leaseRoot }); },
                    },
                    // These tests exercise native authority gates, not Analysis.
                    analysisServiceOptions: { runHost: async (request) => {
                        if (!['sandbox-preflight-typescript', 'sandbox-preflight-python'].includes(request.id)) throw new Error('Unexpected Analysis request');
                        analysisRequests.push(request.id);
                        return { output: "1", stderr: "", runtime: request.worker, durationMs: 0, truncated: false };
                    } },
                })],
                propagateErrors: false,
            });
            await session.run(
                when("Attempt native authority changes", [
                    calls("write", { path: authority, content: "changed" }),
                    calls("write", {
                        path: join(cwd, "alias"),
                        content: "changed",
                    }),
                    calls("edit", {
                        path: join(cwd, "hardlink"),
                        oldText: "foreign-fixture",
                        newText: "local",
                    }),
                    says("All changes refused"),
                ]),
            );
            for (const tool of ["write", "edit"]) {
                for (const result of session.events.toolResultsFor(tool)) {
                    expect(result.isError).toBe(true);
                    expect(result.text).toContain("/sandbox command");
                }
            }
            expect(session.events.toolResultsFor("write")).toHaveLength(2);
            expect(session.events.toolResultsFor("edit")).toHaveLength(1);
            if (exists) expect(await readFile(authority, "utf8")).toBe(original);
            else
                await expect(readFile(authority, "utf8")).rejects.toMatchObject({
                    code: "ENOENT",
                });
        } finally {
            try {
                await session?.session.extensionRunner?.emit({
                    type: "session_shutdown",
                    reason: "quit",
                });
            } finally {
                session?.dispose();
                const errors = extensionErrors.mock.calls.map(([error]) => error);
                extensionErrors.mockRestore();
                if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
                else process.env.PI_CODING_AGENT_DIR = previous;
                await rm(root, { recursive: true, force: true });
                await rm(leaseRoot, { recursive: true, force: true });
                expect(errors).toEqual([]);
                expect(analysisRequests).toContain("sandbox-preflight-typescript");
                expect(analysisRequests).toContain("sandbox-preflight-python");
            }
        }
    },
    30_000,
);

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
            "[pi-permission-system] is not permitted to run 'bash' command",
        );
        expect(result?.text).toContain("matched 'git *'");
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
