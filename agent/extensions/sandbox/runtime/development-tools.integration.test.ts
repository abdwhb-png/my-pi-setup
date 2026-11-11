import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createBashOperations } from "../../_shared/command-execution/exec.ts";
import {
    localMachineId,
    readGlobalSandboxConfig,
    sandboxConfigPath,
} from "../capabilities/authority.ts";
import { resolveShellPolicy } from "../capabilities/policy.ts";
import { hostToolReadClosure } from "./integration-fixtures.ts";
import { validatePiSandboxConfig } from "./policies.ts";
import { createSandboxService } from "./service.ts";
import { PRIVATE_BASH } from "./shell-baseline.ts";
import { createZeroboxBackend } from "./zerobox-backend.ts";

test.skipIf(process.env.PI_INSTALLED_TOOL_DISCOVERY_CONTRACT !== "1")(
    "installed host tools execute with their own resources and remain read-only",
    async () => {
        expect(process.env.GITHUB_ACTIONS).toBe("true");
        const expected = JSON.parse(
            process.env.PI_TOOL_DISCOVERY_EXPECTED ?? "[]",
        ) as Array<{ command: string; executable: string; version: string }>;
        const byName = (command: string) => {
            const tool = expected.find((item) => item.command === command);
            if (!tool)
                throw new Error(
                    `Missing qualification expectation for ${command}`,
                );
            return tool;
        };
        const project = await mkdtemp(join(homedir(), "tool-contract-"));
        const authorityPath = sandboxConfigPath(join(homedir(), ".pi/agent"));
        const policy = resolveShellPolicy({
            cwd: project,
            baseline: validatePiSandboxConfig({}),
            global: readGlobalSandboxConfig(authorityPath, localMachineId()),
            authorityPath,
        });
        const service = createSandboxService({
            backend: createZeroboxBackend(),
            config: policy.config,
        });
        const quote = (value: string) =>
            "'" + value.replaceAll("'", "'\\''") + "'";
        try {
            await writeFile(
                join(project, "main.go"),
                'package main\nimport "fmt"\nfunc main(){fmt.Print("GO_OK")}\n',
            );
            // A project-owned executable can need a library unrelated to the global tools.
            const source = join(project, "runtime.c");
            const executable = join(project, "project-runtime");
            await writeFile(
                source,
                '#include <stdio.h>\nint main(void){puts("PROJECT_RUNTIME_OK");return 0;}\n',
            );
            const compiled = spawnSync(
                "cc",
                [source, "-Wl,--no-as-needed", "-latomic", "-o", executable],
                { encoding: "utf8" },
            );
            expect(compiled.status, compiled.stderr).toBe(0);
            const closure = await hostToolReadClosure(executable);
            const restricted = createSandboxService({
                backend: createZeroboxBackend(),
                config: {
                    ...policy.config,
                    filesystem: {
                        ...policy.config.filesystem,
                        allowRead: [
                            project,
                            ...closure.filter(
                                (path) => !path.includes("libatomic.so"),
                            ),
                        ],
                    },
                    environment: {
                        ...policy.config.environment,
                        installations: [],
                    },
                },
            });
            let failure = "";
            try {
                await restricted.startBashSession(project);
                const denied = createBashOperations({
                    detached: true,
                    prepareSpawn: ({ command, cwd }) =>
                        restricted.prepareBash({
                            file: PRIVATE_BASH,
                            args: ["-c", command],
                            cwd,
                        }),
                });
                const result = await denied.exec(quote(executable), project, {
                    timeout: 10,
                    onData: (chunk) => {
                        failure += chunk.toString();
                    },
                });
                expect(result.exitCode).not.toBe(0);
                expect(failure).toContain("libatomic.so.1");
            } finally {
                await restricted.shutdown();
            }
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
            const commands: Array<[string, string]> = [
                [quote(executable), "PROJECT_RUNTIME_OK"],
                [
                    "node -p 'process.execPath'",
                    realpathSync(byName("node").executable),
                ],
                [
                    "bun -e 'console.log(process.execPath)'",
                    realpathSync(byName("bun").executable),
                ],
                [
                    "python3 -I -S -B -c 'import os,sys,ssl,json; print(os.path.realpath(sys.executable))'",
                    realpathSync(byName("python3").executable),
                ],
                [
                    "php -r 'echo PHP_BINARY;'",
                    realpathSync(byName("php").executable),
                ],
                [
                    "composer --no-plugins --no-scripts --version",
                    byName("composer").version,
                ],
                ["pnpm --version", byName("pnpm").version],
                [
                    "GOTOOLCHAIN=local CGO_ENABLED=0 GOPROXY=off GOSUMDB=off go run main.go",
                    "GO_OK",
                ],
            ];
            for (const [command, marker] of commands) {
                let output = "";
                const result = await operations.exec(command, project, {
                    timeout: 60,
                    onData: (chunk) => {
                        output += chunk.toString();
                    },
                });
                expect(result.exitCode, `${command}\n${output}`).toBe(0);
                expect(output).toContain(marker);
            }
            const systemRoots =
                policy.config.environment.installations?.find(
                    (item) => item.name === "system-libraries",
                )?.roots ?? [];
            expect(systemRoots.length).toBeGreaterThan(0);
            const atomic = systemRoots
                .flatMap((root) => [
                    join(root.root, "x86_64-linux-gnu/libatomic.so.1"),
                    join(root.root, "libatomic.so.1"),
                ])
                .find(existsSync);
            if (!atomic)
                throw new Error("CI host libatomic fixture is missing");
            const noWrite = await operations.exec(
                `${quote(byName("node").executable)} -e ${quote('require("node:fs").openSync(process.argv[1], "r+")')} ${quote(atomic)}`,
                project,
                { timeout: 10, onData: () => {} },
            );
            expect(noWrite.exitCode).not.toBe(0);
            const immutable = realpathSync(byName("node").executable);
            const refusal = await operations.exec(
                `printf forbidden > ${quote(immutable)}`,
                project,
                { timeout: 10, onData: () => {} },
            );
            expect(refusal.exitCode).not.toBe(0);
        } finally {
            await service.shutdown();
            await rm(project, { recursive: true, force: true });
        }
    },
    180000,
);
