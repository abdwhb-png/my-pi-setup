import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createBashOperations } from "../../_shared/command-execution/exec.ts";
import {
    candidateBackendOptions,
    hasCandidateRuntime,
    hostToolReadClosure,
} from "./integration-fixtures.ts";
import {
    createPrivateTempLease,
    recoverStalePrivateTempLeases,
} from "./private-temp.ts";
import { validatePiSandboxConfig } from "./policies.ts";
import { createSandboxService } from "./service.ts";
import { PRIVATE_BASH } from "./shell-baseline.ts";
import { createZeroboxBackend } from "./zerobox-backend.ts";

test.skipIf(
    process.platform !== "linux" ||
        process.env.PI_SANDBOX_SFW_MEDIATED_DIRECT_CONTRACT !== "1" ||
        !hasCandidateRuntime() ||
        !Bun.which("sfw") ||
        !Bun.which("npm") ||
        !Bun.which("node"),
)(
    "supported sfw npm view uses a fresh cache through admitted direct TCP",
    async () => {
        const root = await mkdtemp("/var/tmp/pi-sfw-direct-");
        const leaseRoot = await mkdtemp("/var/tmp/z-");
        const cwd = join(root, "project");
        const npmCache = join(cwd, "npm-cache");
        const sfwCommand = Bun.which("sfw")!;
        const npmCommand = Bun.which("npm")!;
        const nodeCommand = Bun.which("node")!;
        const sfwEntrypoint = await realpath(sfwCommand);
        const npmEntrypoint = await realpath(npmCommand);
        const sfwRoot = dirname(dirname(sfwEntrypoint));
        const npmRoot = dirname(dirname(npmEntrypoint));
        try {
            await mkdir(npmCache, { recursive: true, mode: 0o700 });
            expect(await readdir(npmCache)).toEqual([]);
            const service = createSandboxService({
                backend: createZeroboxBackend(
                    candidateBackendOptions(join(root, "probe")),
                ),
                config: validatePiSandboxConfig({
                    filesystem: {
                        allowRead: [
                            sfwCommand,
                            sfwRoot,
                            npmCommand,
                            npmRoot,
                            "/usr/bin/env",
                            ...(await hostToolReadClosure(nodeCommand)),
                            "/etc/ssl/certs/ca-certificates.crt",
                        ],
                        allowWrite: [cwd],
                    },
                    network: {
                        allowedDomains: [
                            "firewall-api.socket.dev",
                            "registry.npmjs.org",
                        ],
                        mediatedDirectTcp: {
                            enabled: true,
                            ports: [443],
                        },
                    },
                    environment: {
                        path: [
                            dirname(sfwCommand),
                            dirname(npmCommand),
                            dirname(nodeCommand),
                        ],
                        variables: {
                            SFW_SKIP_UPDATE_CHECK: "1",
                        },
                    },
                }),
                createLease: () =>
                    createPrivateTempLease({ rootDir: leaseRoot }),
                recoverStaleLeases: async () => {
                    await recoverStalePrivateTempLeases({
                        rootDir: leaseRoot,
                    });
                },
            });
            let output = "";
            try {
                await service.startBashSession(cwd);
                service.getProfileContexts();
                const operations = createBashOperations({
                    prepareSpawn: ({ command }) =>
                        service.prepareBash({
                            file: PRIVATE_BASH,
                            args: ["-c", command],
                            cwd,
                        }),
                });
                const result = await operations.exec(
                    `env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy npm_config_cache=${JSON.stringify(npmCache)} ${PRIVATE_BASH} -c 'test -z "\${HTTP_PROXY-}\${HTTPS_PROXY-}\${ALL_PROXY-}\${http_proxy-}\${https_proxy-}\${all_proxy-}" && test "$npm_config_cache" = ${JSON.stringify(npmCache)} && exec ${nodeCommand} ${sfwEntrypoint} --verbose npm view is-number@7.0.0 version'`,
                    cwd,
                    {
                        timeout: 30,
                        onData: (chunk) => {
                            output += chunk.toString();
                        },
                    },
                );
                expect(result.exitCode, output).toBe(0);
                expect(output).toContain("Protected by Socket Firewall");
                expect(output).toContain("7.0.0");
                expect(service.getProfileContexts()["bash-general"]).toMatchObject(
                    {
                        version: 3,
                        admission: "admitted",
                        network: {
                            mediatedDirectTcp: { ports: [443] },
                        },
                    },
                );
                await expect(readdir(npmCache)).resolves.toBeArray();
                expect(await Bun.file(join(cwd, "node_modules")).exists()).toBe(
                    false,
                );
                expect(await Bun.file(join(cwd, "package-lock.json")).exists()).toBe(
                    false,
                );
            } finally {
                await service.shutdown();
            }
        } finally {
            await rm(root, { recursive: true, force: true });
            await rm(leaseRoot, { recursive: true, force: true });
        }
    },
    60_000,
);
