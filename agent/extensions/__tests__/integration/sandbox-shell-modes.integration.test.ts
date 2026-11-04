import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { writeFixtureFileAsync as writeFile } from "../../_shared/testing/config-fixture.ts";
import { expect, spyOn, test } from "bun:test";
import { createTestSession } from "@abdwhb-png/pi-test-harness";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { localMachineId } from "../../_shared/sandbox-runtime/machine-identity.ts";
import { currentShellPolicy } from "../../_shared/shell-runtime/index.ts";

const sandboxDir = resolve(import.meta.dir, "../../sandbox");

test.skipIf(
    process.platform !== "linux" ||
        process.env.PI_SANDBOX_REAL_SHELL_MODES_CONTRACT !== "1",
).each(["default", "custom"] as const)(
    "real /sandbox run uses the %s sandbox and preserves the explicitly selected host session",
    async (profile) => {
        const binaryPath = process.env.PI_SANDBOX_ZEROBOX_BINARY;
        const binarySha256 = process.env.PI_SANDBOX_ZEROBOX_SHA256;
        if (!binaryPath || !binarySha256) {
            throw new Error(
                "PI_SANDBOX_ZEROBOX_BINARY and PI_SANDBOX_ZEROBOX_SHA256 are required",
            );
        }
        const root = await mkdtemp("/var/tmp/pi-modes-");
        const leaseRoot = await mkdtemp("/var/tmp/z-");
        const cwd = join(root, "project");
        const agentDir = join(root, "agent");
        const previousCwd = process.cwd();
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        const expectedHostHome = process.env.HOME ?? homedir();
        const analysisRequests: string[] = [];
        const analysisRegistryKey = `pi.test.real-shell-modes.analysis:${root}`;
        const analysisRegistrySymbol = Symbol.for(analysisRegistryKey);
        // Jiti loads the fixture separately. Share only its observation array.
        Object.defineProperty(globalThis, analysisRegistrySymbol, {
            value: analysisRequests, configurable: true,
        });
        // Observe the public runner boundary before createTestSession, because
        // the harness logs startup errors before it returns the session handle.
        // spyOn calls the real method, preserving every error listener.
        const extensionErrors = spyOn(ExtensionRunner.prototype, "emitError");
        let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
        try {
            await mkdir(join(cwd, ".pi"), { recursive: true });
            await mkdir(agentDir, { mode: 0o700 });
            new ProjectTrustStore(agentDir).set(cwd, true);
            const marker = join(root, "host-marker");
            await writeFile(marker, "fixture-host\n");
            await writeFile(join(cwd, "private.txt"), "project-private\n");
            await writeFile(
                join(agentDir, "config", "sandbox.json"),
                JSON.stringify({
                    version: 2,
                    machineId: localMachineId(),
                    mode: "host",
                }),
                { mode: 0o600 },
            );
            await writeFile(
                join(cwd, ".pi/config/sandbox.json"),
                JSON.stringify(
                    profile === "custom"
                        ? { filesystem: { denyRead: ["private.txt"] } }
                        : {},
                ),
                { mode: 0o600 },
            );

            const sandboxSource = await realpath(resolve(sandboxDir, "index.ts"));
            const bashSource = await realpath(resolve(sandboxDir, "../bash-execution/index.ts"));
            expect(sandboxSource).toBe(resolve(sandboxDir, "index.ts"));
            expect(bashSource).toBe(resolve(sandboxDir, "../bash-execution/index.ts"));
            const entrypoint = join(agentDir, "sandbox-entrypoint.ts");
            const leaseCreated = join(root, "lease-created");
            const leaseRecovered = join(root, "lease-recovered");
            // Load the real extension through Jiti. Inject only backend identity
            // and test-owned lifecycle paths, never shell routing or provenance.
            // Analysis is outside this Bash contract. Its preflight runner does
            // no I/O and provides no evidence about actual Analysis execution.
            await writeFile(entrypoint, [
                `import { createSandboxExtension } from ${JSON.stringify(sandboxSource)};`,
                `import { createPrivateTempLease, recoverStalePrivateTempLeases } from ${JSON.stringify(resolve(sandboxDir, "runtime/private-temp.ts"))};`,
                'import { writeFile } from "node:fs/promises";',
                "export default (pi) => createSandboxExtension(pi, {",
                "analysisServiceOptions: { runHost: async (request) => {",
                "if (!['sandbox-preflight-typescript', 'sandbox-preflight-python'].includes(request.id)) throw new Error('Unexpected Analysis request in Bash contract');",
                `globalThis[Symbol.for(${JSON.stringify(analysisRegistryKey)})].push(request.id);`,
                "return { output: '1', stderr: '', runtime: request.worker, durationMs: 0, truncated: false };",
                "} },",
                `zeroboxBackend: ${JSON.stringify({
                    binaryPath,
                    expectedProvenance: { version: "0.3.3-fork.17", binarySha256 },
                    probeRoot: join(root, "probe"),
                })},`,
                "sandboxServiceOptions: {",
                `createLease: async () => { await writeFile(${JSON.stringify(leaseCreated)}, "created"); return createPrivateTempLease({ rootDir: ${JSON.stringify(leaseRoot)} }); },`,
                `recoverStaleLeases: async () => { await recoverStalePrivateTempLeases({ rootDir: ${JSON.stringify(leaseRoot)} }); await writeFile(${JSON.stringify(leaseRecovered)}, "recovered"); },`,
                "},",
                "});",
            ].join("\n"));

            process.env.PI_CODING_AGENT_DIR = agentDir;
            // Pi's interactive Bash executor uses process.cwd().
            process.chdir(cwd);
            session = await createTestSession({
                cwd,
                extensions: [entrypoint, bashSource],
            });
            expect(currentShellPolicy()).toMatchObject({
                mode: "sandbox", profile, state: "ready",
            });
            await session.session.prompt("/sandbox mode host");
            expect(currentShellPolicy()).toMatchObject({
                mode: "host", profile: "host", state: "ready",
            });

            const command = [
                'printf "%s\\n" "$HOME"',
                `if test -r ${JSON.stringify(marker)}; then cat ${JSON.stringify(marker)}; else printf 'hidden\\n'; fi`,
                "if test -r private.txt; then cat private.txt; else printf 'private-hidden\\n'; fi",
            ].join("; ");
            const activeSession = session;
            const runSandbox = async () => {
                await activeSession.session.prompt(`/sandbox run ${command}`);
                const entry = activeSession.session.sessionManager.getBranch().findLast(entry => entry.type === "custom_message" && entry.customType === "pi.sandbox-run.v1");
                const details = entry && "details" in entry ? entry.details : undefined;
                if (!details || typeof details !== "object" || !("output" in details) || typeof details.output !== "string" || !("execution" in details) || !details.execution || typeof details.execution !== "object" || !("exitCode" in details.execution) || typeof details.execution.exitCode !== "number") throw new Error("Missing Sandbox result receipt");
                return { output: details.output, exitCode: details.execution.exitCode, execution: details.execution };
            };
            const sandboxResult = await runSandbox();
            expect(sandboxResult.exitCode, sandboxResult.output).toBe(0);
            expect(sandboxResult.execution).toMatchObject({ status: "sandboxed", backend: "zerobox", mode: "sandbox", shellProfile: profile, exitCode: 0, outcome: "succeeded" });
            expect(sandboxResult.output).toBe(
                `/home/sandbox\nhidden\n${profile === "custom" ? "private-hidden" : "project-private"}\n`,
            );
            expect(currentShellPolicy()).toMatchObject({ mode: "host", profile: "host" });

            const ordinaryEvent = await session.session.extensionRunner.emitUserBash({
                type: "user_bash", command, cwd, excludeFromContext: false,
            });
            expect(ordinaryEvent?.operations).toBeDefined();
            const hostResult = await session.session.executeBash(command, undefined, {
                operations: ordinaryEvent?.operations,
            });
            expect(hostResult.exitCode, hostResult.output).toBe(0);
            expect(hostResult.output).toBe(`${expectedHostHome}\nfixture-host\nproject-private\n`);
            expect(currentShellPolicy()).toMatchObject({ mode: "host", profile: "host" });

            const receipts = session.session.sessionManager.getBranch().filter(
                (entry) => entry.type === "custom" && entry.customType === "pi.execution.user-bash.v1",
            );
            expect(receipts).toHaveLength(1);
            expect(receipts[0]).toMatchObject({ data: { execution: {
                status: "unsandboxed", backend: "local", mode: "host",
                shellProfile: "host", exitCode: 0, outcome: "succeeded",
            } } });
            await session.session.prompt("/sandbox mode sandbox");
            expect(currentShellPolicy()).toMatchObject({ mode: "sandbox", profile });
            const restored = await runSandbox();
            expect(restored.exitCode).toBe(0);
            expect(restored.output).toBe(sandboxResult.output);
            expect(await readFile(leaseCreated, "utf8")).toBe("created");
            expect(await readFile(leaseRecovered, "utf8")).toBe("recovered");
            const typescriptPreflights = analysisRequests.filter(
                (id) => id === "sandbox-preflight-typescript",
            ).length;
            const pythonPreflights = analysisRequests.filter(
                (id) => id === "sandbox-preflight-python",
            ).length;
            expect(typescriptPreflights).toBeGreaterThan(0);
            expect(pythonPreflights).toBe(typescriptPreflights);
            expect(analysisRequests).toHaveLength(typescriptPreflights + pythonPreflights);
        } finally {
            try {
                await session?.session.extensionRunner.emit({
                    type: "session_shutdown", reason: "quit",
                });
            } finally {
                session?.dispose();
                Reflect.deleteProperty(globalThis, analysisRegistrySymbol);
                process.chdir(previousCwd);
                if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
                else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
                await rm(root, { recursive: true, force: true });
                await rm(leaseRoot, { recursive: true, force: true });
                const errors = extensionErrors.mock.calls.map(([error]) => error);
                extensionErrors.mockRestore();
                expect(errors).toEqual([]);
            }
        }
    },
    60_000,
);
