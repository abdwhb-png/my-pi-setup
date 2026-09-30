import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
    JsonAgentSessionEvent,
    RpcResponse,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedSubagentCapabilityCeiling } from "pi-subagents/capability-ceiling";
import type { resolveSubagentLaunchContract } from "pi-subagents/preflight";
import type {
    SubagentAsyncCompletion,
    SubagentRpcToolResult,
} from "../../_shared/subagents/rpc-client.ts";
import { startFixtureMcp } from "./fixtures/local-mcp.ts";
import { publicExtensionEntrypoint } from "./public-extension-session.ts";

type CliEvent =
    | JsonAgentSessionEvent
    | RpcResponse
    | {
          type: "fixture_ready";
          reason: string;
          runtime: string;
          pid: number;
          sdkRoot: string;
          entrypoint: string;
          tools: string[];
      }
    | { type: "fixture_addon_factory" }
    | {
          type: "fixture_upstream_ready";
          ceiling?: ResolvedSubagentCapabilityCeiling;
          generatedTools?: string[];
      }
    | {
          type: "fixture_contract";
          ceiling?: ResolvedSubagentCapabilityCeiling;
          result: Awaited<ReturnType<typeof resolveSubagentLaunchContract>>;
      }
    | { type: "fixture_rpc"; error?: string; result?: SubagentRpcToolResult }
    | { type: "fixture_complete"; completion: SubagentAsyncCompletion };

test.skipIf(process.env.PI_SUBAGENTS_OFFICIAL_SMOKE !== "1")(
    "promoted CLI enforces generated tools and revives the stored async MCP contract",
    async () => {
        const root = mkdtempSync(join(tmpdir(), "subagent-addon-cli-"));
        const cwd = join(root, "project");
        const agentDir = join(root, "agent");
        const officialRoot = dirname(
            realpathSync(fileURLToPath(import.meta.resolve("pi-subagents"))),
        );
        expect(
            JSON.parse(readFileSync(join(officialRoot, "package.json"), "utf8"))
                .version,
        ).toBe("0.73.1");
        mkdirSync(cwd);
        mkdirSync(join(agentDir, "agents"), { recursive: true });
        const markdown =
            "---\nname: reader\ndescription: Offline fixture\ntools: '@inspect'\n---\nReply fixture-child-complete.\n";
        const agentPath = join(agentDir, "agents", "reader.md");
        writeFileSync(agentPath, markdown);
        writeFileSync(
            join(agentDir, "tool-groups.json"),
            JSON.stringify({ groups: { inspect: ["read", "grep"] } }),
        );
        const configPath = join(root, "addon.json");
        writeFileSync(configPath, "{");
        const wrapper = join(root, "fixture-addon.ts");
        writeFileSync(
            wrapper,
            `import register from ${JSON.stringify(publicExtensionEntrypoint("pi-subagents-addons"))}; export default pi => { console.log(JSON.stringify({type:'fixture_addon_factory'})); register(pi, ${JSON.stringify(configPath)}); };`,
        );
        // Explicit global extension must precede package resources and be deduplicated
        // when the same entry is also discovered in the global extensions directory.
        mkdirSync(join(agentDir, "extensions"));
        symlinkSync(wrapper, join(agentDir, "extensions", "addon.ts"));
        const provider = join(
            import.meta.dir,
            "fixtures",
            "subagent-lifecycle-provider.ts",
        );
        const childTools = join(
            import.meta.dir,
            "fixtures",
            "subagent-child-tools.ts",
        );
        const probeMarkdown = `---\nname: probe\ndescription: Tool execution fixture\ntools: '@inspect, fixture_ping'\nexcludeTools: grep\nsubagentOnlyExtensions: ${childTools}\n---\nExercise tool contract.\n`;
        writeFileSync(join(agentDir, "agents", "probe.md"), probeMarkdown);
        writeFileSync(join(cwd, "proof.txt"), "native-call-proof");
        const adapter = realpathSync(
            fileURLToPath(import.meta.resolve("pi-mcp-adapter")),
        );
        expect(
            JSON.parse(
                readFileSync(join(dirname(adapter), "package.json"), "utf8"),
            ).version,
        ).toBe("3.0.0");
        const mcpMarkdown = `---\nname: mcp-probe\ndescription: Async MCP fixture\ntools: '@inspect, fixture_ping, mcp:fixture/echo'\nexcludeTools: grep\nextensions: []\nsubagentOnlyExtensions:\n  - ${childTools}\n  - ${adapter}\n---\nExercise tools then wait for interrupt.\n`;
        writeFileSync(join(agentDir, "agents", "mcp-probe.md"), mcpMarkdown);
        const mcpCalls: string[] = [];
        const server = startFixtureMcp(mcpCalls);
        writeFileSync(
            join(agentDir, "mcp-adapter.json"),
            JSON.stringify({
                mcpServers: {
                    fixture: { url: `${server.url}mcp`, directTools: true },
                },
            }),
        );
        writeFileSync(
            join(agentDir, "settings.json"),
            JSON.stringify({
                packages: [officialRoot, dirname(adapter)],
                extensions: [wrapper, provider, childTools],
                subagents: {
                    control: { enabled: false },
                    intercomBridge: { mode: "off" },
                    subagentOnlyExtensions: [provider],
                },
            }),
        );
        const child = spawn(
            process.execPath,
            [
                process.env.PI_TEST_CLI ?? join(homedir(), ".pi", "bin", "pi"),
                "--mode",
                "rpc",
                "--offline",
                "--no-session",
                "--no-skills",
                "--no-prompt-templates",
                "--no-themes",
                "--no-context-files",
                "--no-approve",
                "--provider",
                "fixture",
                "--model",
                "deterministic",
            ],
            {
                cwd,
                env: {
                    PATH: process.env.PATH,
                    HOME: root,
                    PI_CODING_AGENT_DIR: agentDir,
                    PI_PACKAGE_FINALIZER_ACTIVE: "1",
                    PI_OFFLINE: "1",
                    PI_SUBAGENTS_TEMP_ROOT: join(root, "runs"),
                },
                detached: true,
                stdio: ["pipe", "pipe", "pipe"],
            },
        );
        let stdout = "";
        let stderr = "";
        let sequence = 0;
        let pendingRun: string | undefined;
        let pendingDir: string | undefined;
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        const exited = once(child, "exit");
        function events(): CliEvent[] {
            return stdout
                .split("\n")
                .filter((line) => line.startsWith("{") && line.endsWith("}"))
                .map((line) => JSON.parse(line));
        }
        async function waitFor<T extends CliEvent>(
            predicate: (event: CliEvent) => event is T,
            offset = 0,
        ) {
            const deadline = Date.now() + 45000;
            while (Date.now() < deadline) {
                const found = events().slice(offset).find(predicate);
                if (found) return found;
                if (child.exitCode !== null) break;
                await Bun.sleep(20);
            }
            throw new Error(
                `Missing CLI event; stdout=${stdout.slice(-7000)} stderr=${stderr.slice(-3000)}`,
            );
        }
        async function prompt(message: string) {
            const id = `fixture-${++sequence}`;
            child.stdin.write(
                JSON.stringify({ id, type: "prompt", message }) + "\n",
            );
            const response = await waitFor(
                (event): event is RpcResponse =>
                    event.type === "response" && event.id === id,
            );
            expect(response.success).toBe(true);
        }
        try {
            const ready = await waitFor(
                (event) => event.type === "fixture_ready",
            );
            expect(ready.runtime).toBeTruthy();
            expect(
                ready.tools.filter((name: string) => name === "subagent"),
            ).toHaveLength(1);
            expect(
                events().filter(
                    (event) => event.type === "fixture_addon_factory",
                ),
            ).toHaveLength(1);
            const upstreamBlocked = await waitFor(
                (event) => event.type === "fixture_upstream_ready",
            );
            expect(upstreamBlocked.ceiling?.allowedAgents).toEqual([]);
            await prompt("/fixture-contract");
            const blocked = await waitFor(
                (event) => event.type === "fixture_contract",
            );
            expect(blocked.ceiling?.allowedAgents).toEqual([]);
            await prompt("/fixture-arm");
            const turnOffset = events().length;
            await prompt("Run fixture delegation");
            await waitFor((event) => event.type === "agent_end", turnOffset);
            const deniedTool = events()
                .slice(turnOffset)
                .find(
                    (event) =>
                        event.type === "tool_execution_end" &&
                        event.toolName === "subagent",
                );
            expect(JSON.stringify(deniedTool)).toContain(
                "does not allow agent",
            );
            const rpcOffset = events().length;
            await prompt("/fixture-rpc");
            const deniedRpc = await waitFor(
                (event) => event.type === "fixture_rpc",
                rpcOffset,
            );
            expect(JSON.stringify(deniedRpc)).toContain("does not allow agent");
            writeFileSync(
                configPath,
                JSON.stringify({
                    toolGroupOverrides: {
                        enabled: true,
                        userAgentDirs: ["agents"],
                        projectAgentDirs: [],
                        agentTools: {},
                    },
                }),
            );
            const reloadOffset = events().length;
            await prompt("/fixture-reload");
            await waitFor(
                (event) => event.type === "fixture_ready",
                reloadOffset,
            );
            expect(
                events()
                    .slice(reloadOffset)
                    .filter((event) => event.type === "fixture_addon_factory"),
            ).toHaveLength(1);
            const upstreamAllowed = await waitFor(
                (event) => event.type === "fixture_upstream_ready",
                reloadOffset,
            );
            expect(upstreamAllowed.ceiling).toBeUndefined();
            expect(upstreamAllowed.generatedTools).toEqual(["read", "grep"]);
            const contractOffset = events().length;
            await prompt("/fixture-contract");
            const allowed = await waitFor(
                (event) => event.type === "fixture_contract",
                contractOffset,
            );
            expect(allowed.ceiling).toBeUndefined();
            expect(allowed.result.ok).toBe(true);
            if (!allowed.result.ok) throw new Error(allowed.result.message);
            expect(allowed.result.contract.tools.declaredBuiltin).toEqual([
                "read",
                "grep",
            ]);
            await prompt("/fixture-foreground");
            const foregroundOffset = events().length;
            await prompt("Execute foreground probe");
            await waitFor(
                (event) => event.type === "agent_end",
                foregroundOffset,
            );
            const foreground = events()
                .slice(foregroundOffset)
                .find(
                    (
                        event,
                    ): event is Extract<
                        JsonAgentSessionEvent,
                        { type: "tool_execution_end" }
                    > =>
                        event.type === "tool_execution_end" &&
                        event.toolName === "subagent",
                );
            expect(
                foreground?.isError,
                JSON.stringify(foreground?.result),
            ).toBe(false);
            const evidence = JSON.stringify(foreground?.result);
            expect(evidence).toContain("child-tool-contract");
            expect(evidence).toContain("native-call-proof");
            expect(evidence).toContain("extension-call-proof");
            expect(evidence).toContain("not found");
            expect(evidence).toContain(String(ready.pid));
            expect(() => readFileSync(join(cwd, "forbidden.txt"))).toThrow(
                "ENOENT",
            );
            expect(
                readFileSync(join(agentDir, "agents", "probe.md"), "utf8"),
            ).toBe(probeMarkdown);
            const foregroundEvidence = JSON.parse(
                readFileSync(join(cwd, "child-evidence.jsonl"), "utf8").trim(),
            );
            expect(foregroundEvidence.pid).toBe(ready.pid);
            expect(foregroundEvidence.tools).toContain("read");
            expect(foregroundEvidence.tools).toContain("fixture_ping");
            expect(foregroundEvidence.tools).not.toContain("grep");
            expect(foregroundEvidence.tools).not.toContain("write");
            expect(
                foregroundEvidence.tools.some((name: string) =>
                    name.startsWith("@"),
                ),
            ).toBe(false);
            await prompt("/fixture-warm-mcp");
            const warmOffset = events().length;
            await prompt("Warm MCP metadata");
            await waitFor((event) => event.type === "agent_end", warmOffset);
            expect(mcpCalls).toEqual(["warm"]);
            expect(existsSync(join(agentDir, "mcp-cache.json"))).toBe(true);
            const launchOffset = events().length;
            await prompt("/fixture-rpc");
            const completed = await waitFor(
                (event) => event.type === "fixture_rpc",
                launchOffset,
            );
            expect(completed.error).toBeUndefined();
            expect(completed.result?.isError).not.toBe(true);
            if (typeof completed.result?.details?.asyncId === "string")
                pendingRun = completed.result.details.asyncId;
            if (typeof completed.result?.details?.asyncDir === "string")
                pendingDir = completed.result.details.asyncDir;
            const completion = await waitFor(
                (event) => event.type === "fixture_complete",
                launchOffset,
            );
            pendingRun = undefined;
            expect(JSON.stringify(completion)).toContain(
                "fixture-child-complete",
            );
            expect(completion.completion.results).toHaveLength(1);
            expect(completion.completion.results?.[0]?.success).toBe(true);
            expect(readFileSync(agentPath, "utf8")).toBe(markdown);

            const mcpOffset = events().length;
            await prompt("/fixture-rpc mcp");
            const mcpStarted = await waitFor(
                (event) => event.type === "fixture_rpc",
                mcpOffset,
            );
            expect(
                mcpStarted.error,
                JSON.stringify(mcpStarted),
            ).toBeUndefined();
            const mcpDetails = mcpStarted.result?.details;
            const runId = mcpDetails?.asyncId;
            const asyncDir = mcpDetails?.asyncDir;
            if (typeof runId !== "string" || typeof asyncDir !== "string")
                throw new Error(
                    `Missing async launch identity: ${JSON.stringify(mcpStarted)}`,
                );
            pendingRun = runId;
            pendingDir = asyncDir;
            const evidencePath = join(cwd, "child-evidence.jsonl");
            const deadline = Date.now() + 45000;
            while (
                readFileSync(evidencePath, "utf8").trim().split("\n").length <
                    2 &&
                Date.now() < deadline
            )
                await Bun.sleep(30);
            const asyncEvidence = JSON.parse(
                readFileSync(evidencePath, "utf8").trim().split("\n")[1] ??
                    "null",
            );
            expect(
                asyncEvidence,
                JSON.stringify(events().slice(mcpOffset)),
            ).not.toBeNull();
            expect(asyncEvidence.pid).not.toBe(ready.pid);
            // Approved upstream exception: npm async runner explicitly selects Node.
            expect(asyncEvidence.runtime).toBeUndefined();
            expect(asyncEvidence.node).toBeTruthy();
            expect(basename(asyncEvidence.executable)).toBe("node");
            expect(realpathSync(fileURLToPath(asyncEvidence.sdk))).toBe(
                realpathSync(join(ready.sdkRoot, "dist", "index.js")),
            );
            expect(realpathSync(ready.entrypoint)).toBe(
                realpathSync(join(ready.sdkRoot, "dist", "bun", "cli.js")),
            );
            expect(
                dirname(realpathSync(fileURLToPath(asyncEvidence.subagents))),
            ).toBe(officialRoot);
            expect(asyncEvidence.childMarker).toBe("1");
            expect(asyncEvidence.tools).toEqual(
                expect.arrayContaining([
                    "read",
                    "fixture_ping",
                    "fixture_echo",
                ]),
            );
            expect(asyncEvidence.tools).not.toContain("grep");
            expect(asyncEvidence.tools).not.toContain("write");
            expect(
                asyncEvidence.tools.some((name: string) =>
                    name.startsWith("@"),
                ),
            ).toBe(false);
            expect(mcpCalls).toEqual(["warm", "initial"]);
            expect(JSON.stringify(asyncEvidence.results)).toContain(
                "echo:initial",
            );
            expect(
                asyncEvidence.results.map(
                    (result: { toolName: string; isError: boolean }) => [
                        result.toolName,
                        result.isError,
                    ],
                ),
            ).toEqual([
                ["read", false],
                ["fixture_ping", false],
                ["write", true],
                ["fixture_echo", false],
            ]);
            expect(existsSync(join(cwd, "forbidden.txt"))).toBe(false);
            const recovery = JSON.parse(
                readFileSync(
                    join(asyncDir, "recovery-descriptor.json"),
                    "utf8",
                ),
            );
            expect(recovery.tools).toEqual(["read", "grep", "fixture_ping"]);
            expect(recovery.excludeTools).toEqual(["grep"]);
            expect(recovery.mcpDirectTools).toEqual(["fixture/echo"]);
            // The bootstrap deletes async-cfg after loading it; recovery-descriptor is durable.
            expect(recovery.sourceRunId).toBe(runId);
            expect(recovery.sessionFile).toEndWith(".jsonl");
            const interruptOffset = events().length;
            await prompt(`/fixture-interrupt ${runId}`);
            const interrupted = await waitFor(
                (event) => event.type === "fixture_rpc",
                interruptOffset,
            );
            expect(
                interrupted.error,
                JSON.stringify(interrupted),
            ).toBeUndefined();
            await waitFor(
                (event) => event.type === "fixture_complete",
                interruptOffset,
            );
            pendingRun = undefined;
            const paused = JSON.parse(
                readFileSync(join(asyncDir, "status.json"), "utf8"),
            );
            expect(paused.steps[0].sessionFile).toBe(recovery.sessionFile);
            expect(paused.launchContractDigest).toBe(
                recovery.launchContractDigest,
            );
            const persistedSession = readFileSync(recovery.sessionFile, "utf8");
            expect(persistedSession).toContain("echo:initial");
            expect(persistedSession).toContain("native-call-proof");
            writeFileSync(
                join(agentDir, "tool-groups.json"),
                JSON.stringify({ groups: { inspect: ["ls"] } }),
            );
            const changedOffset = events().length;
            await prompt("/fixture-reload");
            const changed = await waitFor(
                (event) => event.type === "fixture_upstream_ready",
                changedOffset,
            );
            expect(changed.generatedTools).toEqual(["ls"]);
            const newContractOffset = events().length;
            await prompt("/fixture-contract");
            const newContract = await waitFor(
                (event) => event.type === "fixture_contract",
                newContractOffset,
            );
            expect(newContract.result.ok).toBe(true);
            if (!newContract.result.ok)
                throw new Error(newContract.result.message);
            expect(newContract.result.contract.tools.declaredBuiltin).toEqual([
                "ls",
            ]);
            const resumeOffset = events().length;
            await prompt(`/fixture-resume ${runId}`);
            const resumed = await waitFor(
                (event) => event.type === "fixture_rpc",
                resumeOffset,
            );
            expect(resumed.error, JSON.stringify(resumed)).toBeUndefined();
            const revivedId = resumed.result?.details?.asyncId;
            if (typeof revivedId === "string") pendingRun = revivedId;
            if (typeof resumed.result?.details?.asyncDir === "string")
                pendingDir = resumed.result.details.asyncDir;
            const revived = await waitFor(
                (event) => event.type === "fixture_complete",
                resumeOffset,
            );
            pendingRun = undefined;
            expect(
                revived.completion.results?.[0]?.success,
                JSON.stringify(revived),
            ).toBe(true);
            const revivedEvidence = JSON.parse(
                readFileSync(evidencePath, "utf8").trim().split("\n").at(-1)!,
            );
            expect(revivedEvidence.phase).toBe("revived");
            expect(revivedEvidence.pid).not.toBe(asyncEvidence.pid);
            expect(
                revivedEvidence.results
                    .slice(-4)
                    .map((result: { toolName: string; isError: boolean }) => [
                        result.toolName,
                        result.isError,
                    ]),
            ).toEqual([
                ["read", false],
                ["fixture_ping", false],
                ["write", true],
                ["fixture_echo", false],
            ]);
            expect(existsSync(join(cwd, "forbidden.txt"))).toBe(false);
            expect(revivedEvidence.tools).toEqual(asyncEvidence.tools);
            expect(revivedEvidence.tools).not.toContain("ls");
            expect(mcpCalls).toEqual(["warm", "initial", "revived"]);
            expect(
                readFileSync(join(agentDir, "agents", "mcp-probe.md"), "utf8"),
            ).toBe(mcpMarkdown);
        } catch (error) {
            if (pendingDir) {
                for (const name of [
                    "runner.stderr.log",
                    "runner.stdout.log",
                    "status.json",
                ]) {
                    const path = join(pendingDir, name);
                    if (existsSync(path))
                        console.error(
                            `Fixture ${name}: ${readFileSync(path, "utf8").slice(-4000)}`,
                        );
                }
            }
            throw error;
        } finally {
            if (pendingRun && child.exitCode === null) {
                try {
                    const cleanupOffset = events().length;
                    await prompt(`/fixture-stop ${pendingRun}`);
                    const stopped = await waitFor(
                        (event) => event.type === "fixture_rpc",
                        cleanupOffset,
                    );
                    if (stopped.error)
                        console.error(
                            `Fixture cleanup failed: ${stopped.error}`,
                        );
                } catch (error) {
                    console.error("Fixture RPC cleanup failed", error);
                }
            }
            if (child.pid && child.exitCode === null)
                process.kill(-child.pid, "SIGTERM");
            const timer = setTimeout(() => {
                if (child.pid && child.exitCode === null)
                    process.kill(-child.pid, "SIGKILL");
            }, 2000);
            try {
                await exited;
            } finally {
                clearTimeout(timer);
                await server.stop(true);
                rmSync(root, { recursive: true, force: true });
            }
        }
    },
    180000,
);
