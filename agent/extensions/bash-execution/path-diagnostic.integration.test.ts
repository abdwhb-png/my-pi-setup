import { expect, test } from "bun:test";
import { calls, createTestSession, says, when } from "@abdwhb-png/pi-test-harness";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import bashExecution from "./index.ts";
import { createBashProcessSupervisor } from "../_shared/command-execution/exec.ts";
import { claimSandboxRuntime, publishSandboxRuntime, releaseSandboxRuntime } from "../_shared/sandbox-runtime/index.ts";
import { createSandboxedBashOps, loadSandboxConfig } from "../sandbox/index.ts";
import { publishShellRuntime, releaseShellRuntime } from "../sandbox/capabilities/runtime.ts";
import { createSandboxService } from "../sandbox/runtime/service.ts";
import { createZeroboxBackend } from "../sandbox/runtime/zerobox-backend.ts";
import { createPrivateTempLease, recoverStalePrivateTempLeases } from "../sandbox/runtime/private-temp.ts";
import { candidateBackendOptions, hasCandidateRuntime } from "../sandbox/runtime/integration-fixtures.ts";

test.skipIf(!hasCandidateRuntime())("real Pi shell tools and !s diagnose an unexposed sibling using their own admission", async () => {
    const root = await mkdtemp("/var/tmp/pi-path-diagnostic-");
    const leaseRoot = await mkdtemp("/var/tmp/z-");
    const cwd = join(root, "project");
    const sibling = join(root, "sibling");
    const owner = Symbol("path-diagnostic-integration");
    const supervisor = createBashProcessSupervisor();
    const previousCwd = process.cwd();
    let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
    let service: ReturnType<typeof createSandboxService> | undefined;
    try {
        await mkdir(join(cwd, ".pi"), { recursive: true });
        await mkdir(sibling);
        process.chdir(cwd);
        await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({ safeBash: { mode: "coexist", telemetry: { enabled: false } } }));
        await writeFile(join(root, "sandbox.json"), JSON.stringify({ version: 2, machineId: "test" }));
        const loaded = loadSandboxConfig(cwd, { agentDir: root, machineId: "test" });
        const sandbox = createSandboxService({
            backend: createZeroboxBackend(candidateBackendOptions(join(root, "probe"))),
            config: loaded.config,
            createLease: () => createPrivateTempLease({ rootDir: leaseRoot }),
            recoverStaleLeases: async () => { await recoverStalePrivateTempLeases({ rootDir: leaseRoot }); },
        });
        service = sandbox;
        await sandbox.startBashSession(cwd);
        claimSandboxRuntime(owner);
        publishSandboxRuntime(owner, {
            state: "enabled", sandboxFingerprint: loaded.shell.sandboxFingerprint,
            createBashOperations: (options) => createSandboxedBashOps(sandbox, supervisor, options),
            createThinkBashOperations: (options) => createSandboxedBashOps(sandbox, supervisor, options, "think-strict"),
            analysis: { state: "retrying" },
        });
        publishShellRuntime(owner, () => loaded.shell);
        session = await createTestSession({ cwd, extensionFactories: [bashExecution] });
        await session.run(when("Inspect the sibling", [calls("bash", { command: `cd ${sibling}` }), calls("safe_bash", { command: `cd ${sibling}` }), says("done")]));
        for (const tool of ["bash", "safe_bash"]) {
            const result = session.events.toolResultsFor(tool).at(-1)!;
            expect(result.mocked).toBe(false);
            expect(result.isError).toBe(true);
            expect(result.text).toContain(`cd: ${sibling}: No such file or directory`);
            expect(result.text).toContain(`Sandbox: ${sibling} is outside the admitted read scope.`);
            expect(result.details).toMatchObject({ execution: { status: "sandboxed", exitCode: 1 }, sandboxExecutionContext: { version: 3, admission: "admitted" } });
        }
        const command = `s cd ${sibling}`;
        const event = await session.session.extensionRunner.emitUserBash({ type: "user_bash", command, cwd, excludeFromContext: false });
        const result = await session.session.executeBash(command, undefined, { operations: event?.operations });
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain(`Sandbox: ${sibling} is outside the admitted read scope.`);
        const missing = join(cwd, "missing");
        let output = "";
        const missingResult = await createSandboxedBashOps(sandbox, supervisor).exec(`cd ${missing}`, cwd, { onData: (chunk) => { output += chunk.toString(); } });
        expect(missingResult.exitCode).toBe(1);
        expect(output).toContain("No such file or directory");
        expect(output).not.toContain("Sandbox:");
    } finally {
        session?.dispose();
        supervisor.shutdown();
        releaseSandboxRuntime(owner);
        releaseShellRuntime(owner);
        await service?.shutdown();
        process.chdir(previousCwd);
        await rm(root, { recursive: true, force: true });
        await rm(leaseRoot, { recursive: true, force: true });
    }
}, 60_000);
