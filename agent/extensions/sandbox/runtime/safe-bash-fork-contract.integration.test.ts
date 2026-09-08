import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getPermissionsService } from "@gotgenes/pi-permission-system";
import {
    calls,
    createTestSession,
    says,
    type TestSession,
    when,
} from "@abdwhb-png/pi-test-harness";

const AGENT_ROOT = resolve(import.meta.dir, "../../..");
const SANDBOX_EXTENSION = resolve(import.meta.dir, "../index.ts");
const BASH_EXECUTION_EXTENSION = resolve(
    import.meta.dir,
    "../../bash-execution/index.ts",
);
const PERMISSION_EXTENSION = resolve(
    AGENT_ROOT,
    "node_modules/@gotgenes/pi-permission-system/src/index.ts",
);
const SESSION_STATUS_ENV = "PI_SANDBOX_SESSION_STATUS";

describe("accepted Zerobox safe_bash contract", () => {
    let fixture: string | undefined;
    let session: TestSession | undefined;
    let inheritedSessionStatus: string | undefined;

    it.skipIf(!process.env.PI_SANDBOX_LOCAL_NETWORK_CONTRACT)(
        "routes configured local services through real bash and safe_bash",
        async () => {
            inheritedSessionStatus = process.env[SESSION_STATUS_ENV];
            delete process.env[SESSION_STATUS_ENV];
            fixture = await mkdtemp(resolve(AGENT_ROOT, ".zerobox-local-net-"));
            await mkdir(resolve(fixture, ".pi"));
            await writeFile(
                resolve(fixture, ".pi/settings.json"),
                JSON.stringify({ safeBash: { mode: "coexist" } }),
            );
            session = await createTestSession({
                cwd: fixture,
                extensions: [SANDBOX_EXTENSION, BASH_EXECUTION_EXTENSION],
                propagateErrors: false,
            });
            const command = [
                "curl --fail --silent --show-error --insecure --max-time 15 https://shein-ecom.dev.test/ >/dev/null",
                "curl --fail --silent --show-error --max-time 15 http://localhost:18740/ >/dev/null",
            ].join(" && ");

            await session.run(
                when("Check local development services", [
                    calls("bash", { command, timeout: 45 }),
                    calls("safe_bash", { command, timeout: 45 }),
                    says("Local services reached."),
                ]),
            );

            for (const tool of ["bash", "safe_bash"]) {
                const result = session.events.toolResultsFor(tool).at(-1);
                expect(result, `${tool}: ${result?.text}`).toMatchObject({
                    mocked: false,
                    isError: false,
                    details: {
                        execution: {
                            status: "sandboxed",
                            profile: "bash-general",
                            outcome: "succeeded",
                            exitCode: 0,
                        },
                    },
                });
            }
        },
        90_000,
    );

    for (const command of [
        "bun run --cwd apps/web build",
        "bun run build",
        "bun run typecheck",
        "bun run test",
    ]) {
        it.skipIf(!process.env.PI_SANDBOX_DEV_WORKFLOW_CWD)(
            `replays ${command} through real safe_bash`,
            async () => {
                inheritedSessionStatus = process.env[SESSION_STATUS_ENV];
                delete process.env[SESSION_STATUS_ENV];
                const cwd = process.env.PI_SANDBOX_DEV_WORKFLOW_CWD!;
                session = await createTestSession({
                    cwd,
                    extensions: [
                        PERMISSION_EXTENSION,
                        SANDBOX_EXTENSION,
                        BASH_EXECUTION_EXTENSION,
                    ],
                    propagateErrors: false,
                });
                const start = performance.now();
                await session.run(when(`Run ${command}`, [
                    calls("safe_bash", { command, timeout: 120 }),
                    says("Observed command result."),
                ]));
                const result = session.events.toolResultsFor("safe_bash").at(-1);
                console.info(`${command}: ${((performance.now() - start) / 1000).toFixed(2)}s`);
                expect(result?.text).not.toContain("Sandbox setup failed");
                expect(result, result?.text).toMatchObject({ mocked: false, isError: false });
                expect(result?.details).toMatchObject({ execution: { status: 'sandboxed', profile: 'bash-general', tmpNamespace: 'host', outcome: 'succeeded', exitCode: 0 } });
            },
            180_000,
        );
    }

    afterEach(async () => {
        session?.dispose();
        session = undefined;
        if (fixture) await rm(fixture, { recursive: true, force: true });
        fixture = undefined;
        if (inheritedSessionStatus === undefined) {
            delete process.env[SESSION_STATUS_ENV];
        } else {
            process.env[SESSION_STATUS_ENV] = inheritedSessionStatus;
        }
    });

    it("preserves the real stderr and exit code from a shebang process", async () => {
        inheritedSessionStatus = process.env[SESSION_STATUS_ENV];
        delete process.env[SESSION_STATUS_ENV];
        fixture = await mkdtemp(resolve(AGENT_ROOT, ".zerobox-safe-bash-"));
        await mkdir(resolve(fixture, "package/node_modules"), {
            recursive: true,
        });
        const script = resolve(fixture, "failure.sh");
        await writeFile(
            script,
            "#!/bin/sh\nprintf 'real-safe-bash-error\\n' >&2\nexit 37\n",
        );
        await chmod(script, 0o755);

        session = await createTestSession({
            cwd: fixture,
            extensions: [SANDBOX_EXTENSION, BASH_EXECUTION_EXTENSION],
            propagateErrors: false,
        });
        await session.run(
            when("Run the failing script", [
                calls("safe_bash", { command: "./failure.sh" }),
                says("Failure observed."),
            ]),
        );

        const [result] = session.events.toolResultsFor("safe_bash");
        expect(result).toMatchObject({ isError: true, mocked: false });
        expect(result?.text).toBe(
            "real-safe-bash-error\n\n\nCommand exited with code 37",
        );
    }, 30_000);

    it("keeps direct node_modules edits denied by Pi Permission System", async () => {
        fixture = await mkdtemp(resolve(AGENT_ROOT, ".zerobox-safe-bash-"));
        session = await createTestSession({
            cwd: fixture,
            extensions: [PERMISSION_EXTENSION],
            propagateErrors: false,
        });

        const permissions = getPermissionsService();
        expect(permissions).toBeDefined();
        for (const surface of ["write", "edit"]) {
            expect(
                permissions?.checkPermission(
                    surface,
                    "node_modules/dependency/index.js",
                ),
            ).toMatchObject({
                state: "deny",
                matchedPattern: "node_modules/*",
            });
        }
    });

    it("keeps the global Docker authority denied by Pi Permission System", async () => {
        fixture = await mkdtemp(resolve(AGENT_ROOT, ".zerobox-safe-bash-"));
        session = await createTestSession({
            cwd: fixture,
            extensions: [PERMISSION_EXTENSION],
            propagateErrors: false,
        });

        const permissions = getPermissionsService();
        expect(permissions).toBeDefined();
        for (const surface of ["write", "edit"]) {
            for (const path of [
                "sandbox.global.json",
                "agent/sandbox.global.json",
                ".pi/agent/sandbox.global.json",
                resolve(AGENT_ROOT, "sandbox.global.json"),
            ]) {
                expect(permissions?.checkPermission(surface, path)).toMatchObject({
                    state: "deny",
                });
            }
        }
    });

    it("blocks a real safe_bash write to Docker authority from its parent root", async () => {
        inheritedSessionStatus = process.env[SESSION_STATUS_ENV];
        delete process.env[SESSION_STATUS_ENV];
        fixture = await mkdtemp(resolve(AGENT_ROOT, ".zerobox-safe-bash-"));
        const isolatedAgentDir = resolve(fixture, "agent");
        await mkdir(isolatedAgentDir);
        await writeFile(
            resolve(isolatedAgentDir, "sandbox.json"),
            JSON.stringify({
                enabled: true,
                filesystem: { allowWrite: ["."], denyWrite: [] },
            }),
        );
        const authorityPath = resolve(
            isolatedAgentDir,
            "sandbox.global.json",
        );
        await writeFile(authorityPath, "{}", { mode: 0o600 });
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
        try {
            session = await createTestSession({
                cwd: fixture,
                extensions: [SANDBOX_EXTENSION, BASH_EXECUTION_EXTENSION],
                propagateErrors: false,
            });
            await session.run(
                when("Try to overwrite Docker authority", [
                    calls("safe_bash", {
                        command:
                            "printf compromised >agent/sandbox.global.json",
                    }),
                    says("Write result observed."),
                ]),
            );

            const [result] = session.events.toolResultsFor("safe_bash");
            expect(result).toMatchObject({ mocked: false, isError: true });
            expect(await readFile(authorityPath, "utf8")).toBe("{}");
        } finally {
            if (previousAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
        }
    }, 30_000);

    it("runs normal Bun tooling that writes dependency-owned files", async () => {
        inheritedSessionStatus = process.env[SESSION_STATUS_ENV];
        delete process.env[SESSION_STATUS_ENV];
        fixture = await mkdtemp(resolve(AGENT_ROOT, ".zerobox-safe-bash-"));
        await writeFile(resolve(fixture, "package.json"), JSON.stringify({
            name: "sandbox-fixture", workspaces: ["packages/*"],
        }));
        for (const name of ["a", "b"]) {
            await mkdir(resolve(fixture, `packages/${name}/node_modules`), { recursive: true });
            await writeFile(resolve(fixture, `packages/${name}/package.json`), JSON.stringify({
                name, scripts: { probe: `printf workspace-${name}` },
            }));
        }
        await writeFile(resolve(fixture, "local-test.ts"), `
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("local-http-ok") });
try {
    const text = await (await fetch(server.url)).text();
    if (text !== "local-http-ok") throw new Error("wrong local server response");
    console.log(text);
} finally { server.stop(true); }
`);
        session = await createTestSession({
            cwd: fixture, extensions: [SANDBOX_EXTENSION, BASH_EXECUTION_EXTENSION], propagateErrors: false,
        });
        await session.run(when("Run normal development checks", [
            calls("safe_bash", { command: "bun run --filter './packages/*' probe" }),
            calls("safe_bash", { command: "test \"$TMPDIR\" = /tmp && printf private-temp >/tmp/session-marker" }),
            calls("safe_bash", { command: "cat /tmp/session-marker && bun local-test.ts" }),
            calls("safe_bash", { command: "printf tool-cache >packages/a/node_modules/generated-cache" }),
            says("Development checks observed."),
        ]));
        const results = session.events.toolResultsFor("safe_bash");
        expect(results).toHaveLength(4);
        for (const result of results.slice(0, 3)) expect(result).toMatchObject({ mocked: false, isError: false });
        expect(results[0]?.text).toContain("workspace-a");
        expect(results[0]?.text).toContain("workspace-b");
        expect(results[2]?.text).toContain("private-templocal-http-ok");
        expect(results[3]).toMatchObject({ mocked: false, isError: false });
        expect(
            await readFile(
                resolve(fixture, "packages/a/node_modules/generated-cache"),
                "utf8",
            ),
        ).toBe("tool-cache");
    }, 45_000);
});
