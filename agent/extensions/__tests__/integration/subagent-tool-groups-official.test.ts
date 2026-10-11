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
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { SubagentLaunchContractInput } from "pi-subagents/preflight";

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
    describe("official 0.77.0 public contracts", () => {
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
            expect(result.contract.protocol.packageVersion).toBe("0.77.0");
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

        test("native MCP selectors resolve against the live host registry", async () => {
            writeOverrides(agentDir, { scout: { tools: ["read", "mcp:fixture/echo"] } });
            const host: NonNullable<SubagentLaunchContractInput["runtimeSnapshotHost"]> = {
                events: { emit() {} },
                getCommands: () => [{ name: "mcp", sourceInfo: { path: "builtin:mcp" } }],
                getAllTools: () => [{ name: "mcp__fixture__echo", namespace: { name: "mcp__fixture" }, exposure: "codemode" }],
            };
            const launch = await contract("scout", { runtimeSnapshotHost: host });
            expect(launch.tools.effectiveMcpTools).toEqual(["mcp__fixture__echo"]);
        });
    });
}
