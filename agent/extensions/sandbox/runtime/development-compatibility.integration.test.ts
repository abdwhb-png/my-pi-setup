import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { createBashOperations } from "../../_shared/command-execution/exec.ts";
import {
    candidateBackendOptions,
    hasCandidateRuntime,
    hostToolReadClosure,
} from "./integration-fixtures.ts";
import { validatePiSandboxConfig, type PiSandboxConfig } from "./policies.ts";
import {
    createPrivateTempLease,
    recoverStalePrivateTempLeases,
} from "./private-temp.ts";
import { createSandboxService, type SandboxService } from "./service.ts";
import { PRIVATE_BASH } from "./shell-baseline.ts";
import { createZeroboxBackend } from "./zerobox-backend.ts";

const enabled =
    process.platform === "linux" &&
    process.env.PI_SANDBOX_DEVELOPMENT_COMPATIBILITY_CONTRACT === "1" &&
    hasCandidateRuntime();

function quote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

async function withDevelopmentSandbox(
    config: PiSandboxConfig,
    run: (context: {
        cwd: string;
        execute: (
            command: string,
        ) => Promise<{ exitCode: number | null; output: string }>;
    }) => Promise<void>,
): Promise<void> {
    const root = await mkdtemp("/var/tmp/pi-dev-contract-");
    let leaseRoot: string | undefined;
    let service: SandboxService | undefined;
    try {
        leaseRoot = await mkdtemp("/var/tmp/z-");
        const privateLeases = leaseRoot;
        const sandbox = createSandboxService({
            backend: createZeroboxBackend(
                candidateBackendOptions(join(root, "probe")),
            ),
            config,
            createLease: () =>
                createPrivateTempLease({ rootDir: privateLeases }),
            recoverStaleLeases: async () => {
                await recoverStalePrivateTempLeases({ rootDir: privateLeases });
            },
        });
        service = sandbox;
        await sandbox.startBashSession(root);
        const operations = createBashOperations({
            detached: true,
            prepareSpawn: ({ command, cwd }) =>
                sandbox.prepareBash({
                    file: PRIVATE_BASH,
                    args: [
                        "--noprofile",
                        "--norc",
                        "-o",
                        "pipefail",
                        "-c",
                        command,
                    ],
                    cwd,
                }),
        });
        await run({
            cwd: root,
            execute: async (command) => {
                let output = "";
                const result = await operations.exec(command, root, {
                    timeout: 20,
                    onData: (chunk) => {
                        output += chunk.toString();
                    },
                });
                return { exitCode: result.exitCode, output };
            },
        });
    } finally {
        await service?.shutdown();
        await rm(root, { recursive: true, force: true });
        if (leaseRoot) await rm(leaseRoot, { recursive: true, force: true });
    }
}

const nodeProgram =
    'const r=require("node:child_process").spawnSync(process.execPath,["-e","console.log(42)"],{encoding:"utf8"}); if(r.error)throw r.error; if(r.status!==0)process.exit(3); process.stdout.write(r.stdout)';

test.skipIf(!enabled)(
    "preserves explicitly selected conventional host symlinks",
    async () => {
        const command = "/usr/bin/sh";
        const target = await realpath(command);
        await withDevelopmentSandbox(
            validatePiSandboxConfig({
                filesystem: { allowRead: await hostToolReadClosure(command) },
                network: { allowedDomains: [], allowLocalBinding: false },
            }),
            async ({ execute }) => {
                expect(
                    await execute(`${command} -c 'readlink /proc/$$/exe; :'`),
                ).toEqual({ exitCode: 0, output: `${target}\n` });
            },
        );
    },
    30_000,
);

for (const denySed of [false, true]) {
    test.skipIf(!enabled)(
        `preserves host commands and subprocess output with conventional helpers ${denySed ? "restricted" : "available"}`,
        async () => {
            const hostFiles = [
                ...(await hostToolReadClosure("/usr/bin/node")),
                ...(await hostToolReadClosure("/usr/bin/bash")),
            ];
            for (const allowedDomains of [[], ["example.invalid"]]) {
                await withDevelopmentSandbox(
                    validatePiSandboxConfig({
                        filesystem: {
                            allowRead: hostFiles,
                            denyRead: denySed ? ["/usr/bin/sed"] : [],
                        },
                        network: { allowedDomains, allowLocalBinding: false },
                    }),
                    async ({ execute }) => {
                        const helpers = denySed
                            ? "sh -c 'if command -p sed </dev/null; then exit 41; fi; command -p uname -s' 2>/dev/null"
                            : "sh -c 'ln -s target /tmp/helper-link && printf input | command -p sed s/input/helpers/; command -p uname -s; command -p readlink /tmp/helper-link'";
                        expect(await execute(helpers)).toEqual({
                            exitCode: 0,
                            output: denySed
                                ? "Linux\n"
                                : "helpersLinux\ntarget\n",
                        });
                        expect(
                            await execute(
                                `/usr/bin/node -e ${quote(nodeProgram)}`,
                            ),
                        ).toEqual({ exitCode: 0, output: "42\n" });
                        // A host grant must retain its executable rather than resolve to the bundled Bash.
                        expect(
                            await execute(
                                `/bin/bash -c 'readlink /proc/$$/exe; :'`,
                            ),
                        ).toEqual({ exitCode: 0, output: "/usr/bin/bash\n" });
                    },
                );
            }
        },
        90_000,
    );
}

test.skipIf(!enabled)(
    "runs default pnpm, npm and Bun project scripts without shell overrides",
    async () => {
        const pnpm = process.env.PI_SANDBOX_PNPM_FIXTURE;
        const npm = process.env.PI_SANDBOX_NPM_FIXTURE;
        if (!pnpm || !npm || !isAbsolute(pnpm) || !isAbsolute(npm)) {
            throw new Error(
                "PI_SANDBOX_PNPM_FIXTURE and PI_SANDBOX_NPM_FIXTURE must identify absolute fixture executables",
            );
        }
        const bun = process.execPath;
        const hostFiles = [
            ...(await hostToolReadClosure("/usr/bin/node")),
            ...(await hostToolReadClosure(bun)),
            ...(await hostToolReadClosure(pnpm)),
            dirname(pnpm),
            dirname(dirname(npm)),
        ];
        for (const allowedDomains of [[], ["example.invalid"]]) {
            await withDevelopmentSandbox(
                validatePiSandboxConfig({
                    filesystem: { allowRead: hostFiles },
                    environment: {
                        path: ["/usr/bin"],
                        variables: { npm_config_cache: "/tmp/npm-cache" },
                    },
                    network: { allowedDomains, allowLocalBinding: false },
                }),
                async ({ cwd, execute }) => {
                    await writeFile(
                        join(cwd, "package.json"),
                        JSON.stringify({
                            name: "development-contract",
                            private: true,
                            scripts: {
                                probe: `node -e 'require("node:fs").writeFileSync("script-result", "script-ok")'`,
                            },
                        }),
                    );
                    expect(await execute(`${quote(pnpm)} --version`)).toEqual({
                        exitCode: 0,
                        output: "12.8.1\n",
                    });
                    for (const launcher of [
                        quote(pnpm),
                        `/usr/bin/node ${quote(npm)}`,
                        quote(bun),
                    ]) {
                        await rm(join(cwd, "script-result"), { force: true });
                        const result = await execute(`${launcher} run probe`);
                        expect(result.exitCode, result.output).toBe(0);
                        expect(
                            await readFile(join(cwd, "script-result"), "utf8"),
                        ).toBe("script-ok");
                    }
                },
            );
        }
    },
    90_000,
);
