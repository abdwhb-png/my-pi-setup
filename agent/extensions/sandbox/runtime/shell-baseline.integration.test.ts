import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BashOperations } from "@earendil-works/pi-coding-agent";

import { createBashOperations } from "../../_shared/command-execution/exec.ts";
import { validatePiSandboxConfig } from "./policies.ts";
import {
    createPrivateTempLease,
    recoverStalePrivateTempLeases,
} from "./private-temp.ts";
import { createSandboxService, type SandboxService } from "./service.ts";
import { createZeroboxBackend } from "./zerobox-backend.ts";

const CANDIDATE_BINARY_ENV = "PI_SANDBOX_ZEROBOX_BINARY";
const CANDIDATE_SHA256_ENV = "PI_SANDBOX_ZEROBOX_SHA256";
const CANDIDATE_VERSION = "0.3.3-fork.17";

function createContractBackend(probeRoot: string) {
    const binaryPath = process.env[CANDIDATE_BINARY_ENV];
    const binarySha256 = process.env[CANDIDATE_SHA256_ENV];
    if (!binaryPath || !binarySha256) {
        throw new Error(
            `${CANDIDATE_BINARY_ENV} and ${CANDIDATE_SHA256_ENV} are required for the shell baseline contract`,
        );
    }
    return createZeroboxBackend({
        binaryPath,
        expectedProvenance: {
            version: CANDIDATE_VERSION,
            binarySha256,
        },
        probeRoot,
    });
}

function shellOperations(service: SandboxService): BashOperations {
    return createBashOperations({
        detached: true,
        prepareSpawn: ({ command, cwd }) =>
            service.prepareBash({
                file: "/bin/bash",
                args: ["-c", command],
                cwd,
            }),
    });
}

async function execute(
    operations: BashOperations,
    command: string,
    cwd: string,
): Promise<{ exitCode: number | null; output: string }> {
    let output = "";
    const result = await operations.exec(command, cwd, {
        timeout: 10,
        onData(chunk) {
            output += chunk.toString();
        },
    });
    return { exitCode: result.exitCode, output };
}

// This invokes an explicitly identified candidate binary and remains opt-in.
test.skipIf(
    process.platform !== "linux" || !process.env.PI_SANDBOX_SHELL_BASELINE_CONTRACT,
)(
    "runs a real Zerobox shell with the system baseline and exact external cache grant",
    async () => {
        const fixtureRoot = await mkdtemp("/var/tmp/pi-shell-baseline-");
        const project = await mkdtemp(join(fixtureRoot, "project-"));
        const sibling = await mkdtemp(join(fixtureRoot, "sibling-"));
        const externalCache = await mkdtemp(join(fixtureRoot, "cache-"));
        const userConfig = await mkdtemp(join(fixtureRoot, "config-"));
        // Keep the lease root below the Unix-socket byte budget; it remains a
        // test-owned temporary root rather than the default Pi runtime root.
        const leaseRoot = await mkdtemp("/var/tmp/z-");
        const hostWindowsUsersExists = await stat("/mnt/c/Users")
            .then(() => true)
            .catch(() => false);
        let service: SandboxService | undefined;
        try {
            await writeFile(join(project, "project.txt"), "project");
            await writeFile(join(sibling, "sibling.txt"), "sibling");
            await writeFile(join(externalCache, "cache.txt"), "cache");
            await writeFile(join(userConfig, "settings.json"), "user config");
            service = createSandboxService({
                backend: createContractBackend(join(fixtureRoot, "probe")),
                config: validatePiSandboxConfig({
                    filesystem: {
                        allowRead: [externalCache],
                        allowWrite: ["."],
                    },
                    environment: {
                        path: ["/opt/project-tools/bin", "~/.local/bin"],
                    },
                }),
                createLease: () => createPrivateTempLease({ rootDir: leaseRoot }),
                recoverStaleLeases: async () => {
                    await recoverStalePrivateTempLeases({ rootDir: leaseRoot });
                },
            });
            await service.startBashSession(project);
            const operations = shellOperations(service);

            const allowed = await execute(
                operations,
                [
                    "test \"$(cat project.txt)\" = project",
                    "printf writable > project-write.txt",
                    "/usr/bin/node -e \"process.stdout.write('dynamic')\"",
                    `test \"$(cat ${JSON.stringify(join(externalCache, "cache.txt"))})\" = cache`,
                ].join(" && "),
                project,
            );
            expect(allowed).toEqual({ exitCode: 0, output: "dynamic" });
            expect(await readFile(join(project, "project-write.txt"), "utf8")).toBe(
                "writable",
            );

            for (const blocked of [
                `cat ${JSON.stringify(join(sibling, "sibling.txt"))}`,
                `cat ${JSON.stringify(join(userConfig, "settings.json"))}`,
            ]) {
                expect((await execute(operations, blocked, project)).exitCode, blocked).not.toBe(
                    0,
                );
            }
            // A synthetic empty /mnt/c is safe; only assert this WSL-specific
            // host path when it exists outside the sandbox before spawning.
            if (hostWindowsUsersExists) {
                expect(
                    (await execute(operations, "test ! -e /mnt/c/Users", project)).exitCode,
                ).toBe(0);
            }
        } finally {
            await service?.shutdown();
            await rm(fixtureRoot, { recursive: true, force: true });
            await rm(leaseRoot, { recursive: true, force: true });
        }
    },
    30_000,
);
