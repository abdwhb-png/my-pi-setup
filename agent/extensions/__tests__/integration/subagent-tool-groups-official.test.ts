import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
} from "bun:test";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerEntry } from "pi-mcp-adapter";
import type { SubagentLaunchContractInput } from "pi-subagents/preflight";
import { echoTool, startFixtureMcp } from "./fixtures/local-mcp.ts";

// Bun snapshots os.homedir() at process startup. Set HOME before spawning,
// not just before importing modules that read global agent/MCP configuration.
const fixtureHome = process.env.PI_SUBAGENTS_CONTRACT_HOME;
if (!fixtureHome) {
    test("official launch contracts in an isolated Bun process", () => {
        const home = mkdtempSync(join(tmpdir(), "subagent-official-contract-"));
        try {
            const child = spawnSync(
                process.execPath,
                ["test", "--isolate", import.meta.path],
                {
                    env: {
                        ...process.env,
                        HOME: home,
                        PI_SUBAGENTS_CONTRACT_HOME: home,
                        PI_CODING_AGENT_DIR: join(home, "agent"),
                        PI_MCP_ADAPTER_TEST_AUTH_STORE: "memory",
                        PI_MCP_ADAPTER_DISABLE_AUTH_CACHE: "1",
                    },
                    stdio: "inherit",
                    timeout: 60_000,
                },
            );
            if (child.error) throw child.error;
            expect(child.status).toBe(0);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    }, 65_000);
} else {
    describe("official 0.73.1 public contracts", () => {
        // Never load the historical hook-based addon.
        const environmentKeys = [
            "HOME",
            "PI_CODING_AGENT_DIR",
            "PI_OFFLINE",
            "PI_SUBAGENT_EXTRA_AGENT_DIRS",
        ] as const;
        const previousEnvironment = Object.fromEntries(
            environmentKeys.map((key) => [key, process.env[key]]),
        );
        const originalCwd = process.cwd();
        afterEach(() => process.chdir(originalCwd));
        let root: string;
        let agentDir: string;
        let cwd: string;
        let preflight: typeof import("pi-subagents/preflight");
        let adapterConfig: typeof import("pi-mcp-adapter/config");
        let adapterCache: typeof import("pi-mcp-adapter/metadata-cache");

        afterAll(() => {
            for (const key of environmentKeys) {
                const value = previousEnvironment[key];
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        });

        beforeAll(async () => {
            root = fixtureHome;
            expect(homedir()).toBe(root);
            process.env.PI_CODING_AGENT_DIR = join(root, "agent");
            process.env.PI_OFFLINE = "1";
            delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
            preflight = await import("pi-subagents/preflight");
            adapterConfig = await import("pi-mcp-adapter/config");
            adapterCache = await import("pi-mcp-adapter/metadata-cache");
            const adapterManifest = new URL(
                "./package.json",
                import.meta.resolve("pi-mcp-adapter"),
            );
            expect(
                JSON.parse(readFileSync(adapterManifest, "utf8")).version,
            ).toBe("3.0.0");
        }, 20_000);

        beforeEach(() => {
            const fixture = mkdtempSync(join(root, "case-"));
            agentDir = join(fixture, "agent");
            cwd = join(fixture, "project");
            mkdirSync(join(agentDir, "agents"), { recursive: true });
            mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
            process.env.PI_CODING_AGENT_DIR = agentDir;
            process.chdir(cwd);
        });

        function writeAgent(directory: string, name: string, tools?: string) {
            const source = `---\nname: ${name}\ndescription: Isolated contract fixture\n${tools === undefined ? "" : `tools: ${tools}\n`}---\nInspect only.\n`;
            const path = join(directory, `${name}.md`);
            writeFileSync(path, source);
            return { path, source };
        }

        function writeOverrides(
            directory: string,
            overrides: Record<string, { tools: string[] | "inherit" }>,
        ) {
            writeFileSync(
                join(directory, "settings.json"),
                JSON.stringify({ subagents: { agentOverrides: overrides } }),
            );
        }

        async function contract(
            agent: string,
            options: Partial<SubagentLaunchContractInput> = {},
        ) {
            const result = await preflight.resolveSubagentLaunchContract({
                agent,
                cwd,
                context: "fresh",
                skill: false,
                artifacts: false,
                intercomBridge: { mode: "off" },
                ...options,
            });
            if (!result.ok)
                throw new Error(`${result.code}: ${result.message}`);
            expect(result.contract.protocol.packageVersion).toBe("0.73.1");
            return result.contract;
        }

        test("baseline leaves Markdown group selectors unresolved without generated overrides", async () => {
            const file = writeAgent(
                join(agentDir, "agents"),
                "groups-baseline",
                '"@inspect"',
            );
            const launch = await contract("groups-baseline");
            expect(launch.tools.declaredBuiltin).toEqual(["@inspect"]);
            expect(launch.tools.requiredChildTools).toContain("@inspect");
            expect(launch.tools.requiredChildTools).not.toContain("read");
            expect(readFileSync(file.path, "utf8")).toBe(file.source);
        });

        test("ordinary overrides replace built-in and Markdown tools without changing sources", async () => {
            const file = writeAgent(
                join(agentDir, "agents"),
                "groups-custom",
                '"@inspect"',
            );
            writeOverrides(agentDir, {
                scout: { tools: ["read", "grep"] },
                "groups-custom": { tools: ["read", "grep"] },
            });
            for (const name of ["scout", "groups-custom"]) {
                const launch = await contract(name);
                expect(launch.tools.declaredBuiltin).toEqual(["read", "grep"]);
                expect(launch.tools.requiredChildTools).toEqual([
                    "read",
                    "grep",
                ]);
            }
            expect(readFileSync(file.path, "utf8")).toBe(file.source);
        });

        test("scope selects corresponding settings and project wins for both", async () => {
            writeAgent(join(agentDir, "agents"), "groups-scoped", '"@inspect"');
            writeAgent(
                join(cwd, ".pi", "agents"),
                "groups-scoped",
                '"@inspect"',
            );
            writeOverrides(agentDir, {
                scout: { tools: ["read"] },
                "groups-scoped": { tools: ["read"] },
            });
            writeOverrides(join(cwd, ".pi"), {
                scout: { tools: ["grep"] },
                "groups-scoped": { tools: ["grep"] },
            });
            for (const name of ["scout", "groups-scoped"]) {
                expect(
                    (await contract(name, { agentScope: "user" })).tools
                        .declaredBuiltin,
                ).toEqual(["read"]);
                expect(
                    (await contract(name, { agentScope: "project" })).tools
                        .declaredBuiltin,
                ).toEqual(["grep"]);
                expect(
                    (await contract(name, { agentScope: "both" })).tools
                        .declaredBuiltin,
                ).toEqual(["grep"]);
            }
        });

        test("project inherit neutralizes a lower-scope generated tools override", async () => {
            writeAgent(
                join(agentDir, "agents"),
                "groups-shadowed",
                '"@inspect"',
            );
            writeAgent(join(cwd, ".pi", "agents"), "groups-shadowed");
            writeOverrides(agentDir, {
                "groups-shadowed": { tools: ["grep"] },
            });
            writeOverrides(join(cwd, ".pi"), {
                "groups-shadowed": { tools: "inherit" },
            });
            const launch = await contract("groups-shadowed");
            expect(launch.tools.explicitAllowlist).toBe(false);
            expect(launch.agent.source).toBe("project");
        });

        test("upstream capability ceiling still narrows concrete overrides", async () => {
            writeOverrides(agentDir, { scout: { tools: ["read", "grep"] } });
            const launch = await contract("scout", {
                capabilityCeiling: {
                    version: 1,
                    allowedTools: ["read"],
                    denyExtensions: false,
                    sources: ["contract-test"],
                },
            });
            expect(launch.tools.requestedBuiltin).toEqual(["read", "grep"]);
            expect(launch.tools.declaredBuiltin).toEqual(["read"]);
            expect(launch.tools.effectiveAllowlist).toContain("read");
            expect(launch.tools.effectiveAllowlist).not.toContain("grep");
        });

        test("MCP override selectors use upstream resolution rather than native tool names", async () => {
            writeOverrides(agentDir, {
                scout: { tools: ["read", "mcp:fixture/echo"] },
            });
            const result = await preflight.resolveSubagentLaunchContract({
                agent: "scout",
                cwd,
                context: "fresh",
                skill: false,
                artifacts: false,
            });
            expect(result.ok).toBe(false);
            if (result.ok)
                throw new Error(
                    "Expected missing MCP fixture metadata to fail closed",
                );
            expect(result.code).toBe("denied_required_tool");
            expect(result.message).toContain("fixture/echo");
            expect(result.message).toContain("MCP");
        });

        const transportCases: Array<{
            transport: string;
            server: ServerEntry;
        }> = [
            {
                transport: "stdio",
                server: { command: "never-executed-mcp-fixture", args: [] },
            },
            {
                transport: "http",
                server: { url: "http://127.0.0.1:12345/mcp" },
            },
        ];
        test.each(transportCases)(
            "adapter 3.0 and subagents 0.73.1 share migrated $transport config and metadata",
            async ({ server }) => {
                writeFileSync(
                    join(agentDir, "mcp.json"),
                    JSON.stringify({ mcpServers: { fixture: server } }),
                );
                adapterCache.saveMetadataCache({
                    version: 1,
                    servers: {
                        fixture: {
                            configHash: adapterCache.computeServerHash(server),
                            cachedAt: Date.now(),
                            tools: [{ name: "echo" }],
                            resources: [],
                        },
                    },
                });
                writeOverrides(agentDir, {
                    scout: { tools: ["read", "mcp:fixture/echo"] },
                });
                expect(
                    adapterConfig.loadMcpConfig(undefined, cwd).mcpServers
                        .fixture,
                ).toBeUndefined();
                const legacy = await preflight.resolveSubagentLaunchContract({
                    agent: "scout",
                    cwd,
                    context: "fresh",
                    skill: false,
                    artifacts: false,
                });
                expect(legacy.ok).toBe(false);
                if (legacy.ok)
                    throw new Error(
                        "Expected upstream to ignore the legacy Pi MCP config",
                    );
                expect(legacy.code).toBe("denied_required_tool");
                expect(legacy.message).toContain(
                    "Unresolved MCP direct-tool selectors: fixture/echo",
                );

                renameSync(
                    join(agentDir, "mcp.json"),
                    join(agentDir, "mcp-adapter.json"),
                );
                expect(
                    adapterConfig.loadMcpConfig(undefined, cwd).mcpServers
                        .fixture,
                ).toEqual(server);
                const cacheEntry =
                    adapterCache.loadMetadataCache()?.servers.fixture;
                if (!cacheEntry)
                    throw new Error("Adapter did not persist fixture metadata");
                expect(
                    adapterCache.isServerCacheValid(cacheEntry, server),
                ).toBe(true);
                const migrated = await contract("scout");
                expect(migrated.tools.effectiveMcpTools).toEqual([
                    "fixture_echo",
                ]);

                const commonDirectory = join(root, ".config", "mcp");
                const commonPath = join(commonDirectory, "mcp.json");
                mkdirSync(commonDirectory, { recursive: true });
                renameSync(join(agentDir, "mcp-adapter.json"), commonPath);
                try {
                    expect(
                        adapterConfig.loadMcpConfig(undefined, cwd).mcpServers
                            .fixture,
                    ).toEqual(server);
                    expect(
                        (await contract("scout")).tools.effectiveMcpTools,
                    ).toEqual(["fixture_echo"]);
                } finally {
                    rmSync(commonPath);
                }
            },
        );

        test("adapter executes real HTTP MCP tools and QuickJS scripts through Pi", async () => {
            const callsObserved: string[] = [];
            const tool = echoTool;
            const server = startFixtureMcp(callsObserved);
            const definition = { url: `${server.url}mcp`, directTools: true };
            const { createTestSession, when, calls, says } =
                await import("@abdwhb-png/pi-test-harness");
            let session:
                | Awaited<ReturnType<typeof createTestSession>>
                | undefined;
            try {
                writeFileSync(
                    join(agentDir, "mcp-adapter.json"),
                    JSON.stringify({
                        mcpServers: { fixture: definition },
                        settings: { scriptMode: true },
                    }),
                );
                adapterCache.saveMetadataCache({
                    version: 1,
                    servers: {
                        fixture: {
                            configHash:
                                adapterCache.computeServerHash(definition),
                            cachedAt: Date.now(),
                            tools: [tool],
                            resources: [],
                        },
                    },
                });
                session = await createTestSession({
                    cwd,
                    extensions: [
                        fileURLToPath(import.meta.resolve("pi-mcp-adapter")),
                    ],
                });
                await session.run(
                    when("Exercise the local fixture", [
                        calls("fixture_echo", { message: "direct" }),
                        calls("mcpScript", {
                            code: 'const r = await tools.call("fixture_echo", { message: "script" }); emit(r); emit({ processType: typeof process });',
                        }),
                        says("done"),
                    ]),
                );
                expect(
                    session.events.toolResultsFor("fixture_echo")[0]?.isError,
                ).toBe(false);
                expect(
                    session.events.toolResultsFor("fixture_echo")[0]?.text,
                ).toContain("echo:direct");
                const script = session.events.toolResultsFor("mcpScript")[0];
                expect(script?.isError).toBe(false);
                expect(script?.text).toContain("echo:script");
                expect(script?.text).toContain('"processType": "undefined"');
                expect(callsObserved).toEqual(["direct", "script"]);
            } finally {
                if (session) {
                    await session.session.extensionRunner.emit({
                        type: "session_shutdown",
                        reason: "quit",
                    });
                    session.dispose();
                }
                await server.stop(true);
            }
        }, 30_000);

        test.each([
            { scope: "global", approved: true, trusted: true },
            { scope: "project", approved: true, trusted: true },
            { scope: "project", approved: false, trusted: true },
            { scope: "project", approved: true, trusted: false },
        ])(
            "real stdio server: $scope config, approval=$approved, trusted=$trusted",
            async ({ scope, approved, trusted }) => {
                const scriptPath = join(cwd, "stdio-fixture.mjs");
                const requestsPath = join(cwd, "requests.jsonl");
                writeFileSync(
                    scriptPath,
                    `
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const log = (event) => appendFileSync(process.argv[2], JSON.stringify(event) + "\\n");
log({ runtime: process.versions.bun });
const tool = { name: "echo", description: "Echo fixture input", inputSchema: {
    type: "object", properties: { message: { type: "string" } }, required: ["message"]
} };
for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    log({ method: request.method, params: request.params });
    if (request.id === undefined) continue;
    let result;
    switch (request.method) {
        case "initialize": result = { protocolVersion: request.params.protocolVersion,
            capabilities: { tools: {} }, serverInfo: { name: "stdio-fixture", version: "1" } }; break;
        case "tools/list": result = { tools: [tool] }; break;
        case "tools/call": result = { content: [{ type: "text", text: "echo:" + request.params.arguments.message }] }; break;
        case "ping": result = {}; break;
        default:
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id,
                error: { code: -32601, message: "Unsupported fixture method" } }) + "\\n");
            continue;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
}
`,
                );
                const definition = {
                    command: process.execPath,
                    args: [scriptPath, requestsPath],
                    directTools: true,
                };
                const configPath = join(
                    scope === "global" ? agentDir : join(cwd, ".pi"),
                    "mcp-adapter.json",
                );
                const configText = JSON.stringify({
                    mcpServers: { fixture: definition },
                });
                if (trusted) writeFileSync(configPath, configText);
                const { createTestSession, when, calls, says } =
                    await import("@abdwhb-png/pi-test-harness");
                let session:
                    | Awaited<ReturnType<typeof createTestSession>>
                    | undefined;
                try {
                    session = await createTestSession({
                        cwd,
                        extensions: [
                            fileURLToPath(
                                import.meta.resolve("pi-mcp-adapter"),
                            ),
                        ],
                        mockUI: { confirm: approved },
                    });
                    if (!trusted) {
                        session.session.settingsManager.setProjectTrusted(
                            false,
                        );
                        writeFileSync(configPath, configText);
                        await session.session.reload();
                    }
                    await session.run(
                        when("Call the stdio fixture", [
                            calls("mcp", {
                                server: "fixture",
                                tool: "echo",
                                args: { message: "stdio" },
                            }),
                            says("done"),
                        ]),
                    );
                    const result = session.events.toolResultsFor("mcp")[0];
                    expect(session.events.uiCallsFor("confirm")).toHaveLength(
                        scope === "project" && trusted ? 1 : 0,
                    );
                    if (!approved || !trusted) {
                        // Adapter reports admission refusal in details, not Pi's execution-error flag.
                        expect(result?.details).toMatchObject({
                            error: "server_disabled",
                            server: "fixture",
                        });
                        expect(result?.text).toContain(
                            trusted
                                ? "approval denied"
                                : "blocked by project trust",
                        );
                        expect(existsSync(requestsPath)).toBe(false);
                        expect(readFileSync(configPath, "utf8")).toBe(
                            configText,
                        );
                        return;
                    }
                    expect(result?.isError).toBe(false);
                    expect(result?.text).toContain("echo:stdio");
                    // Cold start: cache comes from real discovery, not a synthetic hash fixture.
                    const cache =
                        adapterCache.loadMetadataCache()?.servers.fixture;
                    if (!cache)
                        throw new Error(
                            "Real stdio discovery did not persist metadata",
                        );
                    expect(
                        adapterCache.isServerCacheValid(cache, definition),
                    ).toBe(true);
                    writeOverrides(agentDir, {
                        scout: { tools: ["read", "mcp:fixture/echo"] },
                    });
                    expect(
                        (await contract("scout")).tools.effectiveMcpTools,
                    ).toEqual(["fixture_echo"]);
                    await session.session.reload();
                    await session.run(
                        when("Call after reload", [
                            calls("fixture_echo", { message: "reloaded" }),
                            says("done"),
                        ]),
                    );
                    expect(
                        session.events.toolResultsFor("fixture_echo")[0]
                            ?.isError,
                    ).toBe(false);
                    expect(
                        session.events.toolResultsFor("fixture_echo")[0]?.text,
                    ).toContain("echo:reloaded");
                    // Approved project definition is not prompted again in the same checkout.
                    expect(session.events.uiCallsFor("confirm")).toHaveLength(
                        scope === "project" ? 1 : 0,
                    );
                    const requests = readFileSync(requestsPath, "utf8")
                        .trim()
                        .split("\n")
                        .map((line) => JSON.parse(line));
                    expect(
                        requests
                            .filter((event) => event.runtime)
                            .map((event) => event.runtime),
                    ).toContain(process.versions.bun);
                    expect(
                        requests
                            .filter((event) => event.method === "tools/call")
                            .map((event) => event.params.arguments.message),
                    ).toEqual(["stdio", "reloaded"]);
                    expect(readFileSync(configPath, "utf8")).toBe(configText);
                } finally {
                    if (session) {
                        await session.session.extensionRunner.emit({
                            type: "session_shutdown",
                            reason: "quit",
                        });
                        session.dispose();
                    }
                }
            },
            30_000,
        );

        test("migrated config preserves credential fields and project precedence", async () => {
            const globalDefinition = {
                url: "http://127.0.0.1:12345/global",
                auth: "bearer" as const,
                bearerToken: "qualification-only-not-a-secret",
                headers: { "X-Fixture": "global" },
            };
            const projectDefinition = {
                url: "http://127.0.0.1:12345/project",
                auth: "bearer" as const,
                bearerToken: "qualification-project-not-a-secret",
                headers: { "X-Fixture": "project" },
            };
            const globalPath = join(agentDir, "mcp-adapter.json");
            const projectPath = join(cwd, ".pi", "mcp-adapter.json");
            const globalText = JSON.stringify({
                mcpServers: {
                    retained: globalDefinition,
                    fixture: globalDefinition,
                },
            });
            const projectText = JSON.stringify({
                mcpServers: { fixture: projectDefinition },
            });
            writeFileSync(globalPath, globalText);
            writeFileSync(projectPath, projectText);
            const loaded = adapterConfig.loadMcpConfigWithSources(
                undefined,
                cwd,
            );
            expect(loaded.config.mcpServers).toEqual({
                retained: globalDefinition,
                fixture: projectDefinition,
            });
            expect([...loaded.projectServers.keys()]).toEqual(["fixture"]);
            adapterCache.saveMetadataCache({
                version: 1,
                servers: {
                    fixture: {
                        configHash:
                            adapterCache.computeServerHash(projectDefinition),
                        cachedAt: Date.now(),
                        tools: [{ name: "echo" }],
                        resources: [],
                    },
                },
            });
            writeOverrides(agentDir, {
                scout: { tools: ["mcp:fixture/echo"] },
            });
            expect((await contract("scout")).tools.effectiveMcpTools).toEqual([
                "fixture_echo",
            ]);
            expect(readFileSync(globalPath, "utf8")).toBe(globalText);
            expect(readFileSync(projectPath, "utf8")).toBe(projectText);
        });

        test("project config cannot authorize its own servers", () => {
            writeFileSync(
                join(cwd, ".pi", "mcp-adapter.json"),
                JSON.stringify({
                    mcpServers: { fixture: { command: "never-executed" } },
                    settings: { projectServers: "allow" },
                }),
            );
            const loaded = adapterConfig.loadMcpConfigWithSources(
                undefined,
                cwd,
            );
            expect(loaded.projectServerPolicy).toBe("ask");
            expect(loaded.projectServers.has("fixture")).toBe(true);
        });

        test("quoted comma selectors and YAML block lists preserve selector order", async () => {
            writeAgent(
                join(agentDir, "agents"),
                "groups-quoted",
                '"read, grep"',
            );
            writeAgent(
                join(agentDir, "agents"),
                "groups-block",
                "\n  - read\n  - grep",
            );
            for (const name of ["groups-quoted", "groups-block"]) {
                expect((await contract(name)).tools.declaredBuiltin).toEqual([
                    "read",
                    "grep",
                ]);
            }
        });
    });
}
