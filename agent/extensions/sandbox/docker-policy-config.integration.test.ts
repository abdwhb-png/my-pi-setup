import { expect, test } from "bun:test";
import { calls, createTestSession, says, when } from "@abdwhb-png/pi-test-harness";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createBashProcessSupervisor } from "../_shared/command-execution/exec.ts";
import { createSandboxedBashOps, loadSandboxConfig } from "./index.ts";
import { localMachineId } from "./capabilities/authority.ts";
import { createSandboxService } from "./runtime/service.ts";
import {
    createPrivateTempLease,
    recoverStalePrivateTempLeases,
} from "./runtime/private-temp.ts";
import { createZeroboxBackend } from "./runtime/zerobox-backend.ts";

const CANDIDATE_BINARY_ENV = "PI_SANDBOX_ZEROBOX_BINARY";
const CANDIDATE_SHA256_ENV = "PI_SANDBOX_ZEROBOX_SHA256";

test.skipIf(
    !process.env[CANDIDATE_BINARY_ENV] || !process.env[CANDIDATE_SHA256_ENV],
)("real policy loading gates Docker broker admission by both global and project files", async () => {
    const root = await mkdtemp(join(import.meta.dir, ".docker-policy-config-"));
    const leaseRoot = await mkdtemp("/tmp/pi-zbx-");
    const socketRoot = await mkdtemp("/tmp/pi-docker-");
    const dockerClient = await realpath("/usr/bin/docker");
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const socket = join(socketRoot, "engine.sock");
    const requests: string[] = [];
    const container = {
        Id: "a".repeat(64),
        Names: ["/fixture"],
        Image: "fixture",
        Command: "fixture",
        Created: 1,
        State: "running",
        Status: "Up",
        Ports: [],
        Labels: {},
        Mounts: [],
    };
    const dockerCommand = `docker inspect ${container.Id} --format '{{.Name}}'`;
    const server = createServer((request, response) => {
        const path = (request.url ?? "").replace(/^\/v[\d.]+/, "").split("?")[0];
        requests.push(`${request.method} ${path}`);
        if (path === "/_ping") {
            response.setHeader("API-Version", "1.52");
            response.end("OK");
            return;
        }
        response.setHeader("Content-Type", "application/json");
        if (path === "/version") {
            response.end(JSON.stringify({ ApiVersion: "1.52", MinAPIVersion: "1.24" }));
            return;
        }
        if (path === "/containers/json") {
            response.end(JSON.stringify([container]));
            return;
        }
        if (path === "/containers/fixture/json" || path === `/containers/${container.Id}/json`) {
            response.end(JSON.stringify({
                Id: container.Id,
                Name: "/fixture",
                Config: { Labels: {} },
                State: { Running: true },
                HostConfig: {},
                Mounts: [],
            }));
            return;
        }
        response.statusCode = 404;
        response.end("{}");
    });
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    const globalPath = join(agentDir, "sandbox.json");
    const projectPath = join(cwd, ".pi", "sandbox.json");
    const global = (allowed: boolean) => ({
        version: 2,
        machineId: localMachineId(),
        filesystem: { allowRead: [".", dockerClient] },
        docker: {
            allowed,
            mode: "targeted",
            endpoint: `unix://${socket}`,
            operations: ["inspect"],
        },
    });
    const project = (enabled: boolean) => ({
        docker: {
            enabled,
            targets: [{
                selector: { type: "container-name", name: "fixture" },
                operations: ["inspect"],
            }],
        },
    });
    const run = async () => {
        const resolved = loadSandboxConfig(cwd, {
            agentDir,
            machineId: localMachineId(),
        });
        const backend = createZeroboxBackend({
            binaryPath: process.env[CANDIDATE_BINARY_ENV]!,
            expectedProvenance: {
                version: "0.3.3-fork.17",
                binarySha256: process.env[CANDIDATE_SHA256_ENV]!,
            },
            probeRoot: resolve(import.meta.dir, "../.."),
        });
        await backend.probe();
        const service = createSandboxService({
            backend,
            config: resolved.config,
            createLease: () =>
                createPrivateTempLease({ rootDir: leaseRoot }),
            recoverStaleLeases: async () => {
                await recoverStalePrivateTempLeases({ rootDir: leaseRoot });
            },
        });
        const supervisor = createBashProcessSupervisor();
        let output = "";
        try {
            await service.startBashSession(cwd);
            const requestsBeforeCommand = requests.length;
            const result = await createSandboxedBashOps(service, supervisor).exec(
                dockerCommand,
                cwd,
                { timeout: 10, onData: (chunk) => { output += chunk.toString(); } },
            );
            return {
                result,
                output,
                docker: resolved.config.docker,
                requestsBeforeCommand,
                requestsAfterCommand: requests.length,
            };
        } finally {
            supervisor.shutdown();
            await service.shutdown();
        }
    };

    try {
        await writeFile(globalPath, JSON.stringify(global(false)), { mode: 0o600 });
        await writeFile(projectPath, JSON.stringify(project(true)), { mode: 0o600 });
        const globallyBlocked = await run();
        expect(globallyBlocked.docker).toEqual({ mode: "disabled" });
        expect(globallyBlocked.result.exitCode).not.toBe(0);
        expect(requests).toEqual([]);

        await writeFile(globalPath, JSON.stringify(global(true)), { mode: 0o600 });
        await rm(projectPath);
        const projectAbsent = await run();
        expect(projectAbsent.docker).toEqual({ mode: "disabled" });
        expect(projectAbsent.result.exitCode).not.toBe(0);
        expect(requests).toEqual([]);

        await writeFile(projectPath, JSON.stringify(project(true)), { mode: 0o600 });
        const admitted = await run();
        expect(admitted.docker.mode).toBe("targeted");
        expect(admitted.result.exitCode, admitted.output).toBe(0);
        expect(admitted.requestsAfterCommand).toBeGreaterThan(
            admitted.requestsBeforeCommand,
        );
        expect(requests).toContain("GET /containers/json");
        const requestsAfterAdmission = requests.length;

        await writeFile(globalPath, JSON.stringify(global(false)), { mode: 0o600 });
        const globallyRevoked = await run();
        expect(globallyRevoked.docker).toEqual({ mode: "disabled" });
        expect(globallyRevoked.result.exitCode).not.toBe(0);
        expect(requests).toHaveLength(requestsAfterAdmission);

        await writeFile(globalPath, JSON.stringify(global(true)), { mode: 0o600 });
        await writeFile(projectPath, JSON.stringify(project(false)), { mode: 0o600 });
        const projectRevoked = await run();
        expect(projectRevoked.docker).toEqual({ mode: "disabled" });
        expect(projectRevoked.result.exitCode).not.toBe(0);
        expect(requests).toHaveLength(requestsAfterAdmission);

        await writeFile(globalPath, JSON.stringify(global(false)), { mode: 0o600 });
        await writeFile(projectPath, JSON.stringify(project(true)), { mode: 0o600 });
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const sandboxEntrypoint = join(agentDir, "sandbox-entrypoint.ts");
        const leaseCreatedPath = join(root, "lease-created");
        const leaseRecoveredPath = join(root, "lease-recovered");
        await writeFile(
            sandboxEntrypoint,
            [
                `import { createSandboxExtension } from ${JSON.stringify(resolve(import.meta.dir, "index.ts"))};`,
                `import { createPrivateTempLease, recoverStalePrivateTempLeases } from ${JSON.stringify(resolve(import.meta.dir, "runtime/private-temp.ts"))};`,
                `import { writeFile } from "node:fs/promises";`,
                "export default (pi) => createSandboxExtension(pi, {",
                "  analysisServiceOptions: { runHost: async (request) => {",
                "    if (!['sandbox-preflight-typescript', 'sandbox-preflight-python'].includes(request.id)) throw new Error('Unexpected Analysis request in Docker contract');",
                "    return { output: '1', stderr: '', runtime: request.worker, durationMs: 0, truncated: false };",
                "  } },",
                `  zeroboxBackend: { binaryPath: ${JSON.stringify(process.env[CANDIDATE_BINARY_ENV])}, expectedProvenance: { version: "0.3.3-fork.17", binarySha256: ${JSON.stringify(process.env[CANDIDATE_SHA256_ENV])} }, probeRoot: ${JSON.stringify(root)} },`,
                `  sandboxServiceOptions: { createLease: async () => { await writeFile(${JSON.stringify(leaseCreatedPath)}, "created"); return createPrivateTempLease({ rootDir: ${JSON.stringify(leaseRoot)} }); }, recoverStaleLeases: async () => { await recoverStalePrivateTempLeases({ rootDir: ${JSON.stringify(leaseRoot)} }); await writeFile(${JSON.stringify(leaseRecoveredPath)}, "recovered"); } },`,
                "});",
            ].join("\n"),
        );
        let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
        try {
            session = await createTestSession({
                cwd,
                propagateErrors: false,
                extensions: [
                    sandboxEntrypoint,
                    resolve(import.meta.dir, "../bash-execution/index.ts"),
                ],
            });
            const runPiDocker = async (label: string) => {
                const requestsBefore = requests.length;
                await session!.run(
                    when(label, [
                        calls("safe_bash", { command: dockerCommand }),
                        says(label),
                    ]),
                );
                return {
                    requestsBefore,
                    result: session!.events.toolResultsFor("safe_bash").at(-1),
                };
            };

            const globallyBlockedPi = await runPiDocker("Global Docker is disabled");
            expect(await readFile(leaseCreatedPath, "utf8")).toBe("created");
            expect(await readFile(leaseRecoveredPath, "utf8")).toBe("recovered");
            expect(globallyBlockedPi.result?.isError).toBe(true);
            expect(globallyBlockedPi.result?.text).not.toContain("fixture");
            expect(requests).toHaveLength(globallyBlockedPi.requestsBefore);

            await writeFile(globalPath, JSON.stringify(global(true)), { mode: 0o600 });
            await rm(projectPath);
            const absentProjectPi = await runPiDocker("Project Docker is absent");
            expect(absentProjectPi.result?.isError).toBe(true);
            expect(absentProjectPi.result?.text).not.toContain("fixture");
            expect(requests).toHaveLength(absentProjectPi.requestsBefore);

            await writeFile(projectPath, JSON.stringify(project(true)), { mode: 0o600 });
            const admittedPi = await runPiDocker("Project Docker is activated");
            expect(admittedPi.result?.isError).toBe(false);
            expect(admittedPi.result?.text).toContain("fixture");
            expect(requests.length).toBeGreaterThan(admittedPi.requestsBefore);

            await writeFile(globalPath, JSON.stringify(global(false)), { mode: 0o600 });
            const globallyRevokedPi = await runPiDocker("Global Docker is revoked");
            expect(globallyRevokedPi.result?.isError).toBe(true);
            expect(globallyRevokedPi.result?.text).not.toContain("fixture");
            expect(requests).toHaveLength(globallyRevokedPi.requestsBefore);

            await writeFile(globalPath, JSON.stringify(global(true)), { mode: 0o600 });
            await writeFile(projectPath, JSON.stringify(project(true)), { mode: 0o600 });
            const readmittedPi = await runPiDocker("Project Docker is reactivated");
            expect(readmittedPi.result?.isError).toBe(false);
            expect(readmittedPi.result?.text).toContain("fixture");
            expect(requests.length).toBeGreaterThan(readmittedPi.requestsBefore);

            await writeFile(projectPath, JSON.stringify(project(false)), { mode: 0o600 });
            const projectRevokedPi = await runPiDocker("Project Docker is revoked");
            expect(projectRevokedPi.result?.isError).toBe(true);
            expect(projectRevokedPi.result?.text).not.toContain("fixture");
            expect(requests).toHaveLength(projectRevokedPi.requestsBefore);
        } finally {
            await session?.session.extensionRunner?.emit({
                type: "session_shutdown",
                reason: "quit",
            });
            session?.dispose();
            if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        }
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
        await rm(leaseRoot, { recursive: true, force: true });
        await rm(socketRoot, { recursive: true, force: true });
    }
}, 60_000);
