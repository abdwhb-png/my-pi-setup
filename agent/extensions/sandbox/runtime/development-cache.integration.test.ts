import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createBashOperations } from "../../_shared/command-execution/exec.ts";
import {
    candidateBackendOptions,
    hasCandidateRuntime,
} from "./integration-fixtures.ts";
import { validatePiSandboxConfig } from "./policies.ts";
import { createPrivateTempLease } from "./private-temp.ts";
import { createSandboxService } from "./service.ts";
import { PRIVATE_BASH } from "./shell-baseline.ts";
import { createZeroboxBackend } from "./zerobox-backend.ts";

test.skipIf(
    process.env.PI_SANDBOX_INSTALLATIONS_CONTRACT !== "1" ||
        !hasCandidateRuntime(),
)(
    "configured caches persist across sessions while host installations remain read-only",
    async () => {
        const root = await mkdtemp("/var/tmp/pi-dev-cache-");
        const leases = await mkdtemp("/var/tmp/z-");
        const project = join(root, "project"),
            cache = join(root, "cache"),
            tools = join(root, "tools");
        try {
            await Promise.all([mkdir(project), mkdir(cache), mkdir(tools)]);
            await writeFile(join(tools, "resource"), "host");
            for (const round of [0, 1]) {
                const service = createSandboxService({
                    backend: createZeroboxBackend(
                        candidateBackendOptions(join(root, "probe")),
                    ),
                    config: validatePiSandboxConfig({
                        filesystem: {
                            allowRead: [project, tools],
                            allowWrite: [project, cache],
                        },
                        environment: { variables: { XDG_CACHE_HOME: cache } },
                    }),
                    createLease: () =>
                        createPrivateTempLease({ rootDir: leases }),
                });
                try {
                    await service.startBashSession(project);
                    const operations = createBashOperations({
                        detached: true,
                        prepareSpawn: ({ command, cwd }) =>
                            service.prepareBash({
                                file: PRIVATE_BASH,
                                args: ["-c", command],
                                cwd,
                            }),
                    });
                    let output = "";
                    const command =
                        round === 0
                            ? 'printf persistent > "$XDG_CACHE_HOME/marker"'
                            : `test "$(cat "$XDG_CACHE_HOME/marker")" = persistent && test "$HOME" = /home/sandbox && ! printf forbidden > '${tools}/resource'`;
                    const result = await operations.exec(command, project, {
                        timeout: 30,
                        onData: (chunk) => {
                            output += chunk.toString();
                        },
                    });
                    expect(result.exitCode, output).toBe(0);
                } finally {
                    await service.shutdown();
                }
            }
            expect(await readFile(join(tools, "resource"), "utf8")).toBe(
                "host",
            );
        } finally {
            await rm(root, { recursive: true, force: true });
            await rm(leases, { recursive: true, force: true });
        }
    },
    120000,
);
