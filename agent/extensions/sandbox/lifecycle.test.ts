/// <reference types="bun" />

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    mock,
    spyOn,
} from "bun:test";
import { renameSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DockerTargetAccess } from "./docker-access.ts";
import type { SandboxProfileContextsV1 } from "../_shared/sandbox-runtime/execution-context.ts";
import type {
    BashOperations,
    ExtensionAPI,
    ExtensionContext,
    Theme,
} from "@earendil-works/pi-coding-agent";

const initialize = mock(async (): Promise<void> => undefined);
// External Docker Engine and broker inspection is tested separately with the real adapter.
const inspectDockerAccess = mock(async (): Promise<DockerTargetAccess[]> => []);
const { formatDockerAccess } = await import("./docker-access.ts");
mock.module("./docker-access.ts", () => ({ formatDockerAccess, inspectDockerAccess }));
const reset = mock(async (): Promise<void> => undefined);
const createZeroboxBackend = mock(() => ({}));
const prepareBash = mock(
    async (command: { file: string; args: string[]; cwd: string }) => ({
        file: command.file,
        args: command.args,
        cwd: command.cwd,
        env: { ...process.env } as Record<string, string>,
        statusProtocol: { fd: 3 as const, version: 1 as const },
        extraStdio: ["ignore" as const],
        supervise: (_child: ChildProcess) => ({
            ready: Promise.resolve(),
            settled: Promise.resolve(),
        }),
    }),
);
const profileContext = {
    version: 1 as const,
    profile: "bash-general" as const,
    filesystem: { allowRead: ["/workspace"], denyRead: [], denyReadGlobs: [], allowWrite: ["/workspace"], denyWrite: [], denyWriteGlobs: [] },
    network: {
        mode: "deny-all" as const,
        allow: [],
        allowHost: [],
        deny: [],
        domainClientProxyRequired: false,
        loopback: {
            hostNamespace: "isolated" as const,
            hostBridgePorts: [],
            hostBridgeTransport: "disabled" as const,
            unlistedHostPorts: "blocked" as const,
            localListeners: "sandbox-only" as const,
        },
    },
    tmp: { path: "/tmp" as const, namespace: "host" as const },
    ipc: { hostUserDbus: "unavailable" as const, hostUnixSockets: "unavailable" as const },
    docker: { mode: "off" as const, profile: "None", targets: [], hostAccessException: false },
    environment: { inherit: [], set: ["HOME"], deny: [] },
};
const profileContexts: SandboxProfileContextsV1 = {
    "bash-general": profileContext,
    "think-strict": { ...profileContext, profile: "think-strict", tmp: { path: "/tmp", namespace: "lease-private" } },
    "analysis-strict": { ...profileContext, profile: "analysis-strict", tmp: { path: "/tmp", namespace: "lease-private" } },
};
const createSandboxService = mock((_options: unknown) => ({
    probe: initialize,
    startBashSession: initialize,
    getProfileContexts: () => profileContexts,
    prepareBash,
    prepareThinkBash: prepareBash,
    prepareAnalysis: mock(async () => {
        throw new Error("not exercised");
    }),
    shutdown: reset,
}));
const analysisShutdown = mock(async () => undefined);
const analysisPreflight = mock(async (): Promise<void> => undefined);
const createAnalysisSandboxService = mock(() => ({
    run: mock(async () => ({
        output: "ok",
        stderr: "",
        runtime: "quickjs" as const,
        durationMs: 1,
        truncated: false,
    })),
    preflight: analysisPreflight,
    shutdown: analysisShutdown,
}));

const capturedWidgetDef: {
    def: {
        render: (ctx: { theme: Theme; ctx: ExtensionContext }) => unknown;
    } | null;
} = { def: null };

mock.module("./runtime/zerobox-backend.ts", () => ({ createZeroboxBackend }));
mock.module("./runtime/service.ts", () => ({ createSandboxService }));
mock.module("./analysis/client.ts", () => ({
    createAnalysisSandboxService,
}));
mock.module("../_shared/fancy-footer.ts", () => ({
    createWidget: (
        _pi: unknown,
        def: {
            render: (ctx: { theme: Theme; ctx: ExtensionContext }) => unknown;
        },
    ) => {
        capturedWidgetDef.def = def;
        return {
            active: false,
            update: () => undefined,
            remove: () => undefined,
        };
    },
}));

const { default: sandboxExtension, sessionStateFilename } = await import(
    "./index.ts"
);
const {
    createSandboxBashOperations,
    getSandboxAnalysisPort,
    getSandboxRuntime,
    isSandboxUnavailableError,
    createSandboxThinkBashOperations,
} = await import("../_shared/sandbox-runtime/index.ts");
const { resolveBashOperations } = await import(
    "../bash-execution/builtin-bash.ts"
);
const { createBashProcessSupervisor } = await import(
    "../_shared/command-execution/exec.ts"
);
const { previewLegacyMigration, publishLegacyMigration } = await import(
    "./capabilities/migration.ts"
);

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;
type CommandDefinition = {
    handler: CommandHandler;
    getArgumentCompletions?: (
        prefix: string,
    ) => Array<{ value: string; label: string }> | null;
};

type Deferred<T = void> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: Error) => void;
};

function deferred<T = void>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function fakeTheme(): Theme {
    return { fg: (color: string, text: string) => `fg:${color}:${text}` } as unknown as Theme;
}

function registerSandbox(
    options?: Parameters<typeof sandboxExtension>[1],
) {
    const handlers = new Map<string, Handler>();
    const commands = new Map<string, CommandDefinition>();
    const sentMessages: Array<{ message: unknown; options: unknown }> = [];
    const pi = {
        registerFlag: () => undefined,
        registerTool: () => undefined,
        registerCommand: (
            name: string,
            definition: CommandDefinition,
        ) => commands.set(name, definition),
        on: (event: string, handler: Handler) => handlers.set(event, handler),
        getFlag: () => false,
        sendMessage: (message: unknown, options?: unknown) =>
            sentMessages.push({ message, options }),
    } as unknown as ExtensionAPI;
    sandboxExtension(pi, options);
    return { handlers, commands, sentMessages };
}

function sandboxCommand(registered: ReturnType<typeof registerSandbox>): CommandDefinition {
    const command = registered.commands.get("sandbox");
    if (!command) throw new Error("sandbox command not registered");
    return command;
}

function context(
    cwd: string,
    sessionDir?: string,
    sessionId = "session-a",
    projectTrusted = true,
    responses: {
        select?: Array<string | undefined>;
        input?: Array<string | undefined>;
        confirm?: Array<boolean | undefined>;
    } = {},
): ExtensionContext {
    const notify = mock((_message: string, _level?: string) => undefined);
    const select = mock(async () => responses.select?.shift());
    const input = mock(async () => responses.input?.shift());
    const confirm = mock(async () => responses.confirm?.shift());
    (context as unknown as { notify?: typeof notify }).notify = notify;
    return {
        cwd,
        hasUI: true,
        isProjectTrusted: () => projectTrusted,
        ui: { notify, select, input, confirm },
        sessionManager: sessionDir
            ? ({
                  getSessionDir: () => sessionDir,
                  getSessionId: () => sessionId,
              } as unknown as ExtensionContext["sessionManager"])
            : undefined,
    } as unknown as ExtensionContext;
}

type NotifyMock = ReturnType<typeof mock<(message: string, level?: string) => void>>;

function notifyCalls(ctx: ExtensionContext): Array<[string, string | undefined]> {
    const notify = (ctx.ui as unknown as { notify: NotifyMock }).notify;
    return notify.mock.calls as Array<[string, string | undefined]>;
}

async function configureBreakGlassTarget(
    cwd: string,
    agentDir: string,
): Promise<string> {
    await mkdir(agentDir);
    const authorityPath = join(agentDir, "sandbox.global.json");
    await writeFile(
        authorityPath,
        JSON.stringify({
            docker: {
                grants: [{
                    projectRoot: cwd,
                    mode: "targeted",
                    targets: [{
                        selector: { type: "container-name", name: "api" },
                        operations: ["ps", "inspect", "logs", "stats", "exec", "start", "stop", "restart"],
                        allowUnsafeTarget: true,
                    }],
                }],
            },
        }),
        { mode: 0o600 },
    );
    inspectDockerAccess.mockResolvedValue([{
        selector: { type: "container-name", name: "api" },
        containers: [{
            id: "0123456789abcdef",
            name: "api-current",
            state: "running",
            access: "accessible",
            facts: [],
            mounts: [{
                source: "/host/auths",
                destination: "/auths",
                writable: true,
            }],
        }],
    }]);
    return authorityPath;
}

const execArgs = [
    "printf blocked",
    "/tmp",
    { onData: () => undefined },
] as Parameters<BashOperations["exec"]>;

async function expectUnavailable(reason: string): Promise<void> {
    let error: unknown;
    try {
        await createSandboxBashOperations().exec(...execArgs);
    } catch (caught) {
        error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("expected execution error");
    expect(error.message).toContain(reason);
}

function renderWidget(): string | null {
    if (!capturedWidgetDef.def) throw new Error("widget not captured");
    const result = capturedWidgetDef.def.render({
        theme: fakeTheme(),
        ctx: {} as ExtensionContext,
    });
    return result === null || result === undefined ? null : String(result);
}

const { emptyGrants, readCapabilityAuthority, capabilityAuthorityPath } = await import("./capabilities/legacy-authority.ts");
const { currentShellPolicy } = await import("./capabilities/runtime.ts");

const ENV_KEY = "PI_SANDBOX_SESSION_STATUS";
const SESSION_ID = "session-a";
const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
let isolatedAgentDirectory: string;
async function writeLegacyAuthority(
    path: string,
    project: { projectRoot: string; profile: "isolated" | "integrated" | "host"; grants: ReturnType<typeof emptyGrants> },
    machineId = "346675da6aa23f926127a4e419becc296bb9ef369a0823fbe8d35f60444d35ea",
): Promise<void> {
    await writeFile(path, JSON.stringify({ version: 1, machineId, projects: [project] }), { mode: 0o600 });
}
beforeEach(async () => {
    isolatedAgentDirectory = await mkdtemp(join(tmpdir(), "sandbox-authority-fixture-"));
    process.env.PI_CODING_AGENT_DIR = isolatedAgentDirectory;
});
afterEach(async () => {
    if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
    await rm(isolatedAgentDirectory, { recursive: true, force: true });
});
const { localMachineId } = await import("./capabilities/authority.ts");

async function writeActiveConfig(cwd: string): Promise<void> {
    await writeFile(
        join(isolatedAgentDirectory, "sandbox.json"),
        JSON.stringify({ version: 2, machineId: localMachineId(), docker: { allowed: false } }),
        { mode: 0o600 },
    );
    await writeFile(join(cwd, ".pi", "sandbox.json"), "{}", { mode: 0o600 });
}

async function writeGlobalConfig(config: Record<string, unknown>): Promise<void> {
    await writeFile(
        join(isolatedAgentDirectory, "sandbox.json"),
        JSON.stringify({ version: 2, machineId: localMachineId(), ...config }),
        { mode: 0o600 },
    );
}

async function writeEnabledBreakGlassPolicy(cwd: string): Promise<void> {
    await writeGlobalConfig({
        docker: {
            allowed: true,
            mode: "targeted",
            endpoint: "unix:///tmp/docker-fixture.sock",
            operations: ["exec"],
            unsafeTargets: [{ type: "container-name", name: "api" }],
        },
    });
    await writeFile(join(cwd, ".pi", "sandbox.json"), JSON.stringify({
        docker: {
            enabled: true,
            targets: [{
                selector: { type: "container-name", name: "api" },
                operations: ["exec"],
            }],
        },
    }), { mode: 0o600 });
    inspectDockerAccess.mockResolvedValue([{
        selector: { type: "container-name", name: "api" },
        containers: [{
            id: "0123456789abcdef",
            name: "api-current",
            state: "running",
            access: "accessible",
            facts: [],
            mounts: [],
        }],
    }]);
}

async function runOrdinaryBash(cwd: string, command = "printf direct-config"): Promise<string> {
    const output: string[] = [];
    const supervisor = createBashProcessSupervisor();
    try {
        await expect(
            resolveBashOperations(supervisor).exec(command, cwd, {
                onData: (chunk) => output.push(chunk.toString()),
            }),
        ).resolves.toMatchObject({ exitCode: 0 });
    } finally {
        supervisor.shutdown();
    }
    return output.join("");
}

async function writeHostCeiling(
    cwd: string,
    project: Record<string, unknown> = {},
    includeNetwork = true,
): Promise<void> {
    await writeFile(
        join(isolatedAgentDirectory, "sandbox.json"),
        JSON.stringify({
            version: 2,
            machineId: localMachineId(),
            mode: "host",
            ...(includeNetwork
                ? { network: { allowedDomains: ["example.com"] } }
                : {}),
            docker: { allowed: false },
        }),
        { mode: 0o600 },
    );
    await writeFile(
        join(cwd, ".pi", "sandbox.json"),
        JSON.stringify(project),
        { mode: 0o600 },
    );
}

describe("sandbox lifecycle", () => {
    let cwd: string;

    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), "sandbox-lifecycle-"));
        await mkdir(join(cwd, ".pi"));
        await writeActiveConfig(cwd);
        initialize.mockReset(); initialize.mockImplementation(async () => undefined);
        reset.mockReset(); reset.mockImplementation(async () => undefined);
        analysisShutdown.mockClear(); analysisPreflight.mockReset(); analysisPreflight.mockImplementation(async () => undefined);
        createAnalysisSandboxService.mockClear(); capturedWidgetDef.def = null;
    });
    afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

    it("blocks writes to the active global authority", async () => {
        const registered = registerSandbox();
        const result = await registered.handlers.get("tool_call")?.(
            { toolName: "write", input: { path: join(isolatedAgentDirectory, "sandbox.json"), content: "{}" } },
            context(cwd),
        );
        expect(result).toMatchObject({ block: true });
    });

    it("starts Bash and Analysis and drains a Docker preference reconfiguration", async () => {
        const registered = registerSandbox(); const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);
        expect(getSandboxRuntime().state).toBe("enabled");
        expect(createAnalysisSandboxService).toHaveBeenCalledTimes(1);
        await sandboxCommand(registered).handler("docker off", ctx);
        expect(getSandboxRuntime().state).toBe("enabled");
        expect(createSandboxService).toHaveBeenCalledTimes(2);
        await registered.handlers.get("session_shutdown")?.({}, ctx);
        expect(reset).toHaveBeenCalled();
    });

    it("passes the explicit Analysis host seam into the Analysis service", async () => {
        const runHost = mock(async () => ({
            output: "preflight",
            stderr: "",
            runtime: "quickjs" as const,
            durationMs: 0,
            truncated: false,
        }));
        const registered = registerSandbox({ analysisServiceOptions: { runHost } });
        const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);
        expect(createAnalysisSandboxService).toHaveBeenCalledWith({ runHost });
        await registered.handlers.get("session_shutdown")?.({}, ctx);
    });

    it("leaves configuration untouched when the interactive migration preview is cancelled", async () => {
        const registered = registerSandbox();
        const ctx = context(cwd, undefined, "session-a", true, {
            select: ["Cancel"],
        });
        const globalPath = join(isolatedAgentDirectory, "sandbox.json");
        const projectPath = join(cwd, ".pi", "sandbox.json");
        const beforeGlobal = await readFile(globalPath);
        const beforeProject = await readFile(projectPath);

        await sandboxCommand(registered).handler("migrate", ctx);

        expect(await readFile(globalPath)).toEqual(beforeGlobal);
        expect(await readFile(projectPath)).toEqual(beforeProject);
        expect(notifyCalls(ctx).at(-1)?.[0]).toContain("cancelled");
    });

    it("publishes the selected migration ceiling and rebuilds the active runtime", async () => {
        const registered = registerSandbox();
        const ctx = context(cwd, undefined, "session-a", true, {
            select: ["Apply the proposed global ceiling"],
        });
        await registered.handlers.get("session_start")?.({}, ctx);
        const before = createSandboxService.mock.calls.length;

        await sandboxCommand(registered).handler("migrate", ctx);

        const global = JSON.parse(
            await readFile(join(isolatedAgentDirectory, "sandbox.json"), "utf8"),
        );
        expect(global).toMatchObject({ version: 2, machineId: localMachineId() });
        expect(
            JSON.parse(await readFile(join(cwd, ".pi", "sandbox.json"), "utf8")),
        ).toEqual({});
        expect(createSandboxService.mock.calls.length).toBe(before + 1);
        expect(notifyCalls(ctx).at(-1)?.[0]).toContain("completed");
        await registered.handlers.get("session_shutdown")?.({}, ctx);
    });

    it("keeps migration recovery interactive and reports when no durable marker exists", async () => {
        const registered = registerSandbox();
        const nonInteractive = {
            ...context(cwd),
            hasUI: false,
        } as ExtensionContext;
        await sandboxCommand(registered).handler("recover", nonInteractive);
        expect(notifyCalls(nonInteractive).at(-1)?.[0]).toContain("interactively");

        const ctx = context(cwd);
        await sandboxCommand(registered).handler("recover", ctx);
        expect(notifyCalls(ctx).at(-1)?.[0]).toContain("No interrupted sandbox migration");
    });

    it("recovers an interrupted migration through the command before allowing a new Bash admission", async () => {
        const registered = registerSandbox(); const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);
        const globalPath = join(isolatedAgentDirectory, "sandbox.json");
        const projectPath = join(cwd, ".pi", "sandbox.json");
        const beforeGlobal = await readFile(globalPath);
        const beforeProject = await readFile(projectPath);
        const preview = previewLegacyMigration(
            isolatedAgentDirectory,
            localMachineId(),
            cwd,
        );
        let publishedGlobal = false;
        expect(() =>
            publishLegacyMigration({
                preview,
                globalPath,
                projectPath,
                machineId: localMachineId(),
                globalCeiling: preview.proposedGlobal,
                filesystem: {
                    rename(from, to) {
                        if (to === globalPath) publishedGlobal = true;
                        if (to === projectPath && publishedGlobal)
                            throw new Error("injected second rename failure");
                        renameSync(from, to);
                    },
                },
            }),
        ).toThrow("injected second rename failure");
        expect(await stat(globalPath + ".migration")).toBeDefined();

        const supervisor = createBashProcessSupervisor();
        const blockedOutput: string[] = [];
        try {
            await expect(
                resolveBashOperations(supervisor).exec("printf blocked", cwd, {
                    onData: (chunk) => blockedOutput.push(chunk.toString()),
                }),
            ).rejects.toThrow("Sandbox policy is invalid");
        } finally {
            supervisor.shutdown();
        }
        expect(blockedOutput).toEqual([]);

        await sandboxCommand(registered).handler("recover", ctx);
        await expect(stat(globalPath + ".migration")).rejects.toThrow();
        expect(await readFile(globalPath)).toEqual(beforeGlobal);
        expect(await readFile(projectPath)).toEqual(beforeProject);
        await expect(runOrdinaryBash(cwd, "printf recovered")).resolves.toBe("recovered");
        expect(notifyCalls(ctx).at(-1)?.[0]).toContain("recovery restored");
        await registered.handlers.get("session_shutdown")?.({}, ctx);
    });

    it("rebuilds the sandbox before ordinary Bash admits a directly edited policy", async () => {
        await writeGlobalConfig({
            network: { allowedDomains: ["before.example"] },
            docker: { allowed: false },
        });
        const registered = registerSandbox(); const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);
        const before = createSandboxService.mock.calls.length;

        await writeGlobalConfig({
            network: { allowedDomains: ["after.example"] },
            docker: { allowed: false },
        });
        await expect(runOrdinaryBash(cwd)).resolves.toBe("direct-config");

        expect(createSandboxService.mock.calls.length).toBe(before + 1);
        const candidate = createSandboxService.mock.calls.at(-1)?.[0] as {
            config: { network: { allowedDomains: string[] } };
        };
        expect(candidate.config.network.allowedDomains).toEqual(["after.example"]);
        await registered.handlers.get("session_shutdown")?.({}, ctx);
    });

    it("canonicalizes a project alias before preparing a directly edited policy", async () => {
        await writeGlobalConfig({
            network: { allowedDomains: ["before.example"] },
            docker: { allowed: false },
        });
        const registered = registerSandbox(); const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);
        const before = createSandboxService.mock.calls.length;
        const alias = join(cwd, "project-alias");
        await symlink(cwd, alias, "dir");

        await writeGlobalConfig({
            network: { allowedDomains: ["after.example"] },
            docker: { allowed: false },
        });
        await expect(runOrdinaryBash(alias, "printf alias-ready")).resolves.toBe("alias-ready");

        expect(createSandboxService.mock.calls.length).toBe(before + 1);
        const candidate = createSandboxService.mock.calls.at(-1)?.[0] as {
            config: { network: { allowedDomains: string[] } };
        };
        expect(candidate.config.network.allowedDomains).toEqual(["after.example"]);
        await registered.handlers.get("session_shutdown")?.({}, ctx);
    });

    it("blocks direct invalid policy, accepts its correction, and rebuilds after the config is removed", async () => {
        await writeGlobalConfig({
            network: { allowedDomains: ["configured.example"] },
            docker: { allowed: false },
        });
        const registered = registerSandbox(); const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);
        const before = createSandboxService.mock.calls.length;
        const globalPath = join(isolatedAgentDirectory, "sandbox.json");

        await writeFile(globalPath, "{", { mode: 0o600 });
        const supervisor = createBashProcessSupervisor();
        const blockedOutput: string[] = [];
        try {
            await expect(
                resolveBashOperations(supervisor).exec("printf blocked", cwd, {
                    onData: (chunk) => blockedOutput.push(chunk.toString()),
                }),
            ).rejects.toThrow();
        } finally {
            supervisor.shutdown();
        }
        expect(createSandboxService.mock.calls.length).toBe(before);
        expect(blockedOutput).toEqual([]);

        await writeGlobalConfig({
            network: { allowedDomains: ["corrected.example"] },
            docker: { allowed: false },
        });
        await expect(runOrdinaryBash(cwd)).resolves.toBe("direct-config");
        expect(createSandboxService.mock.calls.length).toBe(before + 1);

        await unlink(globalPath);
        await expect(runOrdinaryBash(cwd, "printf fallback-policy")).resolves.toBe("fallback-policy");
        expect(createSandboxService.mock.calls.length).toBe(before + 2);
        await registered.handlers.get("session_shutdown")?.({}, ctx);
    });

    it("blocks a directly invalid project policy and admits its corrected restriction", async () => {
        await writeGlobalConfig({
            network: { allowedDomains: ["first.example", "second.example"] },
            docker: { allowed: false },
        });
        const projectPath = join(cwd, ".pi", "sandbox.json");
        await writeFile(
            projectPath,
            JSON.stringify({ network: { allowedDomains: ["first.example"] } }),
            { mode: 0o600 },
        );
        const registered = registerSandbox(); const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);
        const before = createSandboxService.mock.calls.length;

        await writeFile(projectPath, "{", { mode: 0o600 });
        const supervisor = createBashProcessSupervisor();
        const blockedOutput: string[] = [];
        try {
            await expect(
                resolveBashOperations(supervisor).exec("printf blocked", cwd, {
                    onData: (chunk) => blockedOutput.push(chunk.toString()),
                }),
            ).rejects.toThrow();
        } finally {
            supervisor.shutdown();
        }
        expect(createSandboxService.mock.calls.length).toBe(before);
        expect(blockedOutput).toEqual([]);

        await writeFile(
            projectPath,
            JSON.stringify({ network: { allowedDomains: ["second.example"] } }),
            { mode: 0o600 },
        );
        await expect(runOrdinaryBash(cwd)).resolves.toBe("direct-config");
        expect(createSandboxService.mock.calls.length).toBe(before + 1);
        const candidate = createSandboxService.mock.calls.at(-1)?.[0] as {
            config: { network: { allowedDomains: string[] } };
        };
        expect(candidate.config.network.allowedDomains).toEqual(["second.example"]);
        await registered.handlers.get("session_shutdown")?.({}, ctx);
    });

    it("keeps the newest direct edit when an earlier replacement is still starting", async () => {
        await writeGlobalConfig({
            network: { allowedDomains: ["initial.example"] },
            docker: { allowed: false },
        });
        const registered = registerSandbox(); const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);
        const starting = deferred();
        initialize.mockImplementationOnce(() => starting.promise);

        await writeGlobalConfig({
            network: { allowedDomains: ["stale.example"] },
            docker: { allowed: false },
        });
        const supervisor = createBashProcessSupervisor();
        const stale = resolveBashOperations(supervisor).exec("printf stale", cwd, {
            onData() {},
        });
        await Promise.resolve();
        await writeGlobalConfig({
            network: { allowedDomains: ["latest.example"] },
            docker: { allowed: false },
        });
        const latest = runOrdinaryBash(cwd, "printf latest");
        starting.resolve();

        await expect(stale).rejects.toThrow("replacement runtime was not admitted");
        await expect(latest).resolves.toBe("latest");
        supervisor.shutdown();
        const candidate = createSandboxService.mock.calls.at(-1)?.[0] as {
            config: { network: { allowedDomains: string[] } };
        };
        expect(candidate.config.network.allowedDomains).toEqual(["latest.example"]);
        await registered.handlers.get("session_shutdown")?.({}, ctx);
    });

    it("does not select host mode without a global ceiling", async () => {
        const registered = registerSandbox(); const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);
        await sandboxCommand(registered).handler("mode host", ctx);
        expect(notifyCalls(ctx).at(-1)?.[0]).toContain("outside the global ceiling");
        expect(currentShellPolicy()?.mode).toBe("sandbox");
        await registered.handlers.get("session_shutdown")?.({}, ctx);
    });

    it("preserves project Docker restrictions when toggling enabled", async () => {
        await writeFile(join(cwd, ".pi", "sandbox.json"), JSON.stringify({ docker: { enabled: false, targets: [{ selector: { type: "container-name", name: "api" }, operations: ["ps"] }] } }));
        const registered = registerSandbox(); const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);
        await sandboxCommand(registered).handler("docker on", ctx);
        await sandboxCommand(registered).handler("docker off", ctx);
        await sandboxCommand(registered).handler("docker on", ctx);
        const saved = JSON.parse(await readFile(join(cwd, ".pi", "sandbox.json"), "utf8"));
        expect(saved.docker).toMatchObject({ enabled: true, targets: [{ selector: { name: "api" }, operations: ["ps"] }] });
        await registered.handlers.get("session_shutdown")?.({}, ctx);
    });

    it("admits an ephemeral Docker break-glass exec only through active v2 global and project gates", async () => {
        await writeEnabledBreakGlassPolicy(cwd);
        const registered = registerSandbox();
        const ctx = context(cwd, undefined, "session-a", true, { confirm: [true] });
        await registered.handlers.get("session_start")?.({}, ctx);
        await sandboxCommand(registered).handler("docker break-glass 1m", ctx);
        const candidate = createSandboxService.mock.calls.at(-1)?.[0] as {
            config: { docker: { targets: Array<{ selector: { type: string } }> } };
        };
        expect(candidate.config.docker.targets).toContainEqual(expect.objectContaining({
            selector: expect.objectContaining({ type: "ephemeral-container", id: "0123456789abcdef" }),
        }));
        expect(notifyCalls(ctx).at(-1)?.[0]).toContain("Break-glass exec active");
        await expect(runOrdinaryBash(cwd, "printf admitted-break-glass")).resolves.toBe("admitted-break-glass");
        const admitted = createSandboxService.mock.calls.at(-1)?.[0] as {
            config: { docker: { targets: Array<{ selector: { type: string; id?: string } }> } };
        };
        expect(admitted.config.docker.targets).toContainEqual(expect.objectContaining({
            selector: expect.objectContaining({ type: "ephemeral-container", id: "0123456789abcdef" }),
        }));
        const callsAfterActivation = createSandboxService.mock.calls.length;
        await writeGlobalConfig({ docker: { allowed: false } });
        await sandboxCommand(registered).handler("docker break-glass 1m", ctx);
        expect(createSandboxService.mock.calls).toHaveLength(callsAfterActivation);
        expect(notifyCalls(ctx).at(-1)?.[0]).toContain("targeted host-access grants");
        await writeGlobalConfig({
            docker: {
                allowed: true,
                mode: "targeted",
                endpoint: "unix:///tmp/docker-fixture.sock",
                operations: ["exec"],
                unsafeTargets: [{ type: "container-name", name: "api" }],
            },
        });
        await writeFile(
            join(cwd, ".pi", "sandbox.json"),
            JSON.stringify({ docker: { enabled: false } }),
            { mode: 0o600 },
        );
        await sandboxCommand(registered).handler("docker break-glass 1m", ctx);
        expect(createSandboxService.mock.calls).toHaveLength(callsAfterActivation);
        expect(notifyCalls(ctx).at(-1)?.[0]).toContain("targeted host-access grants");
        await registered.handlers.get("session_shutdown")?.({}, ctx);
    });

    it.each([
        { label: "Docker authorization", docker: { allowed: false }, message: "no longer permits targeted host access" },
        { label: "unsafe exception", docker: { allowed: true, endpoint: "unix:///tmp/docker-fixture.sock" }, message: "selected container is no longer authorized" },
    ])("does not activate break-glass when its global $label is revoked during confirmation", async ({ docker, message }) => {
        await writeEnabledBreakGlassPolicy(cwd);
        const registered = registerSandbox();
        const ctx = context(cwd);
        const confirmation = deferred<boolean>();
        const confirm = mock(() => confirmation.promise);
        (ctx.ui as unknown as { confirm: typeof confirm }).confirm = confirm;
        await registered.handlers.get("session_start")?.({}, ctx);
        const command = sandboxCommand(registered).handler(
            "docker break-glass 1m",
            ctx,
        );
        for (let attempt = 0; confirm.mock.calls.length === 0 && attempt < 8; attempt += 1) {
            await Promise.resolve();
        }
        expect(confirm).toHaveBeenCalledTimes(1);
        const startsBeforeRevocation = createSandboxService.mock.calls.length;
        await writeGlobalConfig({ docker });
        confirmation.resolve(true);
        await command;
        expect(createSandboxService.mock.calls).toHaveLength(startsBeforeRevocation);
        expect(notifyCalls(ctx).at(-1)?.[0]).toContain(message);
        await registered.handlers.get("session_shutdown")?.({}, ctx);
    });

    it("removes a break-glass grant at expiry and rebuilds from the current authority", async () => {
        let expire: (() => void) | undefined;
        const captureTimeout = ((callback: Parameters<typeof setTimeout>[0]) => {
            expire = () => {
                if (typeof callback === "function") callback();
            };
            return 0 as never;
        }) as unknown as typeof setTimeout;
        const timeout = spyOn(globalThis, "setTimeout").mockImplementation(captureTimeout);
        const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
        try {
            await writeEnabledBreakGlassPolicy(cwd);
            const registered = registerSandbox();
            const ctx = context(cwd, undefined, "session-a", true, { confirm: [true] });
            await registered.handlers.get("session_start")?.({}, ctx);
            await sandboxCommand(registered).handler("docker break-glass 1m", ctx);
            await writeGlobalConfig({ docker: { allowed: false } });
            await expect(runOrdinaryBash(cwd, "printf revoke-break-glass")).resolves.toBe("revoke-break-glass");
            const startsAfterRevocation = createSandboxService.mock.calls.length;
            expect(clearTimeoutSpy).not.toHaveBeenCalled();
            expect(expire).toBeDefined();
            expire?.();
            for (let attempt = 0; attempt < 8; attempt += 1) await Promise.resolve();
            const restored = createSandboxService.mock.calls.at(-1)?.[0] as {
                config: { docker: { mode: string; targets?: Array<{ selector: { type: string } }> } };
            };
            expect(restored.config.docker.mode).toBe("disabled");
            expect(restored.config.docker.targets).toBeUndefined();
            expect(createSandboxService.mock.calls).toHaveLength(startsAfterRevocation);
            await registered.handlers.get("session_shutdown")?.({}, ctx);
        } finally {
            timeout.mockRestore();
            clearTimeoutSpy.mockRestore();
        }
    });

    it("keeps an expired revoked grant's deadline separate from a later break-glass grant", async () => {
        const callbacks: Array<() => void> = [];
        let timerId = 0;
        const timeout = spyOn(globalThis, "setTimeout").mockImplementation(
            ((callback: Parameters<typeof setTimeout>[0]) => {
                if (typeof callback === "function") callbacks.push(callback);
                timerId += 1;
                return timerId as never;
            }) as unknown as typeof setTimeout,
        );
        const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
        try {
            await writeEnabledBreakGlassPolicy(cwd);
            const registered = registerSandbox();
            const ctx = context(cwd, undefined, "session-a", true, {
                confirm: [true, true],
            });
            await registered.handlers.get("session_start")?.({}, ctx);
            await sandboxCommand(registered).handler("docker break-glass 1m", ctx);
            const firstDeadline = callbacks.at(-1);
            expect(firstDeadline).toBeDefined();

            await writeEnabledBreakGlassPolicy(cwd);
            await writeGlobalConfig({
                docker: {
                    allowed: true,
                    mode: "targeted",
                    endpoint: "unix:///tmp/docker-fixture.sock",
                    operations: ["exec"], unsafeTargets: [{ type: "container-name", name: "api" }],
                },
                filesystem: { denyRead: ["private-a"] },
            });
            await expect(runOrdinaryBash(cwd, "printf generation-a")).resolves.toBe("generation-a");
            const reconfiguredDeadline = callbacks.at(-1);
            expect(reconfiguredDeadline).not.toBe(firstDeadline);

            await writeGlobalConfig({ docker: { allowed: false } });
            await expect(runOrdinaryBash(cwd, "printf revoke-a")).resolves.toBe("revoke-a");
            const clearedBeforeB = clearTimeoutSpy.mock.calls.length;
            await writeEnabledBreakGlassPolicy(cwd);
            await sandboxCommand(registered).handler("docker break-glass 1m", ctx);
            const secondDeadline = callbacks.at(-1);
            expect(secondDeadline).toBeDefined();
            expect(secondDeadline).not.toBe(reconfiguredDeadline);
            expect(clearTimeoutSpy.mock.calls).toHaveLength(clearedBeforeB);

            const startsBeforeAExpiry = createSandboxService.mock.calls.length;
            reconfiguredDeadline?.();
            for (let attempt = 0; attempt < 8; attempt += 1) await Promise.resolve();
            expect(createSandboxService.mock.calls).toHaveLength(startsBeforeAExpiry);

            secondDeadline?.();
            for (let attempt = 0; attempt < 8; attempt += 1) await Promise.resolve();
            expect(createSandboxService.mock.calls.length).toBeGreaterThan(startsBeforeAExpiry);
            await registered.handlers.get("session_shutdown")?.({}, ctx);
        } finally {
            timeout.mockRestore();
            clearTimeoutSpy.mockRestore();
        }
    });

    it("terminates admitted A processes at A expiry while B remains alive until B expiry", async () => {
        const callbacks = new Map<number, () => void>();
        const realSetTimeout = globalThis.setTimeout;
        const realClearTimeout = globalThis.clearTimeout;
        let nextTimer = 0;
        const timeout = spyOn(globalThis, "setTimeout").mockImplementation(
            ((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
                if (
                    typeof callback === "function" &&
                    typeof delay === "number" &&
                    delay >= 59_000 &&
                    delay <= 60_000
                ) {
                    nextTimer += 1;
                    callbacks.set(nextTimer, callback);
                    return nextTimer as never;
                }
                return realSetTimeout(callback, delay as number) as never;
            }) as unknown as typeof setTimeout,
        );
        const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(
            ((timer: number) => {
                if (callbacks.delete(timer)) return;
                realClearTimeout(timer as never);
            }) as unknown as typeof clearTimeout,
        );
        try {
            prepareBash.mockImplementation(async (command) => ({
                file: command.file,
                args: command.args,
                cwd: command.cwd,
                env: { ...process.env } as Record<string, string>,
                statusProtocol: { fd: 3 as const, version: 1 as const },
                extraStdio: ["ignore" as const],
                supervise: (child: ChildProcess) => ({
                    ready: Promise.resolve(),
                    settled: new Promise<void>((resolve) =>
                        child.once("close", () => resolve()),
                    ),
                }),
            }));
            const start = async (label: string) => {
                let ready!: () => void;
                const started = new Promise<void>((resolve) => { ready = resolve; });
                const operation = resolveBashOperations(createBashProcessSupervisor())
                    .exec(`printf ${label}; sleep 30`, cwd, {
                        onData: (chunk) => {
                            if (chunk.toString().includes(label)) ready();
                        },
                    })
                    .then((result) => result, (error) => error);
                await started;
                return { operation };
            };
            await writeEnabledBreakGlassPolicy(cwd);
            const registered = registerSandbox();
            const ctx = context(cwd, undefined, "session-a", true, { confirm: [true, true] });
            await registered.handlers.get("session_start")?.({}, ctx);
            await sandboxCommand(registered).handler("docker break-glass 1m", ctx);
            const firstATimer = nextTimer;
            const a1 = await start("A1_READY");
            await writeGlobalConfig({ docker: { allowed: true, mode: "targeted", endpoint: "unix:///tmp/docker-fixture.sock", operations: ["exec"], unsafeTargets: [{ type: "container-name", name: "api" }] }, filesystem: { denyRead: ["reconfigure-a"] } });
            const a2 = await start("A2_READY");
            const activeATimer = nextTimer;
            expect(activeATimer).toBeGreaterThan(firstATimer);
            await writeGlobalConfig({ docker: { allowed: false } });
            await expect(runOrdinaryBash(cwd, "printf revoke-a-live")).resolves.toBe("revoke-a-live");
            await writeEnabledBreakGlassPolicy(cwd);
            await sandboxCommand(registered).handler("docker break-glass 1m", ctx);
            const b = await start("B_READY");
            const bTimer = nextTimer;
            expect(bTimer).toBeGreaterThan(activeATimer);
            const aDeadline = callbacks.get(activeATimer);
            const bDeadline = callbacks.get(bTimer);
            aDeadline?.();
            expect(await a1.operation).toMatchObject({ exitCode: null });
            expect(await a2.operation).toMatchObject({ exitCode: null });
            const bStillRunning = await Promise.race([
                b.operation.then(() => false),
                new Promise<boolean>((resolve) => setImmediate(() => resolve(true))),
            ]);
            expect(bStillRunning).toBeTrue();
            bDeadline?.();
            const bTerminated = await b.operation;
            expect(
                bTerminated instanceof Error ||
                    (typeof bTerminated === "object" &&
                        bTerminated !== null &&
                        "exitCode" in bTerminated &&
                        bTerminated.exitCode === null),
            ).toBeTrue();
            await registered.handlers.get("session_shutdown")?.({}, ctx);
        } finally {
            timeout.mockRestore();
            clearTimeoutSpy.mockRestore();
        }
    });

    it("interrupts only resource-bearing retired operations after a resource revocation", async () => {
        prepareBash.mockImplementation(async (command) => ({
            file: command.file,
            args: command.args,
            cwd: command.cwd,
            env: { ...process.env } as Record<string, string>,
            statusProtocol: { fd: 3 as const, version: 1 as const },
            extraStdio: ["ignore" as const],
            supervise: (child: ChildProcess) => ({
                ready: Promise.resolve(),
                settled: new Promise<void>((resolve) =>
                    child.once("close", () => resolve()),
                ),
            }),
        }));
        const start = async (label: string) => {
            let ready!: () => void;
            const started = new Promise<void>((resolve) => { ready = resolve; });
            const operation = resolveBashOperations(createBashProcessSupervisor())
                .exec(`printf ${label}; sleep 30`, cwd, {
                    onData: (chunk) => {
                        if (chunk.toString().includes(label)) ready();
                    },
                })
                .then((result) => result, (error) => error);
            await started;
            return { operation };
        };
        await writeGlobalConfig({
            docker: { allowed: false },
            resources: { unixSockets: ["/tmp/resource-fixture.sock"] },
        });
        const registered = registerSandbox();
        const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);
        const resourceBound = await start("RESOURCE_READY");

        await writeGlobalConfig({
            docker: { allowed: false },
            resources: { unixSockets: [] },
        });
        await expect(runOrdinaryBash(cwd, "printf replacement-ready")).resolves.toBe(
            "replacement-ready",
        );
        expect(await resourceBound.operation).toMatchObject({ exitCode: null });

        const replacement = await start("REPLACEMENT_READY");
        const replacementStillRunning = await Promise.race([
            replacement.operation.then(() => false),
            new Promise<boolean>((resolve) => setImmediate(() => resolve(true))),
        ]);
        expect(replacementStillRunning).toBeTrue();
        await registered.handlers.get("session_shutdown")?.({}, ctx);
        const replacementStopped = await replacement.operation;
        expect(
            replacementStopped instanceof Error ||
                (typeof replacementStopped === "object" &&
                    replacementStopped !== null &&
                    "exitCode" in replacementStopped &&
                    replacementStopped.exitCode === null),
        ).toBeTrue();
    });

    it("derives custom and host profiles from v2 global and project mode layers", async () => {
        await writeHostCeiling(cwd, {
            network: { allowedDomains: ["example.com"] },
        });
        const registered = registerSandbox();
        const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);
        expect(currentShellPolicy()).toMatchObject({
            mode: "sandbox",
            profile: "custom",
        });

        await sandboxCommand(registered).handler("mode host", ctx);
        expect(currentShellPolicy()).toMatchObject({
            mode: "host",
            profile: "host",
        });

        await sandboxCommand(registered).handler("mode sandbox", ctx);
        expect(currentShellPolicy()).toMatchObject({
            mode: "sandbox",
            profile: "custom",
        });
        await registered.handlers.get("session_shutdown")?.({}, ctx);
    });

    it("keeps Bash active while Analysis retries and restores Analysis without restarting Bash", async () => {
        analysisPreflight.mockRejectedValueOnce(
            new Error("analysis preflight failed"),
        );
        const registered = registerSandbox();
        const ctx = context(cwd);

        await registered.handlers.get("session_start")?.({}, ctx);
        await Bun.sleep(10);
        expect(getSandboxRuntime()).toMatchObject({
            state: "enabled",
            analysis: { state: "retrying" },
        });
        await expect(
            getSandboxAnalysisPort().run({
                id: "blocked",
                language: "javascript",
                program: "export default 1",
            }),
        ).rejects.toMatchObject({ kind: "analysis-unavailable" });
        expect(initialize).toHaveBeenCalledTimes(1);

        const output: string[] = [];
        await expect(
            createSandboxBashOperations().exec("printf bash-ready", cwd, {
                onData: (chunk) => output.push(chunk.toString()),
            }),
        ).resolves.toMatchObject({ exitCode: 0 });
        expect(output.join("")).toBe("bash-ready");

        await Bun.sleep(5_100);
        expect(getSandboxRuntime()).toMatchObject({
            state: "enabled",
            analysis: { state: "ready" },
        });
        expect(initialize).toHaveBeenCalledTimes(1);
        await expect(
            getSandboxAnalysisPort().run({
                id: "restored",
                language: "javascript",
                program: "export default 1",
            }),
        ).resolves.toMatchObject({ output: "ok" });
        await registered.handlers.get("session_shutdown")?.({}, ctx);
    }, 8_000);

    it("cancels a scheduled Analysis retry when the session closes", async () => {
        analysisPreflight.mockRejectedValue(new Error("analysis unavailable"));
        const registered = registerSandbox();
        const ctx = context(cwd);

        await registered.handlers.get("session_start")?.({}, ctx);
        await Bun.sleep(10);
        expect(analysisPreflight).toHaveBeenCalledTimes(1);

        await registered.handlers.get("session_shutdown")?.({}, ctx);
        await Bun.sleep(5_100);
        expect(analysisPreflight).toHaveBeenCalledTimes(1);
    }, 8_000);

    it("retains an Analysis cleanup failure and retries it at shutdown", async () => {
        analysisPreflight.mockRejectedValueOnce(new Error("preflight failed"));
        analysisShutdown.mockRejectedValueOnce(new Error("cleanup failed"));
        const registered = registerSandbox();
        const ctx = context(cwd);

        await registered.handlers.get("session_start")?.({}, ctx);
        await Bun.sleep(10);
        expect(getSandboxRuntime()).toMatchObject({
            state: "enabled",
            analysis: { state: "retrying" },
        });
        expect(analysisShutdown).toHaveBeenCalledTimes(1);

        await registered.handlers.get("session_shutdown")?.({}, ctx);
        expect(analysisShutdown).toHaveBeenCalledTimes(2);
        expect(getSandboxRuntime().state).toBe("uninitialized");
    });

    it("lets an admitted operation drain after mode revocation", async () => {
        await writeHostCeiling(cwd, {}, false);
        const registered = registerSandbox();
        const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);

        const supervisor = createBashProcessSupervisor();
        const running = resolveBashOperations(supervisor).exec("sleep 0.12", cwd, {
            onData() {},
        });
        await Bun.sleep(20);
        await sandboxCommand(registered).handler("mode host", ctx);
        expect(currentShellPolicy()).toMatchObject({
            mode: "host",
            profile: "host",
        });
        await expect(running).resolves.toMatchObject({ exitCode: 0 });
        supervisor.shutdown();
        expect(registered.sentMessages).toEqual([]);
        await registered.handlers.get("session_shutdown")?.({}, ctx);
    });

    it("keeps the latest mode authoritative over an in-flight initialization", async () => {
        await writeHostCeiling(cwd);
        const registered = registerSandbox();
        const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);

        const starting = deferred();
        initialize.mockImplementationOnce(() => starting.promise);
        const sandbox = sandboxCommand(registered).handler("mode sandbox", ctx);
        await Promise.resolve();
        await sandboxCommand(registered).handler("mode host", ctx);
        starting.resolve();
        await sandbox;

        expect(currentShellPolicy()).toMatchObject({
            mode: "host",
            profile: "host",
        });
        expect(getSandboxRuntime().state).toBe("enabled");
        await registered.handlers.get("session_shutdown")?.({}, ctx);
    });

    it("does not publish an Analysis candidate after shutdown supersedes startup", async () => {
        const preflight = deferred();
        analysisPreflight.mockImplementationOnce(() => preflight.promise);
        const registered = registerSandbox();
        const ctx = context(cwd);

        await registered.handlers.get("session_start")?.({}, ctx);
        await registered.handlers.get("session_shutdown")?.({}, ctx);
        expect(getSandboxRuntime().state).toBe("uninitialized");

        preflight.resolve();
        await Bun.sleep(10);
        expect(getSandboxRuntime().state).toBe("uninitialized");
        expect(analysisShutdown).toHaveBeenCalledTimes(2);
        expect(reset).toHaveBeenCalledTimes(1);
    });

    it("fails closed when reset fails and succeeds on its retry", async () => {
        const registered = registerSandbox();
        const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);
        reset.mockRejectedValueOnce(new Error("reset failed"));

        await expect(
            registered.handlers.get("session_shutdown")?.({}, ctx),
        ).rejects.toThrow("reset failed");
        expect(getSandboxRuntime().state).toBe("error");
        await expectUnavailable("initialization failed");

        await registered.handlers.get("session_shutdown")?.({}, ctx);
        expect(reset).toHaveBeenCalledTimes(2);
        expect(getSandboxRuntime().state).toBe("uninitialized");
    });

    it("supports Pi's shutdown-old then start-new reload sequence", async () => {
        const first = registerSandbox();
        const ctx = context(cwd);
        await first.handlers.get("session_start")?.({}, ctx);
        await first.handlers.get("session_shutdown")?.({}, ctx);
        expect(getSandboxRuntime().state).toBe("uninitialized");

        const second = registerSandbox();
        await second.handlers.get("session_start")?.({}, ctx);
        expect(reset).toHaveBeenCalledTimes(1);
        expect(getSandboxRuntime().state).toBe("enabled");
        await second.handlers.get("session_shutdown")?.({}, ctx);
    });

    it("prevents an obsolete owner from altering the newer runtime", async () => {
        const first = registerSandbox();
        const ctx = context(cwd);
        await first.handlers.get("session_start")?.({}, ctx);

        const second = registerSandbox();
        await second.handlers.get("session_start")?.({}, ctx);
        const currentRuntime = getSandboxRuntime();
        await first.handlers.get("session_shutdown")?.({}, ctx);

        expect(reset).toHaveBeenCalledTimes(1);
        expect(analysisShutdown).toHaveBeenCalledTimes(1);
        expect(getSandboxRuntime()).toBe(currentRuntime);
        await second.handlers.get("session_shutdown")?.({}, ctx);
    });

    it("keeps Think private and available when the selected mode is host", async () => {
        await writeHostCeiling(cwd);
        const registered = registerSandbox();
        const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);
        await sandboxCommand(registered).handler("mode host", ctx);

        expect(currentShellPolicy()).toMatchObject({
            mode: "host",
            profile: "host",
        });
        expect(getSandboxRuntime()).toMatchObject({
            state: "enabled",
            contexts: {
                "think-strict": { tmp: { namespace: "lease-private" } },
            },
            analysis: { state: "ready" },
        });
        const output: string[] = [];
        await expect(
            createSandboxThinkBashOperations().exec("printf think-private", cwd, {
                onData: (chunk) => output.push(chunk.toString()),
            }),
        ).resolves.toMatchObject({ exitCode: 0 });
        expect(output.join("")).toBe("think-private");
        await expect(
            getSandboxAnalysisPort().run({
                id: "think-host",
                language: "javascript",
                program: "export default 1",
            }),
        ).resolves.toMatchObject({ output: "ok" });
        await registered.handlers.get("session_shutdown")?.({}, ctx);
    });

    it("does not propagate a session mode grant into the next Pi session", async () => {
        await writeHostCeiling(cwd, {}, false);
        const first = registerSandbox();
        const ctx = context(cwd);
        await first.handlers.get("session_start")?.({}, ctx);
        await sandboxCommand(first).handler("mode host", ctx);
        expect(currentShellPolicy()?.mode).toBe("host");
        expect(process.env[ENV_KEY]).toBeUndefined();
        await first.handlers.get("session_shutdown")?.({}, ctx);

        const second = registerSandbox();
        await second.handlers.get("session_start")?.({}, ctx);
        expect(currentShellPolicy()).toMatchObject({
            mode: "sandbox",
            profile: "default",
        });
        expect(process.env[ENV_KEY]).toBeUndefined();
        await second.handlers.get("session_shutdown")?.({}, ctx);
    });
});
