import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createBashProcessSupervisor } from "../../_shared/command-execution/exec.ts";
import { createSandboxedBashOps, loadSandboxConfig } from "../index.ts";
import { localMachineId } from "../capabilities/authority.ts";
import { candidateBackendOptions, hasCandidateRuntime } from "./integration-fixtures.ts";
import { createPrivateTempLease, recoverStalePrivateTempLeases } from "./private-temp.ts";
import { createSandboxService } from "./service.ts";
import { createZeroboxBackend } from "./zerobox-backend.ts";

test.skipIf(!hasCandidateRuntime())(
    "a read-only cwd with write denials starts without a FUSE view",
    async () => {
        const root = await mkdtemp("/var/tmp/pi-read-only-cwd-");
        const leaseRoot = await mkdtemp("/var/tmp/z-");
        const agentDir = join(root, "agent");
        const cwd = join(root, "project");
        const external = join(root, "external");
        const supervisor = createBashProcessSupervisor();
        let service: ReturnType<typeof createSandboxService> | undefined;
        try {
            await mkdir(join(cwd, ".pi"), { recursive: true });
            await mkdir(agentDir, { recursive: true });
            await mkdir(external, { recursive: true });
            await writeFile(join(cwd, "visible.txt"), "visible");
            await writeFile(
                join(agentDir, "sandbox.json"),
                JSON.stringify({
                    version: 2,
                    machineId: localMachineId(),
                    filesystem: {
                        allowRead: [cwd],
                        allowWrite: [external],
                        denyWrite: [".env.*", "node_modules/*"],
                    },
                }),
                { mode: 0o600 },
            );
            await writeFile(
                join(cwd, ".pi/sandbox.json"),
                JSON.stringify({ filesystem: { allowWrite: [external] } }),
                { mode: 0o600 },
            );

            const config = loadSandboxConfig(cwd, {
                agentDir,
                machineId: localMachineId(),
            }).config;
            expect(config.filesystem.allowRead).toContain(cwd);
            expect(config.filesystem.allowWrite).toEqual([external]);

            service = createSandboxService({
                backend: createZeroboxBackend(candidateBackendOptions(leaseRoot)),
                config,
                createLease: () => createPrivateTempLease({ rootDir: leaseRoot }),
                recoverStaleLeases: async () => {
                    await recoverStalePrivateTempLeases({ rootDir: leaseRoot });
                },
            });
            await service.startBashSession(cwd);
            let output = "";
            const result = await createSandboxedBashOps(service, supervisor).exec(
                "test \"$(cat visible.txt)\" = visible && ! printf blocked > created.txt 2>/dev/null",
                cwd,
                {
                    timeout: 10,
                    onData: (chunk) => {
                        output += chunk.toString();
                    },
                },
            );

            expect(result.exitCode, output).toBe(0);
            await expect(readFile(join(cwd, "created.txt"), "utf8")).rejects.toMatchObject({
                code: "ENOENT",
            });
        } finally {
            supervisor.shutdown();
            await service?.shutdown();
            await rm(root, { recursive: true, force: true });
            await rm(leaseRoot, { recursive: true, force: true });
        }
    },
    30_000,
);
