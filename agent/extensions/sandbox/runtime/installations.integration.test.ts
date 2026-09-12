import { expect, test } from "bun:test";
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import type { BashOperations } from "@earendil-works/pi-coding-agent";

import { createBashOperations } from "../../_shared/command-execution/exec.ts";
import { localMachineId } from "../capabilities/authority.ts";
import { loadSandboxConfig } from "../index.ts";
import {
    candidateBackendOptions,
    hasCandidateRuntime,
} from "./integration-fixtures.ts";
import {
    createPrivateTempLease,
    recoverStalePrivateTempLeases,
} from "./private-temp.ts";
import { createSandboxService } from "./service.ts";
import { PRIVATE_BASH } from "./shell-baseline.ts";
import { createZeroboxBackend } from "./zerobox-backend.ts";

function execute(
    operations: BashOperations,
    command: string,
    cwd: string,
): Promise<{ exitCode: number | null; output: string }> {
    let output = "";
    return operations
        .exec(command, cwd, {
            timeout: 10,
            onData(chunk) {
                output += chunk.toString();
            },
        })
        .then((result) => ({ exitCode: result.exitCode, output }));
}

test.skipIf(
    process.platform !== "linux" ||
        process.env.PI_SANDBOX_INSTALLATIONS_CONTRACT !== "1" ||
        !hasCandidateRuntime(),
).each(["external","project"] as const)(
    "admits one inherited %s installation without duplicate filesystem or PATH configuration",
    async (location) => {
        const root = await mkdtemp("/var/tmp/pi-installation-contract-");
        const leaseRoot = await mkdtemp("/var/tmp/z-");
        const project = join(root, "project");
        const agentDir = join(root, "agent");
        const tools = join(location==="project"?project:root, "local-tools");
        const outside = join(root, "outside");
        const resource = join(tools, "resource.txt");
        const outsideHelper = join(outside, "helper");
        const machineId = localMachineId();
        let service: ReturnType<typeof createSandboxService> | undefined;
        try {
            await Promise.all([
                mkdir(project, { recursive: true, mode: 0o700 }),
                mkdir(agentDir, { recursive: true, mode: 0o700 }),
                mkdir(join(tools, "bin"), { recursive: true, mode: 0o700 }),
                mkdir(outside, { recursive: true, mode: 0o700 }),
            ]);
            await writeFile(resource, "v1", { mode: 0o600 });
            await writeFile(
                join(tools, "bin", "local-tool"),
                `#!${PRIVATE_BASH}
set -eu
root="\${BASH_SOURCE[0]%/bin/local-tool}"
value=$(cat "$root/resource.txt")
if { printf forbidden > "$root/resource.txt"; } 2>/dev/null; then exit 45; fi
printf 'tool:%s' "$value"
`,
                { mode: 0o700 },
            );
            await writeFile(
                join(tools, "bin", "needs-outsider"),
                `#!${PRIVATE_BASH}
set -eu
exec ${JSON.stringify(outsideHelper)}
`,
                { mode: 0o700 },
            );
            await writeFile(outsideHelper, `#!${PRIVATE_BASH}\nprintf outsider\n`, {
                mode: 0o700,
            });
            await symlink(outsideHelper, join(tools, "bin", "escape"));
            await writeFile(
                join(agentDir, "sandbox.json"),
                `${JSON.stringify({
                    version: 2,
                    machineId,
                    docker: { allowed: false },
                    environment: {
                        installations: {
                            local: [{ root: tools, path: ["bin"] }],
                        },
                    },
                })}\n`,
                { mode: 0o600 },
            );

            const resolved = loadSandboxConfig(project, { agentDir, machineId });
            expect(resolved.config.filesystem.allowRead).toContain(tools);
            expect(resolved.config.environment.path).toContain(join(tools, "bin"));
            expect(resolved.config.environment.installations).toEqual([
                { name: "local", roots: [{ root: tools, path: ["bin"] }] },
            ]);
            const global = JSON.parse(
                await readFile(join(agentDir, "sandbox.json"), "utf8"),
            ) as Record<string, unknown>;
            expect(global).not.toHaveProperty("filesystem");
            expect(global).not.toHaveProperty("environment.path");
            expect(await Bun.file(join(project, ".pi", "sandbox.json")).exists()).toBe(
                false,
            );

            service = createSandboxService({
                backend: createZeroboxBackend(
                    candidateBackendOptions(join(root, "probe")),
                ),
                config: resolved.config,
                createLease: () => createPrivateTempLease({ rootDir: leaseRoot }),
                recoverStaleLeases: async () => {
                    await recoverStalePrivateTempLeases({ rootDir: leaseRoot });
                },
            });
            await service.startBashSession(project);
            const operations = createBashOperations({
                detached: true,
                prepareSpawn: ({ command, cwd }) =>
                    service!.prepareBash({
                        file: PRIVATE_BASH,
                        args: ["-c", command],
                        cwd,
                    }),
            });

            expect(await execute(operations, "local-tool", project)).toEqual({
                exitCode: 0,
                output: "tool:v1",
            });
            expect(await readFile(resource, "utf8")).toBe("v1");

            // An update within the authorized root is visible at the next
            // command admission without changing either authority file.
            await writeFile(resource, "v2", { mode: 0o600 });
            expect(await execute(operations, "local-tool", project)).toEqual({
                exitCode: 0,
                output: "tool:v2",
            });

            // Both paths originate under the authorized root, but their
            // targets are outside it and must stay inaccessible.
            for (const command of [
                `${JSON.stringify(join(tools, "bin", "escape"))}`,
                "needs-outsider",
            ]) {
                expect((await execute(operations, command, project)).exitCode, command).not.toBe(
                    0,
                );
            }
            expect(await readFile(resource, "utf8")).toBe("v2");
            expect(await readFile(outsideHelper, "utf8")).toContain("outsider");
        } finally {
            await service?.shutdown();
            await rm(root, { recursive: true, force: true });
            await rm(leaseRoot, { recursive: true, force: true });
        }
    },
    60_000,
);
