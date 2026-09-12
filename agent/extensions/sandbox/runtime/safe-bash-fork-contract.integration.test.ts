import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { getPermissionsService } from "@gotgenes/pi-permission-system";
import { localMachineId } from "../capabilities/authority.ts";
import {
    calls,
    createTestSession,
    says,
    type TestSession,
    when,
} from "@abdwhb-png/pi-test-harness";

const AGENT_ROOT = resolve(import.meta.dir, "../../..");
const SANDBOX_EXTENSION = resolve(import.meta.dir, "../index.ts");
const CANDIDATE_BINARY_ENV = "PI_SANDBOX_ZEROBOX_BINARY";
const CANDIDATE_SHA256_ENV = "PI_SANDBOX_ZEROBOX_SHA256";
const CANDIDATE_VERSION = "0.3.3-fork.17";
const BASH_EXECUTION_EXTENSION = resolve(
    import.meta.dir,
    "../../bash-execution/index.ts",
);
const PERMISSION_EXTENSION = resolve(
    AGENT_ROOT,
    "node_modules/@gotgenes/pi-permission-system/src/index.ts",
);
const SESSION_STATUS_ENV = "PI_SANDBOX_SESSION_STATUS";
async function writeActivePolicy(agentDir: string, cwd: string, policy: Record<string, unknown> = {}) {
    await mkdir(resolve(cwd, ".pi"), { recursive: true });
    await writeFile(resolve(agentDir, "sandbox.json"), JSON.stringify({ version: 2, machineId: localMachineId(), docker: { allowed: false }, ...policy }), { mode: 0o600 });
}

function observeExtensionErrors() {
    return spyOn(ExtensionRunner.prototype, "emitError");
}

// Never fall back to a personal backend when a qualified candidate is absent.
describe.skipIf(process.platform !== "linux" ||
    (!process.env[CANDIDATE_BINARY_ENV] && !process.env[CANDIDATE_SHA256_ENV]))("accepted Zerobox safe_bash contract", () => {
    let fixture: string | undefined;
    let session: TestSession | undefined;
    let inheritedSessionStatus: string | undefined;
    let previousAgentDir: string | undefined;
    let testAgentDir: string;
    let sandboxExtension: string;
    let fixtureRoot: string;
    let leaseRoot: string;
    let analysisKey: string;
    let analysisRequests: string[];
    let extensionErrors: ReturnType<typeof observeExtensionErrors> | undefined;
    beforeEach(async () => {
        previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        inheritedSessionStatus = process.env[SESSION_STATUS_ENV];
        fixtureRoot = await mkdtemp("/var/tmp/pi-contract-");
        leaseRoot = await mkdtemp("/var/tmp/z-");
        testAgentDir = resolve(fixtureRoot, "agent");
        await mkdir(testAgentDir, { mode: 0o700 });
        process.env.PI_CODING_AGENT_DIR = testAgentDir;
        extensionErrors = observeExtensionErrors();
        analysisKey = `pi.test.safe-bash-contract.analysis:${fixtureRoot}`;
        analysisRequests = [];
        Object.defineProperty(globalThis, Symbol.for(analysisKey), { value: analysisRequests, configurable: true });
        sandboxExtension = resolve(testAgentDir, "sandbox-entrypoint.ts");
        const binaryPath = process.env[CANDIDATE_BINARY_ENV];
        const binarySha256 = process.env[CANDIDATE_SHA256_ENV];
        if (!binaryPath || !binarySha256) {
            throw new Error(`${CANDIDATE_BINARY_ENV} and ${CANDIDATE_SHA256_ENV} must be supplied together`);
        }
        await writeFile(sandboxExtension, [
            `import { createSandboxExtension } from ${JSON.stringify(SANDBOX_EXTENSION)};`,
            `import { createPrivateTempLease, recoverStalePrivateTempLeases } from ${JSON.stringify(resolve(import.meta.dir, "private-temp.ts"))};`,
            "export default (pi) => createSandboxExtension(pi, {",
            `zeroboxBackend: { binaryPath: ${JSON.stringify(binaryPath)}, expectedProvenance: { version: ${JSON.stringify(CANDIDATE_VERSION)}, binarySha256: ${JSON.stringify(binarySha256)} }, probeRoot: ${JSON.stringify(resolve(fixtureRoot, "probe"))} },`,
            `sandboxServiceOptions: { createLease: () => createPrivateTempLease({ rootDir: ${JSON.stringify(leaseRoot)} }), recoverStaleLeases: async () => { await recoverStalePrivateTempLeases({ rootDir: ${JSON.stringify(leaseRoot)} }); } },`,
            // These tests inspect Analysis context metadata but never execute an
            // Analysis program. Do not launch its independent personal host.
            "analysisServiceOptions: { runHost: async (request) => {",
            "if (!['sandbox-preflight-typescript', 'sandbox-preflight-python'].includes(request.id)) throw new Error('Unexpected Analysis request');",
            `globalThis[Symbol.for(${JSON.stringify(analysisKey)})].push(request.id);`,
            "return { output: '1', stderr: '', runtime: request.worker, durationMs: 0, truncated: false };",
            "} },",
            "});",
        ].join("\n"));
        const directory = resolve(testAgentDir, "extensions/pi-permission-system");
        await mkdir(directory, { recursive: true });
        await writeFile(resolve(directory, "config.json"), JSON.stringify({
            authorizerChain: [], shellTools: { safe_bash: { commandArgument: "command" } },
            permission: { "*": "allow", write: { "node_modules/*": "deny", "*sandbox.json": "deny" }, edit: { "node_modules/*": "deny", "*sandbox.json": "deny" } },
        }));
    });

    it.skipIf(!process.env.PI_SANDBOX_LOCAL_NETWORK_CONTRACT)(
        "routes configured local services through real bash and safe_bash",
        async () => {
            inheritedSessionStatus = process.env[SESSION_STATUS_ENV];
            delete process.env[SESSION_STATUS_ENV];
            fixture = await mkdtemp(resolve(fixtureRoot, ".zerobox-local-net-"));
            await writeActivePolicy(testAgentDir, fixture, { network: { allowedDomains: ["localhost:18740"], allowedHostDomains: ["shein-ecom.dev.test:443"] } });
            await mkdir(resolve(fixture, ".pi"));
            await writeFile(
                resolve(fixture, ".pi/settings.json"),
                JSON.stringify({ safeBash: { mode: "coexist" } }),
            );
            session = await createTestSession({
                cwd: fixture,
                extensions: [sandboxExtension, BASH_EXECUTION_EXTENSION],
                propagateErrors: false,
            });
            const command = [
                "curl --fail --silent --show-error --insecure --max-time 15 https://shein-ecom.dev.test/ >/dev/null",
                "curl --fail --silent --show-error --max-time 15 http://localhost:18740/ >/dev/null",
                "printf 'GET / HTTP/1.0\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n' | nc -w 5 127.0.0.1 18740 | grep -Eq '^HTTP/[0-9.]+ [0-9]{3}'",
                "! nc -z -w 2 127.0.0.1 1",
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

    it("keeps ordinary D2 bash in Zerobox with host network closed and private tmp", async () => {
        inheritedSessionStatus = process.env[SESSION_STATUS_ENV];
        delete process.env[SESSION_STATUS_ENV];
        fixture = await mkdtemp(resolve(fixtureRoot, ".zerobox-d2-bash-"));
        await writeActivePolicy(testAgentDir, fixture);
        const authorityPath = resolve(testAgentDir, "sandbox.json");
        const authority = await readFile(resolve(testAgentDir, "sandbox.json"), "utf8");
        let requests = 0;
        const server = createServer((_request, response) => {
            requests++;
            response.end("host listener");
        });
        await new Promise<void>((done) =>
            server.listen(0, "127.0.0.1", done),
        );
        const address = server.address();
        if (!address || typeof address === "string")
            throw new Error("Missing listener address");
        try {
            session = await createTestSession({
                cwd: fixture,
                extensions: [sandboxExtension, BASH_EXECUTION_EXTENSION],
                propagateErrors: false,
            });
            const command = [
                `if curl --noproxy '*' --fail --silent --max-time 2 http://127.0.0.1:${address.port}; then exit 41; fi`,
                `if printf compromised > ${JSON.stringify(authorityPath)}; then exit 42; fi`,
                "test \"$TMPDIR\" = /tmp",
                "printf d2-isolated",
            ].join("; ");

            await session.run(
                when("Verify ordinary default sandbox shell isolation", [
                    calls("bash", { command, timeout: 10 }),
                    says("Isolation observed"),
                ]),
            );

            const result = session.events.toolResultsFor("bash")[0];
            expect(result, result?.text).toMatchObject({
                mocked: false,
                isError: false,
                details: {
                    execution: {
                        status: "sandboxed",
                        profile: "bash-general",
                        backend: "zerobox",
                        mode: "sandbox",
                        shellProfile: "default",
                        tmpNamespace: "lease-private",
                        outcome: "succeeded",
                        exitCode: 0,
                    },
                },
            });
            expect(result?.text).toContain("d2-isolated");
            expect(requests).toBe(0);
            expect(await readFile(authorityPath, "utf8")).toBe(authority);
        } finally {
            await new Promise<void>((done, reject) =>
                server.close((error) => (error ? reject(error) : done())),
            );
        }
    }, 30_000);

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
                await writeActivePolicy(testAgentDir, cwd);
                session = await createTestSession({
                    cwd,
                    extensions: [
                        PERMISSION_EXTENSION,
                        sandboxExtension,
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
                expect(result?.details).toMatchObject({ execution: { status: 'sandboxed', profile: 'bash-general', tmpNamespace: 'lease-private', outcome: 'succeeded', exitCode: 0 } });
            },
            180_000,
        );
    }

    afterEach(async () => {
        const usesSandbox = session?.session.extensionRunner.getExtensionPaths().includes(sandboxExtension);
        try {
            await session?.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
        } finally {
            session?.dispose();
            session = undefined;
            const errors = extensionErrors?.mock.calls.map(([error]) => error) ?? [];
            extensionErrors?.mockRestore();
            extensionErrors = undefined;
            Reflect.deleteProperty(globalThis, Symbol.for(analysisKey));
            if (inheritedSessionStatus === undefined) delete process.env[SESSION_STATUS_ENV];
            else process.env[SESSION_STATUS_ENV] = inheritedSessionStatus;
            if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            if (fixture) await rm(fixture, { recursive: true, force: true });
            fixture = undefined;
            await rm(fixtureRoot, { recursive: true, force: true });
            await rm(leaseRoot, { recursive: true, force: true });
            expect(errors).toEqual([]);
            if (usesSandbox) {
                expect(analysisRequests).toContain("sandbox-preflight-typescript");
                expect(analysisRequests).toContain("sandbox-preflight-python");
            }
        }
    });

    it("preserves the real stderr and exit code from a shebang process", async () => {
        inheritedSessionStatus = process.env[SESSION_STATUS_ENV];
        delete process.env[SESSION_STATUS_ENV];
        fixture = await mkdtemp(resolve(fixtureRoot, ".zerobox-safe-bash-"));
        await mkdir(resolve(fixture, "package/node_modules"), {
            recursive: true,
        });
        const script = resolve(fixture, "failure.sh");
        await writeFile(
            script,
            "#!/bin/sh\nprintf 'real-safe-bash-error\\n' >&2\nexit 37\n",
        );
        await chmod(script, 0o755);

        await writeActivePolicy(testAgentDir, fixture, {
            environment: { path: [dirname(process.execPath)] },
        });
        session = await createTestSession({
            cwd: fixture,
            extensions: [sandboxExtension, BASH_EXECUTION_EXTENSION],
            propagateErrors: false,
        });
        const running = session.run(
            when("Run the failing script", [
                calls("safe_bash", { command: "./failure.sh" }),
                says("Failure observed."),
            ]),
        );
        const modelInputs: Array<{
            systemPrompt: string;
            messages: string;
        }> = [];
        const originalStream = session.session.agent.streamFunction;
        session.session.agent.streamFunction = (model, context, options) => {
            modelInputs.push({
                systemPrompt: context.systemPrompt ?? "",
                messages: JSON.stringify(context.messages),
            });
            return originalStream(model, context, options);
        };
        await running;

        const [result] = session.events.toolResultsFor("safe_bash");
        expect(result).toMatchObject({ isError: true, mocked: false });
        expect(result?.text).toBe(
            "real-safe-bash-error\n\n\nCommand exited with code 37",
        );
        expect(result?.details).toMatchObject({
            execution: {
                status: "sandboxed",
                profile: "bash-general",
                outcome: "failed",
                exitCode: 37,
            },
            sandboxExecutionContext: {
                version: 2,
                profile: "bash-general",
                network: {
                    loopback: {
                        hostNamespace: "isolated",
                        hostBridgePorts: [],
                        hostBridgeTransport: "disabled",
                        unlistedHostPorts: "blocked",
                    },
                },
            },
        });
        expect(modelInputs[0]?.systemPrompt).not.toContain("Sandbox execution context v1");
        expect(modelInputs[0]?.messages).toContain("Current shell execution context");
        expect(modelInputs[0]?.messages).toContain('analysis-strict');
        expect(modelInputs[0]?.messages).toContain(
            '\\"hostBridgePorts\\":[]',
        );
        expect(modelInputs.at(-1)?.messages).toContain(
            "real-safe-bash-error",
        );
        expect(modelInputs.at(-1)?.messages).toContain(
            "facts, not a causal diagnosis",
        );
        expect(
            modelInputs
                .at(-1)
                ?.messages.match(/facts, not a causal diagnosis/g),
        ).toHaveLength(1);
    }, 30_000);

    it("treats exit zero with stderr as a successful process", async () => {
        inheritedSessionStatus = process.env[SESSION_STATUS_ENV];
        delete process.env[SESSION_STATUS_ENV];
        fixture = await mkdtemp(resolve(fixtureRoot, ".zerobox-safe-bash-"));
        session = await createTestSession({
            cwd: fixture,
            extensions: [sandboxExtension, BASH_EXECUTION_EXTENSION],
            propagateErrors: false,
        });

        await session.run(
            when("Run a successful noisy command", [
                calls("safe_bash", {
                    command: "printf 'ordinary warning\\n' >&2; exit 0",
                }),
                says("Success observed."),
            ]),
        );

        const [result] = session.events.toolResultsFor("safe_bash");
        expect(result).toMatchObject({
            mocked: false,
            isError: false,
            details: {
                execution: {
                    status: "sandboxed",
                    outcome: "succeeded",
                    exitCode: 0,
                },
            },
        });
        expect(result?.text).toContain("ordinary warning");
        expect(result?.details).not.toHaveProperty("sandboxExecutionContext");
    }, 30_000);

    it("keeps git init config readable through the installed dynamic-deny runtime", async () => {
        inheritedSessionStatus = process.env[SESSION_STATUS_ENV];
        delete process.env[SESSION_STATUS_ENV];
        fixture = await mkdtemp(resolve(fixtureRoot, ".zerobox-safe-bash-"));
        session = await createTestSession({
            cwd: fixture,
            extensions: [sandboxExtension, BASH_EXECUTION_EXTENSION],
            propagateErrors: false,
        });

        await session.run(
            when("Initialize a Git repository", [
                calls("safe_bash", {
                    command: [
                        "git init -b dev repo >/dev/null",
                        "test -f repo/.git/config",
                        'test "$(git -C repo config --get core.repositoryformatversion)" = 0',
                        "cat repo/.git/config",
                    ].join(" && "),
                }),
                says("Git repository initialized."),
            ]),
        );

        const [result] = session.events.toolResultsFor("safe_bash");
        expect(result).toMatchObject({
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
        expect(result?.text).toContain("repositoryformatversion = 0");
    }, 30_000);

    it("keeps the host user D-Bus and systemctl user manager unavailable", async () => {
        inheritedSessionStatus = process.env[SESSION_STATUS_ENV];
        delete process.env[SESSION_STATUS_ENV];
        fixture = await mkdtemp(resolve(fixtureRoot, ".zerobox-safe-bash-"));
        session = await createTestSession({
            cwd: fixture,
            extensions: [sandboxExtension, BASH_EXECUTION_EXTENSION],
            propagateErrors: false,
        });
        const unixProbe = [
            "const net=require('node:net')",
            "const path='/run/user/'+process.getuid()+'/bus'",
            "const socket=net.createConnection(path)",
            "socket.once('connect',()=>process.exit(42))",
            "socket.once('error',()=>process.exit(0))",
            "setTimeout(()=>process.exit(43),2000)",
        ].join(";");

        await session.run(
            when("Check host user services", [
                calls("safe_bash", {
                    command: `! systemctl --user show-environment >/dev/null 2>&1 && /usr/bin/node -e ${JSON.stringify(unixProbe)}`,
                }),
                says("Isolation observed."),
            ]),
        );

        const [result] = session.events.toolResultsFor("safe_bash");
        expect(result).toMatchObject({
            mocked: false,
            isError: false,
            details: {
                execution: {
                    status: "sandboxed",
                    outcome: "succeeded",
                    exitCode: 0,
                },
            },
        });
    }, 30_000);

    it("keeps direct node_modules edits denied by Pi Permission System", async () => {
        fixture = await mkdtemp(resolve(fixtureRoot, ".zerobox-safe-bash-"));
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
        fixture = await mkdtemp(resolve(fixtureRoot, ".zerobox-safe-bash-"));
        session = await createTestSession({
            cwd: fixture,
            extensions: [PERMISSION_EXTENSION],
            propagateErrors: false,
        });

        const permissions = getPermissionsService();
        expect(permissions).toBeDefined();
        for (const surface of ["write", "edit"]) {
            for (const path of [
                "sandbox.json",
                "agent/sandbox.json",
                ".pi/agent/sandbox.json",
                resolve(AGENT_ROOT, "sandbox.json"),
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
        fixture = await mkdtemp(resolve(fixtureRoot, ".zerobox-safe-bash-"));
        const isolatedAgentDir = resolve(fixture, "agent");
        await mkdir(isolatedAgentDir);
        const authorityPath = resolve(
            isolatedAgentDir,
            "sandbox.json",
        );
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
        try {
            await writeActivePolicy(isolatedAgentDir, fixture);
            const authority = await readFile(authorityPath, "utf8");
            session = await createTestSession({
                cwd: fixture,
                extensions: [sandboxExtension, BASH_EXECUTION_EXTENSION],
                propagateErrors: false,
            });
            await session.run(
                when("Try to overwrite Docker authority", [
                    calls("safe_bash", {
                        command:
                            "printf compromised >agent/sandbox.json",
                    }),
                    says("Write result observed."),
                ]),
            );

            const [result] = session.events.toolResultsFor("safe_bash");
            expect(result).toMatchObject({ mocked: false, isError: true });
            expect(await readFile(authorityPath, "utf8")).toBe(authority);
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
        fixture = await mkdtemp(resolve(fixtureRoot, ".zerobox-safe-bash-"));
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
        await writeActivePolicy(testAgentDir, fixture, {
            environment: { path: [dirname(process.execPath)] },
            filesystem: { allowRead: [dirname(process.execPath)] },
        });
        session = await createTestSession({
            cwd: fixture, extensions: [sandboxExtension, BASH_EXECUTION_EXTENSION], propagateErrors: false,
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
