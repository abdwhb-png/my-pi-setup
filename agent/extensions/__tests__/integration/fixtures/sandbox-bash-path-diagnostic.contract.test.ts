import { expect, test } from "bun:test";
import {
    calls,
    createTestSession,
    says,
    when,
} from "@abdwhb-png/pi-test-harness";

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { localMachineId } from "../../../_shared/sandbox-runtime/machine-identity.ts";
import { publicExtensionEntrypoints } from "../public-extension-session.ts";

const started = performance.now();
function phase(name: string): void {
    console.error(
        `[sandbox-path] ${name} ${Math.round(performance.now() - started)}ms`,
    );
}

test.skipIf(process.env.PI_SANDBOX_PATH_DIAGNOSTIC_CHILD !== "1")(
    "Sandbox and Bash diagnose an unexposed sibling using the admitted runtime",
    async () => {
        const root = process.env.PI_SANDBOX_PATH_DIAGNOSTIC_ROOT!;
        phase("setup");
        const cwd = join(root, "project");
        const sibling = join(root, "sibling");
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        const previousCwd = process.cwd();
        let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
        try {
            await mkdir(join(cwd, ".pi"), { recursive: true });
            await mkdir(process.env.TMPDIR!, { recursive: true });
            await mkdir(sibling);
            process.chdir(cwd);
            process.env.PI_CODING_AGENT_DIR = root;
            await writeFile(
                join(cwd, ".pi/settings.json"),
                JSON.stringify({
                    safeBash: {
                        mode: "coexist",
                        telemetry: { enabled: false },
                    },
                }),
            );
            await writeFile(
                join(root, "sandbox.json"),
                JSON.stringify({ version: 2, machineId: localMachineId() }),
                { mode: 0o600 },
            );
            const [sandboxSource, bashSource] = publicExtensionEntrypoints(
                "sandbox",
                "bash-execution",
            );
            const entrypoint = join(root, "sandbox-entrypoint.ts");
            // Real public factories and real Zerobox. Analysis preflight is an unrelated
            // external boundary; the separate Analysis contracts verify its workers.
            await writeFile(
                entrypoint,
                [
                    `import { createSandboxExtension } from ${JSON.stringify(sandboxSource)};`,
                    "export default pi => createSandboxExtension(pi, {",
                    `zeroboxBackend: ${JSON.stringify({
                        binaryPath: process.env.PI_SANDBOX_ZEROBOX_BINARY,
                        expectedProvenance: {
                            version:
                                process.env.PI_SANDBOX_ZEROBOX_VERSION ??
                                "0.3.3-fork.17",
                            binarySha256: process.env.PI_SANDBOX_ZEROBOX_SHA256,
                        },
                        runtimeBundlePath:
                            process.env.PI_SANDBOX_RUNTIME_BUNDLE,
                        probeRoot: join(root, "probe"),
                    })},`,
                    "analysisServiceOptions: { runHost: async request => {",
                    "if (!['sandbox-preflight-typescript', 'sandbox-preflight-python'].includes(request.id)) throw new Error('Unexpected Analysis request in Bash contract');",
                    "return { output: '1', stderr: '', runtime: request.worker, durationMs: 0, truncated: false };",
                    "} },",
                    "});",
                ].join("\n"),
            );
            phase("startup");
            session = await createTestSession({
                cwd,
                extensions: [entrypoint, bashSource],
            });
            phase("bash-and-safe-bash");

            await session.run(
                when("Inspect the sibling", [
                    calls("bash", { command: `cd ${sibling}` }),
                    calls("safe_bash", { command: `cd ${sibling}` }),
                    says("done"),
                ]),
            );
            for (const tool of ["bash", "safe_bash"]) {
                const result = session.events.toolResultsFor(tool).at(-1)!;
                expect(result.mocked).toBe(false);
                expect(result.isError).toBe(true);
                expect(result.text).toContain(
                    `cd: ${sibling}: No such file or directory`,
                );
                expect(result.text).toContain(
                    `Sandbox: ${sibling} is outside the admitted read scope.`,
                );
                expect(result.details).toMatchObject({
                    execution: { status: "sandboxed", exitCode: 1 },
                    sandboxExecutionContext: {
                        version: 3,
                        admission: "admitted",
                    },
                });
            }

            phase("user-bash");
            const command = `s cd ${sibling}`;
            const event = await session.session.extensionRunner.emitUserBash({
                type: "user_bash",
                command,
                cwd,
                excludeFromContext: false,
            });
            const forced = await session.session.executeBash(
                command,
                undefined,
                { operations: event?.operations },
            );
            expect(forced.exitCode).toBe(1);
            expect(forced.output).toContain(
                `Sandbox: ${sibling} is outside the admitted read scope.`,
            );

            phase("missing-project-path");
            const missing = join(cwd, "missing");
            await session.run(
                when("Inspect a missing project path", [
                    calls("bash", { command: `cd ${missing}` }),
                    says("done"),
                ]),
            );
            const missingResult = session.events.toolResultsFor("bash").at(-1)!;
            expect(missingResult.isError).toBe(true);
            expect(missingResult.text).toContain("No such file or directory");
            expect(missingResult.text).not.toContain("Sandbox:");
        } finally {
            phase("shutdown");
            await session?.session.extensionRunner?.emit({
                type: "session_shutdown",
                reason: "quit",
            });
            session?.dispose();
            if (previousAgentDir === undefined)
                delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            process.chdir(previousCwd);
            phase("complete");
        }
    },
    60_000,
);
