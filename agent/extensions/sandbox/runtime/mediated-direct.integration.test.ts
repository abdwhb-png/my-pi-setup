import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createBashOperations } from "../../_shared/command-execution/exec.ts";
import { localMachineId } from "../capabilities/authority.ts";
import { loadSandboxConfig } from "../index.ts";
import {
    candidateBackendOptions,
    hasCandidateRuntime,
    hostToolReadClosure,
} from "./integration-fixtures.ts";
import {
    createPrivateTempLease,
    recoverStalePrivateTempLeases,
} from "./private-temp.ts";
import { createSandboxService } from "./service.ts";
import { PRIVATE_BASH } from "./shell-baseline.ts";
import { createZeroboxBackend } from "./zerobox-backend.ts";

const projects = [
    { name: "alpha", domain: "example.com", url: "https://example.com/" },
    {
        name: "beta",
        domain: "registry.npmjs.org",
        url: "https://registry.npmjs.org/-/ping",
    },
] as const;

test.skipIf(
    process.platform !== "linux" ||
        process.env.PI_SANDBOX_MEDIATED_DIRECT_CONTRACT !== "1" ||
        !hasCandidateRuntime(),
)(
    "two projects receive direct TCP only for their own domain grant",
    async () => {
        const root = await mkdtemp("/var/tmp/pi-direct-");
        const leaseRoot = await mkdtemp("/var/tmp/z-");
        const agentDir = join(root, "agent");
        const machineId = localMachineId();
        try {
            await mkdir(agentDir, { recursive: true, mode: 0o700 });
            const curlRead = [
                ...(await hostToolReadClosure("/usr/bin/curl")),
                "/etc/ssl/certs/ca-certificates.crt",
            ];
            await writeFile(
                join(agentDir, "sandbox.json"),
                JSON.stringify({
                    version: 2,
                    machineId,
                    filesystem: { allowRead: curlRead },
                    network: {
                        allowedDomains: projects.map(({ domain }) => domain),
                        mediatedDirectTcp: {
                            allowed: true,
                            ports: [80, 443],
                        },
                    },
                }),
                { mode: 0o600 },
            );

            for (const project of projects) {
                const cwd = join(root, project.name);
                await mkdir(join(cwd, ".pi"), {
                    recursive: true,
                    mode: 0o700,
                });
                await writeFile(
                    join(cwd, ".pi", "sandbox.json"),
                    JSON.stringify({
                        network: {
                            allowedDomains: [project.domain],
                            mediatedDirectTcp: {
                                enabled: true,
                                ports: [443],
                            },
                        },
                    }),
                    { mode: 0o600 },
                );
                const loaded = loadSandboxConfig(cwd, {
                    agentDir,
                    machineId,
                });
                expect(loaded.config.network.mediatedDirectTcp).toEqual({
                    enabled: true,
                    ports: [443],
                });
                const other = projects.find(
                    (candidate) => candidate !== project,
                )!;
                const service = createSandboxService({
                    backend: createZeroboxBackend(
                        candidateBackendOptions(
                            join(root, `${project.name}-probe`),
                        ),
                    ),
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
                    await service.startBashSession(cwd);
                    const operations = createBashOperations({
                        prepareSpawn: ({ command }) =>
                            service.prepareBash({
                                file: PRIVATE_BASH,
                                args: ["-c", command],
                                cwd,
                            }),
                    });
                    let output = "";
                    const allowed = await operations.exec(
                        `/usr/bin/curl --noproxy '*' --fail --silent --show-error --max-time 15 ${JSON.stringify(project.url)} >/dev/null`,
                        cwd,
                        {
                            timeout: 20,
                            onData: (chunk) => {
                                output += chunk.toString();
                            },
                        },
                    );
                    expect(
                        allowed.exitCode,
                        `${project.name} direct request: ${output}`,
                    ).toBe(0);

                    output = "";
                    const denied = await operations.exec(
                        `/usr/bin/curl --noproxy '*' --fail --silent --show-error --max-time 3 ${JSON.stringify(other.url)} >/dev/null`,
                        cwd,
                        {
                            timeout: 8,
                            onData: (chunk) => {
                                output += chunk.toString();
                            },
                        },
                    );
                    expect(
                        denied.exitCode,
                        `${project.name} cross-project denial: ${output}`,
                    ).not.toBe(0);
                } finally {
                    await service.shutdown();
                }
            }
        } finally {
            await rm(root, { recursive: true, force: true });
            await rm(leaseRoot, { recursive: true, force: true });
        }
    },
    90_000,
);
