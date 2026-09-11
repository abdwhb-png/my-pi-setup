import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createBashOperations } from "../../_shared/command-execution/exec.ts";
import { localMachineId } from "../capabilities/authority.ts";
import { loadSandboxConfig } from "../index.ts";
import {
    createPrivateTempLease,
    recoverStalePrivateTempLeases,
} from "./private-temp.ts";
import { createSandboxService } from "./service.ts";
import { createZeroboxBackend } from "./zerobox-backend.ts";

// Both projects and both external tool installations contain identical scripts.
// Only sandbox.json selects the tool directory, cache, and inaccessible neighbour.
const CHECK_SCRIPT = `#!/bin/bash
set -eu
generic-check-tool
if cat "$NEIGHBOUR_PROJECT/witness" >/dev/null 2>&1; then exit 41; fi
if (printf forbidden > "$NEIGHBOUR_PROJECT/intrusion") 2>/dev/null; then exit 42; fi
if cat "$NEIGHBOUR_CACHE/seed" >/dev/null 2>&1; then exit 43; fi
if (printf forbidden > "$NEIGHBOUR_CACHE/intrusion") 2>/dev/null; then exit 44; fi
printf 'neighbour-blocked\n'
`;

const TOOL_SCRIPT = `#!/bin/bash
set -eu
seed=$(cat "$CHECK_CACHE/seed")
printf '%s' "$seed" > "$CHECK_CACHE/result"
test "$(cat "$CHECK_CACHE/result")" = "$seed"
printf 'cache:%s\n' "$seed"
`;

test.skipIf(
    process.platform !== "linux" ||
        process.env.PI_SANDBOX_GENERIC_COMMAND_CONTRACT !== "1",
)(
    "runs unchanged ./bin/check in two projects using only v2 tool and cache configuration",
    async () => {
        const binaryPath = process.env.PI_SANDBOX_ZEROBOX_BINARY;
        const binarySha256 = process.env.PI_SANDBOX_ZEROBOX_SHA256;
        if (!binaryPath || !binarySha256) {
            throw new Error(
                "PI_SANDBOX_ZEROBOX_BINARY and PI_SANDBOX_ZEROBOX_SHA256 are required",
            );
        }
        const root = await mkdtemp("/var/tmp/pi-generic-");
        // Keep proxy sockets below their byte limit and all lease GC test-owned.
        const leaseRoot = await mkdtemp("/var/tmp/z-");
        try {
            const machineId = localMachineId();
            const projects = ["alpha", "beta"].map((name) => ({
                name,
                cwd: join(root, name),
                agentDir: join(root, `${name}-agent`),
                tools: join(root, `${name}-tools`),
                cache: join(root, `${name}-cache`),
            }));

            for (const project of projects) {
                for (const directory of [
                    join(project.cwd, "bin"),
                    join(project.cwd, ".pi"),
                    project.agentDir,
                    project.tools,
                    project.cache,
                ]) {
                    await mkdir(directory, { recursive: true, mode: 0o700 });
                }
                await writeFile(join(project.cwd, "bin/check"), CHECK_SCRIPT, {
                    mode: 0o700,
                });
                await writeFile(
                    join(project.tools, "generic-check-tool"),
                    TOOL_SCRIPT,
                    { mode: 0o700 },
                );
                await writeFile(join(project.cwd, "witness"), project.name);
                await writeFile(join(project.cache, "seed"), project.name);
            }

            for (const project of projects) {
                const neighbour = projects.find((other) => other !== project)!;
                const environment = {
                    path: [project.tools],
                    variables: {
                        CHECK_CACHE: project.cache,
                        NEIGHBOUR_PROJECT: neighbour.cwd,
                        NEIGHBOUR_CACHE: neighbour.cache,
                    },
                };
                const filesystem = {
                    allowRead: [project.cwd, project.tools, project.cache],
                    allowWrite: [project.cwd, project.cache],
                };
                await writeFile(
                    join(project.agentDir, "sandbox.json"),
                    JSON.stringify({
                        version: 2,
                        machineId,
                        filesystem: {
                            allowRead: projects.flatMap((other) => [
                                other.cwd,
                                other.tools,
                                other.cache,
                            ]),
                            allowWrite: projects.flatMap((other) => [
                                other.cwd,
                                other.cache,
                            ]),
                        },
                        environment: {
                            ...environment,
                            path: projects.map((other) => other.tools),
                        },
                    }),
                    { mode: 0o600 },
                );
                await writeFile(
                    join(project.cwd, ".pi/sandbox.json"),
                    JSON.stringify({ filesystem, environment }),
                    { mode: 0o600 },
                );

                const loaded = loadSandboxConfig(project.cwd, {
                    agentDir: project.agentDir,
                    machineId,
                });
                expect(loaded.source).toBe("project-config");
                const service = createSandboxService({
                    backend: createZeroboxBackend({
                        binaryPath,
                        expectedProvenance: {
                            version: "0.3.3-fork.17",
                            binarySha256,
                        },
                        probeRoot: join(root, `${project.name}-probe`),
                    }),
                    config: loaded.config,
                    createLease: () =>
                        createPrivateTempLease({ rootDir: leaseRoot }),
                    recoverStaleLeases: async () => {
                        await recoverStalePrivateTempLeases({
                            rootDir: leaseRoot,
                        });
                    },
                });
                try {
                    await service.startBashSession(project.cwd);
                    const commands: string[] = [];
                    const operations = createBashOperations({
                        detached: true,
                        prepareSpawn: ({ command, cwd }) => {
                            commands.push(command);
                            return service.prepareBash({
                                file: "/bin/bash",
                                args: ["-c", command],
                                cwd,
                            });
                        },
                    });
                    let output = "";
                    const result = await operations.exec("./bin/check", project.cwd, {
                        timeout: 10,
                        onData: (chunk) => {
                            output += chunk.toString();
                        },
                    });
                    expect(commands).toEqual(["./bin/check"]);
                    expect(result.exitCode, `${project.name}: ${output}`).toBe(0);
                    expect(output).toBe(`cache:${project.name}\nneighbour-blocked\n`);
                    expect(await readFile(join(project.cache, "result"), "utf8")).toBe(
                        project.name,
                    );
                    expect(await readFile(join(neighbour.cwd, "witness"), "utf8")).toBe(
                        neighbour.name,
                    );
                    for (const directory of [neighbour.cwd, neighbour.cache]) {
                        await expect(readFile(join(directory, "intrusion"))).rejects.toMatchObject({
                            code: "ENOENT",
                        });
                    }
                } finally {
                    await service.shutdown();
                }
            }
        } finally {
            await rm(root, { recursive: true, force: true });
            await rm(leaseRoot, { recursive: true, force: true });
        }
    },
    60_000,
);
