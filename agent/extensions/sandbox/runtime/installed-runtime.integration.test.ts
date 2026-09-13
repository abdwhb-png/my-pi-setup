import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import {
    calls,
    createTestSession,
    says,
    when,
    type TestSession,
} from "@abdwhb-png/pi-test-harness";

import { resolveSandboxExecutionContext } from "../../_shared/sandbox-runtime/execution-context.ts";
import { localMachineId } from "../capabilities/authority.ts";
import { inspectManagedPrivateRuntime } from "./zerobox-backend.ts";

const AGENT_ROOT = resolve(import.meta.dir, "../../..");
const SANDBOX_EXTENSION = resolve(import.meta.dir, "../index.ts");
const BASH_EXECUTION_EXTENSION = resolve(
    import.meta.dir,
    "../../bash-execution/index.ts",
);
const PERMISSION_EXTENSION = resolve(
    AGENT_ROOT,
    "node_modules/@gotgenes/pi-permission-system/src/index.ts",
);

test.skipIf(
    process.platform !== "linux" ||
        process.env.PI_SANDBOX_INSTALLED_CONTRACT !== "1",
)(
    "runs bash and safe_bash through the installed managed private runtime",
    async () => {
        const root = await mkdtemp("/var/tmp/pi-installed-runtime-");
        const project = join(root, "project");
        const agentDir = join(root, "agent");
        const marker = join(root, "host-marker");
        const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
        const priorSecret = process.env.PI_A8_HOST_MARKER;
        const priorSessionStatus = process.env.PI_SANDBOX_SESSION_STATUS;
        let session: TestSession | undefined;
        const admittedContexts = new Map<
            string,
            ReturnType<typeof resolveSandboxExecutionContext>
        >();
        const errorSpy = spyOn(ExtensionRunner.prototype, "emitError");
        try {
            const [packageRoot, sandboxEntrypoint] = await Promise.all([
                realpath(AGENT_ROOT),
                realpath(SANDBOX_EXTENSION),
            ]);
            expect(sandboxEntrypoint).toBe(
                join(packageRoot, "extensions/sandbox/index.ts"),
            );

            // Inspection verifies the managed release without running it. The
            // tool calls below are the first target-side engine executions.
            const entry = join(homedir(), ".pi", "bin", "zerobox");
            expect((await lstat(entry)).isSymbolicLink()).toBe(true);
            const runtime = await inspectManagedPrivateRuntime();
            const release = dirname(dirname(runtime.binaryPath));
            expect(runtime.binaryPath).toBe(join(release, "bin", "zerobox"));
            expect(release).toStartWith(
                join(homedir(), ".pi", "runtimes", "zerobox"),
            );
            const provenance = JSON.parse(
                await readFile(join(release, "provenance.json"), "utf8"),
            ) as { binarySha256: string; runtimeManifestSha256: string; helperSha256: string };
            expect(
                createHash("sha256")
                    .update(await readFile(runtime.binaryPath))
                    .digest("hex"),
            ).toBe(provenance.binarySha256);
            expect(runtime.manifestSha256).toBe(
                provenance.runtimeManifestSha256,
            );
            expect(runtime.helperSha256).toBe(provenance.helperSha256);

            await Promise.all([
                mkdir(project, { recursive: true, mode: 0o700 }),
                mkdir(join(agentDir, "extensions/pi-permission-system"), {
                    recursive: true,
                    mode: 0o700,
                }),
            ]);
            await Promise.all([
                writeFile(marker, "host-only", { mode: 0o600 }),
                writeFile(
                    join(agentDir, "sandbox.json"),
                    `${JSON.stringify({
                        version: 2,
                        machineId: localMachineId(),
                        docker: { allowed: false },
                    })}\n`,
                ),
                writeFile(
                    join(agentDir, "extensions/pi-permission-system/config.json"),
                    `${JSON.stringify({
                        authorizerChain: [],
                        shellTools: { safe_bash: { commandArgument: "command" } },
                        permission: { "*": "allow" },
                    })}\n`,
                ),
            ]);
            process.env.PI_CODING_AGENT_DIR = agentDir;
            process.env.PI_A8_HOST_MARKER = "must-not-pass";
            delete process.env.PI_SANDBOX_SESSION_STATUS;

            session = await createTestSession({
                cwd: project,
                extensions: [
                    PERMISSION_EXTENSION,
                    SANDBOX_EXTENSION,
                    BASH_EXECUTION_EXTENSION,
                ],
                extensionFactories: [(pi) => {
                    // Successful contexts are transient and cleared at agent_end.
                    // Observe the real admission while the tool result is emitted.
                    pi.on("tool_result", (event) => {
                        if (event.toolName === "bash" || event.toolName === "safe_bash") {
                            admittedContexts.set(
                                event.toolCallId,
                                resolveSandboxExecutionContext(event.toolCallId, event.details),
                            );
                        }
                    });
                }],
                propagateErrors: false,
            });
            const command = [
                "test \"$(printf pipeline | sed 's/pipeline/private/')\" = private",
                "test \"$TMPDIR\" = /tmp",
                "printf private > /tmp/a8-marker",
                "test \"$(cat /tmp/a8-marker)\" = private",
                `if cat ${JSON.stringify(marker)} >/dev/null 2>&1; then exit 41; fi`,
                'test -z "${PI_A8_HOST_MARKER+x}"',
                "test ! -e /usr/bin/node",
                "case \":$PATH:\" in *:/usr/bin:*|*:/bin:*) exit 42;; esac",
                "printf installed-private",
            ].join(" && ");
            await session.run(
                when("Exercise the installed private runtime", [
                    calls("bash", { command, timeout: 20 }),
                    calls("safe_bash", { command, timeout: 20 }),
                    says("Installed runtime exercised."),
                ]),
            );

            for (const tool of ["bash", "safe_bash"]) {
                const result = session.events.toolResultsFor(tool).at(-1);
                expect(result, `${tool}: ${result?.text}`).toMatchObject({
                    mocked: false,
                    isError: false,
                    details: {
                        execution: {
                            status: "sandboxed",
                            backend: "zerobox",
                            profile: "bash-general",
                            tmpNamespace: "lease-private",
                            outcome: "succeeded",
                            exitCode: 0,
                        },
                    },
                });
                expect(
                    admittedContexts.get(result!.toolCallId),
                ).toMatchObject({
                    version: 3,
                    admission: "admitted",
                    runtime: {
                        target: runtime.target,
                        version: runtime.version,
                        manifestSha256: runtime.manifestSha256,
                        component: "shell",
                    },
                    helperSha256: runtime.helperSha256,
                });
                expect(result?.text).toContain("installed-private");
            }
            expect(errorSpy.mock.calls).toEqual([]);
        } finally {
            try {
                await session?.session.extensionRunner.emit({
                    type: "session_shutdown",
                    reason: "quit",
                });
            } finally {
                session?.dispose();
                errorSpy.mockRestore();
                if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
                else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
                if (priorSecret === undefined) delete process.env.PI_A8_HOST_MARKER;
                else process.env.PI_A8_HOST_MARKER = priorSecret;
                if (priorSessionStatus === undefined)
                    delete process.env.PI_SANDBOX_SESSION_STATUS;
                else process.env.PI_SANDBOX_SESSION_STATUS = priorSessionStatus;
                await rm(root, { recursive: true, force: true });
            }
        }
    },
    90_000,
);
