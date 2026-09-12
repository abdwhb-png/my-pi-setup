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
import { candidateBackendOptions, hasCandidateRuntime } from "./integration-fixtures.ts";
import { PRIVATE_BASH } from "./shell-baseline.ts";

function createContractBackend(probeRoot: string) {
    return createZeroboxBackend(candidateBackendOptions(probeRoot));
}

function shellOperations(service: SandboxService): BashOperations {
    return createBashOperations({
        detached: true,
        prepareSpawn: ({ command, cwd }) =>
            service.prepareBash({
                file: PRIVATE_BASH,
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

test.skipIf(process.platform !== "linux" || !process.env.PI_SANDBOX_SHELL_BASELINE_CONTRACT || !hasCandidateRuntime())(
    "keeps a project under host tmp usable with only private base commands",
    async () => {
        const project = await mkdtemp("/tmp/pi-private-project-");
        const sibling = await mkdtemp("/tmp/pi-host-witness-");
        const leaseRoot = await mkdtemp("/var/tmp/z-");
        const previous = process.env.PI_PRIVATE_ENV_FIXTURE;
        process.env.PI_PRIVATE_ENV_FIXTURE = "host-only-fixture";
        const service = createSandboxService({
            backend: createContractBackend(join(leaseRoot, "probe")),
            config: validatePiSandboxConfig({}),
            createLease: () => createPrivateTempLease({ rootDir: leaseRoot }),
            recoverStaleLeases: async () => { await recoverStalePrivateTempLeases({ rootDir: leaseRoot }); },
        });
        try {
            await writeFile(join(project, "input"), "one\ntwo\n");
            await writeFile(join(sibling, "private"), "host witness");
            await service.startBashSession(project);
            const result = await execute(shellOperations(service), [
                'test -z "${PI_PRIVATE_ENV_FIXTURE+present}"',
                "test ! -e /__zerobox/analysis",
                `test ! -e ${JSON.stringify(join(sibling, "private"))}`,
                'for tool in bash cat find grep sed gawk diff tar gzip; do command -v "$tool" >/dev/null || exit 40; done',
                'for tool in git rg jq node bun; do if command -v "$tool" >/dev/null; then exit 41; fi; done',
                "cat input | grep two | sed s/two/three/ | gawk '{print $1}' > output",
                "tar -czf result.tar.gz input output",
                "gzip -t result.tar.gz",
                "find . -name output | grep -q output",
                "diff input input",
                "cat output",
            ].join(" && "), project);
            expect(result).toEqual({ exitCode: 0, output: "three\n" });
            expect(await readFile(join(project, "output"), "utf8")).toBe("three\n");
        } finally {
            await service.shutdown();
            if (previous === undefined) delete process.env.PI_PRIVATE_ENV_FIXTURE;
            else process.env.PI_PRIVATE_ENV_FIXTURE = previous;
            await rm(project, { recursive: true, force: true });
            await rm(sibling, { recursive: true, force: true });
            await rm(leaseRoot, { recursive: true, force: true });
        }
    },
    20_000,
);

// This invokes an explicitly identified candidate binary and remains opt-in.
test.skipIf(
    process.platform !== "linux" ||
        !process.env.PI_SANDBOX_SHELL_BASELINE_CONTRACT ||
        !hasCandidateRuntime(),
)(
    "runs a real Zerobox private shell with an exact external cache grant",
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
                    "printf dynamic",
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
