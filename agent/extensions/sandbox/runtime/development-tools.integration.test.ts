import { test, expect } from "bun:test";
import { realpathSync } from "node:fs";
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
