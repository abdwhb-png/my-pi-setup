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
import { join } from "node:path";

import { localMachineId } from "./capabilities/authority.ts";
import { createSandboxExtension } from "./index.ts";
import {
    createPrivateTempLease,
    recoverStalePrivateTempLeases,
} from "./runtime/private-temp.ts";

// Native authority tests start the real Sandbox extension. Require an explicit
// candidate so running this file never silently starts a personal backend.
test.skipIf(
    process.platform !== "linux" ||
        !process.env.PI_SANDBOX_ZEROBOX_BINARY ||
        !process.env.PI_SANDBOX_ZEROBOX_SHA256,
).each([true, false])(
    "real Pi blocks native write and edit of active v2 authority and aliases (exists=%s)",
    async (exists) => {
        const binaryPath = process.env.PI_SANDBOX_ZEROBOX_BINARY;
        const binarySha256 = process.env.PI_SANDBOX_ZEROBOX_SHA256;
        if (!binaryPath || !binarySha256)
            throw new Error("Explicit Zerobox binary and SHA256 are required");
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
                extensionFactories: [
                    (pi) =>
                        createSandboxExtension(pi, {
                            zeroboxBackend: {
                                binaryPath,
                                expectedProvenance: {
                                    version: "0.3.3-fork.17",
                                    binarySha256,
                                },
                                probeRoot: join(root, "probe"),
                            },
                            sandboxServiceOptions: {
                                createLease: () =>
                                    createPrivateTempLease({
                                        rootDir: leaseRoot,
                                    }),
                                recoverStaleLeases: async () => {
                                    await recoverStalePrivateTempLeases({
                                        rootDir: leaseRoot,
                                    });
                                },
                            },
                            analysisServiceOptions: {
                                runHost: async (request) => {
                                    if (
                                        ![
                                            "sandbox-preflight-typescript",
                                            "sandbox-preflight-python",
                                        ].includes(request.id)
                                    )
                                        throw new Error(
                                            "Unexpected Analysis request",
                                        );
                                    analysisRequests.push(request.id);
                                    return {
                                        output: "1",
                                        stderr: "",
                                        runtime: request.worker,
                                        durationMs: 0,
                                        truncated: false,
                                    };
                                },
                            },
                        }),
                ],
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
                await expect(
                    readFile(authority, "utf8"),
                ).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            try {
                await session?.session.extensionRunner?.emit({
                    type: "session_shutdown",
                    reason: "quit",
                });
            } finally {
                session?.dispose();
                const errors = extensionErrors.mock.calls.map(
                    ([error]) => error,
                );
                extensionErrors.mockRestore();
                if (previous === undefined)
                    delete process.env.PI_CODING_AGENT_DIR;
                else process.env.PI_CODING_AGENT_DIR = previous;
                await rm(root, { recursive: true, force: true });
                await rm(leaseRoot, { recursive: true, force: true });
                expect(errors).toEqual([]);
                expect(analysisRequests).toContain(
                    "sandbox-preflight-typescript",
                );
                expect(analysisRequests).toContain("sandbox-preflight-python");
            }
        }
    },
    30_000,
);
