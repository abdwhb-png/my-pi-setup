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
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
        supervise: () => ({
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
} = await import("../_shared/sandbox-runtime/index.ts");

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;
type CommandDefinition = {
    handler: CommandHandler;
    getArgumentCompletions?: (
        prefix: string,
    ) => Array<{ value: string; label: string }> | null;
};

type Deferred = {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
};

function deferred(): Deferred {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function fakeTheme(): Theme {
    return { fg: (color: string, text: string) => `fg:${color}:${text}` } as unknown as Theme;
}

function registerSandbox() {
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
    sandboxExtension(pi);
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

const ENV_KEY = "PI_SANDBOX_SESSION_STATUS";
const SESSION_ID = "session-a";

describe("sandbox lifecycle", () => {
    let cwd: string;

    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), "sandbox-lifecycle-"));
        await mkdir(join(cwd, ".pi"));
        await writeFile(
            join(cwd, ".pi", "sandbox.json"),
            JSON.stringify({ enabled: true }),
        );
        initialize.mockReset();
        inspectDockerAccess.mockReset();
        inspectDockerAccess.mockResolvedValue([]);
        initialize.mockImplementation(async () => undefined);
        reset.mockReset();
        reset.mockImplementation(async () => undefined);
        analysisShutdown.mockClear();
        analysisPreflight.mockReset();
        analysisPreflight.mockImplementation(async () => undefined);
        createAnalysisSandboxService.mockClear();
        capturedWidgetDef.def = null;
        delete process.env[ENV_KEY];
    });

    afterEach(async () => {
        await rm(cwd, { recursive: true, force: true });
        delete process.env[ENV_KEY];
    });

    it("publishes and shuts down the strict analysis service with the sandbox", async () => {
        const registered = registerSandbox();
        const ctx = context(cwd);

        await registered.handlers.get("session_start")?.({}, ctx);

        expect(getSandboxRuntime().state).toBe("enabled");
        expect(createAnalysisSandboxService).toHaveBeenCalledTimes(1);
        await expect(
            getSandboxAnalysisPort().run({
                id: "analysis-call",
                language: "javascript",
                program: "export default 1",
            }),
        ).resolves.toMatchObject({ output: "ok" });

        await registered.handlers.get("session_shutdown")?.({}, ctx);
        expect(analysisShutdown).toHaveBeenCalledTimes(1);
        expect(getSandboxRuntime().state).toBe("uninitialized");
    });

    it("injects one effective sandbox section before the first model request", async () => {
        const registered = registerSandbox();
        const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);

        const first = await registered.handlers.get("before_agent_start")?.(
            { systemPrompt: "base prompt" },
            ctx,
        ) as { systemPrompt: string };
        const second = await registered.handlers.get("before_agent_start")?.(
            { systemPrompt: first.systemPrompt },
            ctx,
        ) as { systemPrompt: string };

        expect(first.systemPrompt).toContain("Sandbox execution context v1");
        expect(first.systemPrompt).toContain('"state":"enabled"');
        expect(first.systemPrompt).toContain('"bash-general"');
        expect(first.systemPrompt).toContain('"analysis-strict"');
        expect(second.systemPrompt).toBe(first.systemPrompt);

        await sandboxCommand(registered).handler("off", ctx);
        const disabled = await registered.handlers.get("before_agent_start")?.(
            { systemPrompt: first.systemPrompt },
            ctx,
        ) as { systemPrompt: string };
        expect(disabled.systemPrompt).toContain('"state":"disabled"');
        expect(disabled.systemPrompt).toContain("OS isolation is absent");
        expect(disabled.systemPrompt).toContain(
            "safe_bash guards are independent",
        );
        expect(
            disabled.systemPrompt.match(/Sandbox execution context v1/g),
        ).toHaveLength(1);
    });

    it("keeps Bash active while Analysis retries, then restores Analysis without restarting Bash", async () => {
        analysisPreflight.mockRejectedValueOnce(
            new Error("analysis preflight failed"),
        );
        const registered = registerSandbox();
        const ctx = context(cwd);

        await registered.handlers.get("session_start")?.({}, ctx);
        await Bun.sleep(10);

        const runtime = getSandboxRuntime();
        expect(runtime).toMatchObject({
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
        expect(notifyCalls(ctx).at(-1)).toEqual([
            "Analysis indisponible, réessai en cours",
            "warning",
        ]);

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

    it("retains failed Analysis cleanup for the next transition without disabling Bash", async () => {
        analysisPreflight.mockRejectedValueOnce(new Error("preflight failed"));
        analysisShutdown.mockRejectedValueOnce(
            new Error("candidate cleanup failed"),
        );
        const registered = registerSandbox();
        const ctx = context(cwd);

        await registered.handlers.get("session_start")?.({}, ctx);
        await Bun.sleep(10);
        expect(getSandboxRuntime()).toMatchObject({
            state: "enabled",
            analysis: { state: "retrying" },
        });
        expect(reset).not.toHaveBeenCalled();

        await sandboxCommand(registered).handler("off", ctx);
        expect(getSandboxRuntime().state).toBe("disabled");
    });

    it("surfaces and retries cleanup failure after invalid configuration", async () => {
        const registered = registerSandbox();
        const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);

        await writeFile(
            join(cwd, ".pi", "sandbox.json"),
            JSON.stringify({
                enabled: true,
                network: { allowedDomains: ["127.0.0.1"] },
            }),
        );
        reset.mockRejectedValueOnce(new Error("config cleanup failed"));

        await registered.handlers.get("session_start")?.({}, ctx);
        expect(getSandboxRuntime().state).toBe("error");
        expect(notifyCalls(ctx).at(-1)).toEqual([
            expect.stringContaining("cleanup failed: config cleanup failed"),
            "error",
        ]);

        await sandboxCommand(registered).handler("off", ctx);
        expect(reset).toHaveBeenCalledTimes(2);
        expect(getSandboxRuntime().state).toBe("disabled");
    });

    it("waits for sandbox on transitions and rejects pending calls when switched off", async () => {
        await writeFile(
            join(cwd, ".pi", "sandbox.json"),
            JSON.stringify({ enabled: false }),
        );
        const registered = registerSandbox();
        const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);
        expect(getSandboxRuntime().state).toBe("disabled");

        const enabling = deferred();
        initialize.mockImplementation(() => enabling.promise);
        const enableTransition = sandboxCommand(registered).handler("on", ctx);
        expect(getSandboxRuntime().state).toBe("reconfiguring");
        const pendingAnalysis = getSandboxAnalysisPort().run({ id: "wait", language: "javascript", program: "1" });
        enabling.resolve();
        await enableTransition;
        await expect(pendingAnalysis).rejects.toMatchObject({
            kind: "analysis-unavailable",
        });
        expect(getSandboxRuntime().state).toBe("enabled");

        const disabling = deferred();
        reset.mockImplementation(() => disabling.promise);
        const disableTransition = sandboxCommand(registered).handler("off", ctx);
        expect(getSandboxRuntime().state).toBe("reconfiguring");
        const pendingBash = createSandboxBashOperations().exec("true", cwd, { onData() {} }).catch((error: Error) => error);
        disabling.resolve();
        await disableTransition;
        expect((await pendingBash as Error).message).toContain("disabled");
        expect(getSandboxRuntime().state).toBe("disabled");
    });

    it("tells the agent when a configuration change interrupts a running execution", async () => {
        const registered = registerSandbox();
        const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);
        const running = createSandboxBashOperations().exec("sleep 30", cwd, {
            onData: () => undefined,
        });
        await Bun.sleep(20);

        await sandboxCommand(registered).handler("off", ctx);

        await expect(running).rejects.toThrow("interrupted by reconfiguration");
        expect(registered.sentMessages).toContainEqual({
            message: expect.objectContaining({
                customType: "sandbox-runtime-feedback",
                display: false,
                content: expect.stringMatching(
                    /1 running Sandbox execution was interrupted.*was not retried/is,
                ),
            }),
            options: { deliverAs: "steer" },
        });
    });

    it("exposes only on and off and rejects the removed toggle aliases", async () => {
        const registered = registerSandbox();
        const ctx = context(cwd);
        const command = sandboxCommand(registered);

        expect(command.getArgumentCompletions?.("")).toEqual([
            { value: "doctor", label: "doctor" },
            { value: "on", label: "on" },
            { value: "off", label: "off" },
            { value: "docker", label: "docker" },
        ]);
        expect(command.getArgumentCompletions?.("docker ")).toEqual([
            { value: "docker grant", label: "docker grant" },
            { value: "docker break-glass", label: "docker break-glass" },
            {
                value: "docker break-glass 5m",
                label: "docker break-glass 5m",
            },
            {
                value: "docker break-glass 15m",
                label: "docker break-glass 15m",
            },
            {
                value: "docker break-glass 30m",
                label: "docker break-glass 30m",
            },
            { value: "docker off", label: "docker off" },
            { value: "docker targeted", label: "docker targeted" },
            { value: "docker full", label: "docker full" },
            { value: "docker inherit", label: "docker inherit" },
        ]);

        await command.handler("enable", ctx);
        await command.handler("disable", ctx);

        expect(notifyCalls(ctx).slice(-2)).toEqual([
            ["Usage: /sandbox [doctor|on|off|docker ...]", "error"],
            ["Usage: /sandbox [doctor|on|off|docker ...]", "error"],
        ]);
        expect(initialize).not.toHaveBeenCalled();
        expect(reset).not.toHaveBeenCalled();
    });

    it("persists Docker off in project settings without losing legacy sandbox fields", async () => {
        await writeFile(
            join(cwd, ".pi", "sandbox.json"),
            JSON.stringify({
                enabled: true,
                network: { allowedDomains: ["example.com"] },
            }),
        );
        const registered = registerSandbox();
        const ctx = context(cwd);

        await sandboxCommand(registered).handler("docker off", ctx);

        const settings = JSON.parse(
            await readFile(join(cwd, ".pi", "settings.json"), "utf8"),
        );
        expect(settings).toEqual({
            sandbox: {
                enabled: true,
                network: { allowedDomains: ["example.com"] },
                docker: { mode: "disabled" },
            },
        });
        expect(notifyCalls(ctx).at(-1)).toEqual([
            "Docker project preference saved: off",
            "info",
        ]);
    });

    it("shows Docker authority, project preference, effective policy, and runtime state", async () => {
        const registered = registerSandbox();
        const ctx = context(cwd);

        await sandboxCommand(registered).handler("docker", ctx);

        expect(notifyCalls(ctx).at(-1)).toEqual([
            [
                "Saved Docker grant: off",
                "Project preference: inherit",
                "Configured Docker: off",
                "Runtime: uninitialized",
            ].join("\n"),
            "info",
        ]);
    });

    it("diagnoses only the canonical Docker authority without writing configuration", async () => {
        const agentDir = join(cwd, "agent-home");
        await mkdir(agentDir);
        await writeFile(join(cwd, ".pi", "sandbox.json"), "{ invalid");
        await writeFile(join(agentDir, "sandbox.global.lg.json"), "{ invalid");
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        try {
            const registered = registerSandbox();
            const ctx = context(cwd);

            await sandboxCommand(registered).handler("doctor", ctx);

            expect(notifyCalls(ctx).at(-1)).toEqual([
                [
                    "Sandbox doctor",
                    `Docker authority: ${join(agentDir, "sandbox.global.json")} (not configured)`,
                    "Effective Sandbox: off (default)",
                    "Saved Docker grant: off",
                    "Configured Docker: off",
                    "Runtime: uninitialized",
                    "Target visibility checks do not execute the granted operations.",
                    "Next: /sandbox docker grant",
                ].join("\n"),
                "info",
            ]);
            await expect(
                readFile(join(agentDir, "sandbox.global.json"), "utf8"),
            ).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            if (previousAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
        }
    });

    it("reports the exact invalid authority field through doctor", async () => {
        const agentDir = join(cwd, "agent-home");
        await mkdir(agentDir);
        await writeFile(
            join(agentDir, "sandbox.global.json"),
            JSON.stringify({
                docker: {
                    grants: [{ projectRoot: cwd, mode: "targeted" }],
                },
            }),
            { mode: 0o600 },
        );
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        try {
            const registered = registerSandbox();
            const ctx = context(cwd);

            await sandboxCommand(registered).handler("doctor", ctx);

            expect(notifyCalls(ctx).at(-1)).toEqual([
                [
                    "Sandbox doctor",
                    `Docker authority: ${join(agentDir, "sandbox.global.json")} (invalid)`,
                    'Problem: docker.grants[0].targets is required for mode "targeted"; run /sandbox docker grant',
                    "Next: /sandbox docker grant",
                ].join("\n"),
                "error",
            ]);
        } finally {
            if (previousAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
        }
    });

    async function withExcludedDockerTarget(run: (ctx: ExtensionContext, path: string) => Promise<void>, confirmations: boolean[]) {
        const agentDir = join(cwd, "agent-home");
        const fakeBin = join(cwd, "bin");
        await mkdir(agentDir);
        await mkdir(fakeBin);
        await writeFile(join(fakeBin, "docker"), '#!/bin/sh\nprintf \'{"name":"cliproxy","services":{"cli-proxy-api":{}}}\'\n', { mode: 0o700 });
        const path = join(agentDir, "sandbox.global.json");
        await writeFile(path, JSON.stringify({ docker: { grants: [{ projectRoot: cwd, mode: "targeted", targets: [{ selector: { type: "compose-service", project: "cliproxy", service: "cli-proxy-api" }, operations: ["ps"], allowUnsafeTarget: false }] }] } }), { mode: 0o600 });
        inspectDockerAccess.mockResolvedValue([{ selector: { type: "compose-service", project: "cliproxy", service: "cli-proxy-api" }, containers: [{ id: "abc", name: "cliproxy", state: "running", access: "excluded", mounts: [{ source: "/host/config", destination: "/app/config", writable: false }], facts: [] }] }]);
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        const previousPath = process.env.PATH;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
        try { await run(context(cwd, undefined, SESSION_ID, true, { select: ["cliproxy / cli-proxy-api", "Exploitation"], confirm: confirmations }), path); }
        finally {
            if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            if (previousPath === undefined) delete process.env.PATH;
            else process.env.PATH = previousPath;
        }
    }

    it("does not save after declining the explicit exception for an excluded Docker target", async () => {
        await withExcludedDockerTarget(async (ctx, path) => {
            const before = await readFile(path, "utf8");
            await sandboxCommand(registerSandbox()).handler("docker grant", ctx);
            expect(ctx.ui.confirm).toHaveBeenCalledWith("Authorize this Docker target despite host access?", expect.stringContaining("Host: /host/config → Container: /app/config"));
            expect(await readFile(path, "utf8")).toBe(before);
        }, [false]);
    });

    it("saves only a separately confirmed target exception and keeps exploitation without exec", async () => {
        await withExcludedDockerTarget(async (ctx, path) => {
            inspectDockerAccess.mockResolvedValueOnce([{ selector: { type: "compose-service", project: "cliproxy", service: "cli-proxy-api" }, containers: [{ id: "abc", name: "cliproxy", state: "running", access: "excluded", mounts: [{ source: "/host/config", destination: "/app/config", writable: false }], facts: [] }] }]);
            inspectDockerAccess.mockResolvedValue([{ selector: { type: "compose-service", project: "cliproxy", service: "cli-proxy-api" }, containers: [{ id: "abc", name: "cliproxy", state: "running", access: "accessible", mounts: [], facts: [] }] }]);
            await sandboxCommand(registerSandbox()).handler("docker grant", ctx);
            const target = JSON.parse(await readFile(path, "utf8")).docker.grants[0].targets[0];
            expect(target.allowUnsafeTarget).toBe(true);
            expect(target.operations).toEqual(["ps", "inspect", "logs", "stats", "start", "stop", "restart"]);
            expect(ctx.ui.confirm).toHaveBeenCalledTimes(2);
            expect(ctx.ui.confirm).toHaveBeenCalledWith(
                "Authorize this Docker target despite host access?",
                expect.stringContaining("Arbitrary exec remains unavailable"),
            );
            expect(notifyCalls(ctx).at(-1)?.[0]).toContain("Host-access exception: enabled by the confirmed grant");
            expect(notifyCalls(ctx).at(-1)?.[1]).toBe("info");
        }, [true, true]);
    });

    it("doctor distinguishes a valid grant from a target excluded by the broker without writing", async () => {
        await withExcludedDockerTarget(async (ctx, path) => {
            const before = await readFile(path, "utf8");
            await sandboxCommand(registerSandbox()).handler("doctor", ctx);
            expect(notifyCalls(ctx).at(-1)?.[0]).toContain("Target access: blocked by the broker for this grant");
            expect(notifyCalls(ctx).at(-1)?.[0]).toContain("Host: /host/config → Container: /app/config");
            expect(notifyCalls(ctx).at(-1)?.[0]).toContain("(valid)");
            expect(await readFile(path, "utf8")).toBe(before);
        }, []);
    });

    it("doctor detects a saved configuration that differs from the active runtime", async () => {
        await withExcludedDockerTarget(async (ctx) => {
            const registered = registerSandbox();
            await registered.handlers.get("session_start")?.({}, ctx);
            await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ sandbox: { docker: { mode: "disabled" } } }));
            await sandboxCommand(registered).handler("doctor", ctx);
            const message = notifyCalls(ctx).at(-1)?.[0];
            expect(message).toContain("Configured Docker: off");
            expect(message).toContain("Active Docker: targeted · Custom");
            expect(message).toContain("Active Docker differs from the current configuration");
        }, []);
    });

    it("keeps a valid grant marked valid when target inspection is unavailable", async () => {
        await withExcludedDockerTarget(async (ctx, path) => {
            const before = await readFile(path, "utf8");
            inspectDockerAccess.mockRejectedValue(new Error("engine unavailable"));
            await sandboxCommand(registerSandbox()).handler("doctor", ctx);
            expect(notifyCalls(ctx).at(-1)?.[0]).toContain("(valid)");
            expect(notifyCalls(ctx).at(-1)?.[0]).toContain("Docker target inspection unavailable: engine unavailable");
            expect(await readFile(path, "utf8")).toBe(before);
        }, []);
    });

    it("does not save a grant when target inspection fails", async () => {
        await withExcludedDockerTarget(async (ctx, path) => {
            const before = await readFile(path, "utf8");
            inspectDockerAccess.mockRejectedValue(new Error("engine unavailable"));
            await sandboxCommand(registerSandbox()).handler("docker grant", ctx);
            expect(ctx.ui.confirm).not.toHaveBeenCalled();
            expect(notifyCalls(ctx).at(-1)?.[0]).toContain("Docker grant inspection failed");
            expect(await readFile(path, "utf8")).toBe(before);
        }, [true, true]);
    });

    it.each(["success", "reduced", "failure"] as const)("reports the confirmed exception and actual activation outcome: %s", async (outcome) => {
        await withExcludedDockerTarget(async (ctx, path) => {
            const registered = registerSandbox();
            await registered.handlers.get("session_start")?.({}, ctx);
            if (outcome === "reduced") {
                await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ sandbox: { docker: { mode: "disabled" } } }));
            }
            if (outcome === "failure") analysisPreflight.mockRejectedValueOnce(new Error("fixture activation unavailable"));
            const excluded = await inspectDockerAccess();
            inspectDockerAccess.mockResolvedValueOnce(excluded);
            inspectDockerAccess.mockResolvedValue(excluded.map((target) => ({ ...target, containers: target.containers.map((container) => ({ ...container, access: "accessible" as const })) })));
            await sandboxCommand(registered).handler("docker grant", ctx);
            const [message, level] = notifyCalls(ctx).at(-1)!;
            expect(message).toContain("Saved Docker grant: targeted · Exploitation");
            expect(message).toContain("Host-access exception: enabled by the confirmed grant");
            expect(JSON.parse(await readFile(path, "utf8")).docker.grants[0].targets[0].allowUnsafeTarget).toBe(true);
            expect(level).toBe("info");
            expect(message).toContain(outcome === "reduced" ? "Active Docker: off" : "Active Docker: targeted · Exploitation");
            if (outcome === "reduced") expect(message).not.toContain("saved and active");
        }, [true, true]);
    });

    it("does not save after accepting the exception but cancelling the final grant", async () => {
        await withExcludedDockerTarget(async (ctx, path) => {
            const before = await readFile(path, "utf8");
            inspectDockerAccess.mockResolvedValueOnce([{ selector: { type: "compose-service", project: "cliproxy", service: "cli-proxy-api" }, containers: [{ id: "abc", name: "cliproxy", state: "running", access: "excluded", mounts: [], facts: [] }] }]);
            inspectDockerAccess.mockResolvedValue([]);
            await sandboxCommand(registerSandbox()).handler("docker grant", ctx);
            expect(ctx.ui.confirm).toHaveBeenCalledTimes(2);
            expect(await readFile(path, "utf8")).toBe(before);
        }, [true, false]);
    });

    it("grants exploitation access to a selected Compose service", async () => {
        const agentDir = join(cwd, "agent-home");
        const otherProject = join(cwd, "other-project");
        const fakeBin = join(cwd, "bin");
        await mkdir(agentDir);
        await mkdir(otherProject);
        await mkdir(fakeBin);
        await writeFile(
            join(agentDir, "sandbox.global.json"),
            JSON.stringify({
                docker: {
                    grants: [{ projectRoot: otherProject, mode: "full" }],
                },
            }),
            { mode: 0o600 },
        );
        const dockerPath = join(fakeBin, "docker");
        await writeFile(
            dockerPath,
            [
                "#!/bin/sh",
                'printf \'{"name":"cliproxy","services":{"cli-proxy-api":{}}}\'',
            ].join("\n"),
        );
        await chmod(dockerPath, 0o700);

        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        const previousPath = process.env.PATH;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
        try {
            const registered = registerSandbox();
            const ctx = context(cwd, undefined, SESSION_ID, true, {
                select: ["cliproxy / cli-proxy-api", "Exploitation"],
                confirm: [true],
            });

            await sandboxCommand(registered).handler("docker grant", ctx);

            expect(
                JSON.parse(
                    await readFile(join(agentDir, "sandbox.global.json"), "utf8"),
                ),
            ).toEqual({
                $schema: "./extensions/sandbox/docs/sandbox.global.schema.json",
                docker: {
                    grants: [
                        { projectRoot: otherProject, mode: "full" },
                        {
                            projectRoot: cwd,
                            mode: "targeted",
                            targets: [
                                {
                                    selector: {
                                        type: "compose-service",
                                        project: "cliproxy",
                                        service: "cli-proxy-api",
                                    },
                                    operations: [
                                        "ps",
                                        "inspect",
                                        "logs",
                                        "stats",
                                        "start",
                                        "stop",
                                        "restart",
                                    ],
                                    allowUnsafeTarget: false,
                                },
                            ],
                        },
                    ],
                },
            });
            expect(
                notifyCalls(ctx).at(-1)?.[0],
            ).toContain("Docker grant saved, not active: Sandbox is disabled.");
            const authorityMode =
                (await stat(join(agentDir, "sandbox.global.json"))).mode & 0o777;
            expect(authorityMode).toBe(0o600);
        } finally {
            if (previousAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
            if (previousPath === undefined) delete process.env.PATH;
            else process.env.PATH = previousPath;
        }
    });

    it("falls back to a manually named container when Docker Compose is unavailable", async () => {
        const agentDir = join(cwd, "agent-home");
        const fakeBin = join(cwd, "bin");
        await mkdir(agentDir);
        await mkdir(fakeBin);
        const dockerPath = join(fakeBin, "docker");
        await writeFile(dockerPath, "#!/bin/sh\nexit 127\n");
        await chmod(dockerPath, 0o700);

        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        const previousPath = process.env.PATH;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
        try {
            const registered = registerSandbox();
            const ctx = context(cwd, undefined, SESSION_ID, true, {
                input: ["manual-api"],
                select: ["Observation"],
                confirm: [true],
            });

            await sandboxCommand(registered).handler("docker grant", ctx);

            const authority = JSON.parse(
                await readFile(join(agentDir, "sandbox.global.json"), "utf8"),
            );
            expect(authority.docker.grants[0].targets[0]).toEqual({
                selector: { type: "container-name", name: "manual-api" },
                operations: ["ps", "inspect", "logs", "stats"],
                allowUnsafeTarget: false,
            });
        } finally {
            if (previousAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
            if (previousPath === undefined) delete process.env.PATH;
            else process.env.PATH = previousPath;
        }
    });

    it("grants administration access only when explicitly selected", async () => {
        const agentDir = join(cwd, "agent-home");
        const fakeBin = join(cwd, "bin");
        await mkdir(agentDir);
        await mkdir(fakeBin);
        const dockerPath = join(fakeBin, "docker");
        await writeFile(dockerPath, "#!/bin/sh\nexit 127\n");
        await chmod(dockerPath, 0o700);
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        const previousPath = process.env.PATH;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
        try {
            const registered = registerSandbox();
            const ctx = context(cwd, undefined, SESSION_ID, true, {
                input: ["manual-api"],
                select: ["Administration"],
                confirm: [true],
            });

            await sandboxCommand(registered).handler("docker grant", ctx);

            const authority = JSON.parse(
                await readFile(join(agentDir, "sandbox.global.json"), "utf8"),
            );
            expect(authority.docker.grants[0].targets[0].operations).toEqual([
                "ps",
                "inspect",
                "logs",
                "stats",
                "exec",
                "start",
                "stop",
                "restart",
            ]);
        } finally {
            if (previousAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
            if (previousPath === undefined) delete process.env.PATH;
            else process.env.PATH = previousPath;
        }
    });

    it("activates break-glass only for the current container and never persists it", async () => {
        const agentDir = join(cwd, "agent-home");
        const authorityPath = await configureBreakGlassTarget(cwd, agentDir);
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        try {
            const registered = registerSandbox();
            const ctx = context(cwd, undefined, SESSION_ID, true, { confirm: [true] });
            await registered.handlers.get("session_start")?.({}, ctx);
            const before = await readFile(authorityPath, "utf8");

            const startedAt = Date.now();
            await sandboxCommand(registered).handler(
                "docker break-glass 15m",
                ctx,
            );

            const runtime = getSandboxRuntime();
            expect(runtime.state).toBe("enabled");
            expect(runtime.state === "enabled" && runtime.dockerAccess?.breakGlass?.[0]?.containerId).toBe("0123456789abcdef");
            const serviceOptions = createSandboxService.mock.calls.at(-1)?.[0] as unknown as { config: { docker: { targets: Array<{ selector: { type: string; id?: string; unsafeExecExpiresAtMs?: number } }> } } };
            const ephemeral = serviceOptions.config.docker.targets.find((target) => target.selector.type === "ephemeral-container");
            expect(ephemeral?.selector.id).toBe("0123456789abcdef");
            expect(ephemeral?.selector.unsafeExecExpiresAtMs).toBeGreaterThanOrEqual(
                startedAt + 15 * 60 * 1000,
            );
            expect(ephemeral?.selector.unsafeExecExpiresAtMs).toBeLessThanOrEqual(
                Date.now() + 15 * 60 * 1000,
            );
            expect(await readFile(authorityPath, "utf8")).toBe(before);
            expect(notifyCalls(ctx).at(-1)?.[0]).toContain("Break-glass exec active for container api-current");
            expect(notifyCalls(ctx).at(-1)?.[0]).toContain("Host: /host/auths → Container: /auths (read-write)");
            expect(registered.sentMessages).toContainEqual({
                message: expect.objectContaining({
                    customType: "sandbox-runtime-feedback",
                    display: false,
                    content: expect.stringContaining(
                        "Docker break-glass is active for api-current (0123456789abcdef) until",
                    ),
                }),
                options: { deliverAs: "steer" },
            });
        } finally {
            if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        }
    });

    it("rejects a break-glass duration outside the one-to-thirty-minute range", async () => {
        const registered = registerSandbox();
        const ctx = context(cwd);

        await sandboxCommand(registered).handler("docker break-glass 31m", ctx);

        expect(notifyCalls(ctx).at(-1)).toEqual([
            "Docker break-glass duration must be between 1m and 30m. Usage: /sandbox docker break-glass [5m|15m|30m]",
            "error",
        ]);
        expect(inspectDockerAccess).not.toHaveBeenCalled();
        expect(registered.sentMessages).toEqual([]);
    });

    it("tells the agent when break-glass expires and reports interrupted executions", async () => {
        const agentDir = join(cwd, "agent-home");
        await configureBreakGlassTarget(cwd, agentDir);
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        let expiryCallback: (() => void) | undefined;
        const originalSetTimeout = globalThis.setTimeout;
        const timeout = spyOn(globalThis, "setTimeout").mockImplementation(
            ((callback: (...args: unknown[]) => void, delay?: number) => {
                if ((delay ?? 0) >= 60_000) {
                    expiryCallback = () => callback();
                    const handle = originalSetTimeout(() => undefined, delay);
                    handle.unref();
                    return handle;
                }
                return originalSetTimeout(callback, delay);
            }) as typeof setTimeout,
        );
        try {
            const registered = registerSandbox();
            const ctx = context(cwd, undefined, SESSION_ID, true, {
                confirm: [true],
            });
            await registered.handlers.get("session_start")?.({}, ctx);
            await sandboxCommand(registered).handler("docker break-glass", ctx);
            const running = createSandboxBashOperations().exec("sleep 30", cwd, {
                onData: () => undefined,
            });
            await Bun.sleep(20);

            expiryCallback?.();
            expect(registered.sentMessages.at(-1)).toEqual({
                message: expect.objectContaining({
                    customType: "sandbox-runtime-feedback",
                    display: false,
                    content: expect.stringMatching(
                        /break-glass expired.*no longer authorized/is,
                    ),
                }),
                options: { deliverAs: "steer" },
            });
            await expect(running).rejects.toThrow("interrupted by reconfiguration");
            await Bun.sleep(10);

            expect(registered.sentMessages).toContainEqual({
                message: expect.objectContaining({
                    customType: "sandbox-runtime-feedback",
                    display: false,
                    content: expect.stringMatching(
                        /1 running Sandbox execution was interrupted.*was not retried/is,
                    ),
                }),
                options: { deliverAs: "steer" },
            });
        } finally {
            timeout.mockRestore();
            if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        }
    });

    it("reconfigures an active Sandbox after saving a Docker grant", async () => {
        const agentDir = join(cwd, "agent-home");
        const fakeBin = join(cwd, "bin");
        await mkdir(agentDir);
        await mkdir(fakeBin);
        const dockerPath = join(fakeBin, "docker");
        await writeFile(dockerPath, "#!/bin/sh\nexit 127\n");
        await chmod(dockerPath, 0o700);
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        const previousPath = process.env.PATH;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
        try {
            const registered = registerSandbox();
            const ctx = context(cwd, undefined, SESSION_ID, true, {
                input: ["manual-api"],
                select: ["Observation"],
                confirm: [true],
            });
            await registered.handlers.get("session_start")?.({}, ctx);
            expect(getSandboxRuntime().state).toBe("enabled");

            await sandboxCommand(registered).handler("docker grant", ctx);

            expect(reset).toHaveBeenCalledTimes(1);
            expect(initialize).toHaveBeenCalledTimes(2);
            expect(getSandboxRuntime().state).toBe("enabled");
            expect(notifyCalls(ctx).at(-1)).toEqual([
                expect.stringContaining("Active Docker: targeted · Observation · 1 target"),
                "info",
            ]);
            expect(notifyCalls(ctx).at(-1)?.[0]).toContain("container-name: manual-api");
            expect(notifyCalls(ctx).at(-1)?.[0]).toContain("Operations: ps, inspect, logs, stats");
            const runtime = getSandboxRuntime();
            expect(runtime.state === "enabled" && runtime.dockerAccess?.profile).toBe("Observation");
        } finally {
            if (previousAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
            if (previousPath === undefined) delete process.env.PATH;
            else process.env.PATH = previousPath;
        }
    });

    it("does not write a Docker grant after selection cancellation", async () => {
        const agentDir = join(cwd, "agent-home");
        const fakeBin = join(cwd, "bin");
        await mkdir(agentDir);
        await mkdir(fakeBin);
        const dockerPath = join(fakeBin, "docker");
        await writeFile(
            dockerPath,
            [
                "#!/bin/sh",
                'printf \'{"name":"cliproxy","services":{"cli-proxy-api":{}}}\'',
            ].join("\n"),
        );
        await chmod(dockerPath, 0o700);
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        const previousPath = process.env.PATH;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
        try {
            const registered = registerSandbox();
            const ctx = context(cwd, undefined, SESSION_ID, true, {
                select: [undefined],
            });

            await sandboxCommand(registered).handler("docker grant", ctx);

            await expect(
                readFile(join(agentDir, "sandbox.global.json"), "utf8"),
            ).rejects.toMatchObject({ code: "ENOENT" });
            expect(notifyCalls(ctx).at(-1)).toEqual([
                "Docker grant cancelled",
                "info",
            ]);
        } finally {
            if (previousAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
            if (previousPath === undefined) delete process.env.PATH;
            else process.env.PATH = previousPath;
        }
    });

    it("refuses a Docker grant for an untrusted project without discovery or writing", async () => {
        const agentDir = join(cwd, "agent-home");
        await mkdir(agentDir);
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        try {
            const registered = registerSandbox();
            const ctx = context(cwd, undefined, SESSION_ID, false);

            await sandboxCommand(registered).handler("docker grant", ctx);

            expect(notifyCalls(ctx).at(-1)).toEqual([
                "Docker grants require a trusted project",
                "error",
            ]);
            await expect(
                readFile(join(agentDir, "sandbox.global.json"), "utf8"),
            ).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            if (previousAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
        }
    });

    it("does not replace an untrusted global Docker authority file", async () => {
        const agentDir = join(cwd, "agent-home");
        const fakeBin = join(cwd, "bin");
        await mkdir(agentDir);
        await mkdir(fakeBin);
        const authorityPath = join(agentDir, "sandbox.global.json");
        await writeFile(authorityPath, '{"docker":{"grants":[]}}\n');
        await chmod(authorityPath, 0o622);
        const dockerPath = join(fakeBin, "docker");
        await writeFile(dockerPath, "#!/bin/sh\nexit 127\n");
        await chmod(dockerPath, 0o700);
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        const previousPath = process.env.PATH;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
        try {
            const registered = registerSandbox();
            const ctx = context(cwd, undefined, SESSION_ID, true, {
                input: ["manual-api"],
                select: ["Administration"],
                confirm: [true],
            });

            await sandboxCommand(registered).handler("docker grant", ctx);

            expect(await readFile(authorityPath, "utf8")).toBe(
                '{"docker":{"grants":[]}}\n',
            );
            expect(notifyCalls(ctx).at(-1)).toEqual([
                expect.stringContaining("Untrusted global Docker authority file"),
                "error",
            ]);
        } finally {
            if (previousAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
            if (previousPath === undefined) delete process.env.PATH;
            else process.env.PATH = previousPath;
        }
    });

    it("refuses Docker project changes for an untrusted project", async () => {
        const registered = registerSandbox();
        const ctx = context(cwd, undefined, SESSION_ID, false);

        await sandboxCommand(registered).handler("docker off", ctx);

        expect(notifyCalls(ctx).at(-1)).toEqual([
            "Docker project preference requires a trusted project",
            "error",
        ]);
        await expect(
            readFile(join(cwd, ".pi", "settings.json"), "utf8"),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("rejects Docker escalation without mutating project settings", async () => {
        const registered = registerSandbox();
        const ctx = context(cwd);

        await sandboxCommand(registered).handler("docker targeted", ctx);

        expect(notifyCalls(ctx).at(-1)).toEqual([
            expect.stringContaining("Project attempted to enable Docker"),
            "error",
        ]);
        await expect(
            readFile(join(cwd, ".pi", "settings.json"), "utf8"),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("explains why full authority cannot become targeted without targets", async () => {
        const agentDir = join(cwd, "agent-home");
        await mkdir(agentDir);
        await writeFile(
            join(agentDir, "sandbox.global.json"),
            JSON.stringify({
                docker: {
                    grants: [{ projectRoot: cwd, mode: "full" }],
                },
            }),
            { mode: 0o600 },
        );
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        try {
            const registered = registerSandbox();
            const ctx = context(cwd);

            await sandboxCommand(registered).handler("docker targeted", ctx);

            expect(notifyCalls(ctx).at(-1)).toEqual([
                "Docker configuration failed: Targeted narrowing of full Docker requires targets",
                "error",
            ]);
            await expect(
                readFile(join(cwd, ".pi", "settings.json"), "utf8"),
            ).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            if (previousAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
        }
    });

    it("restarts an active sandbox after saving a Docker preference", async () => {
        const registered = registerSandbox();
        const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);
        expect(getSandboxRuntime().state).toBe("enabled");

        await sandboxCommand(registered).handler("docker off", ctx);

        expect(reset).toHaveBeenCalledTimes(1);
        expect(initialize).toHaveBeenCalledTimes(2);
        expect(getSandboxRuntime().state).toBe("enabled");
        expect(notifyCalls(ctx).at(-1)).toEqual([
            "Docker project preference saved: off\nActive Docker: off",
            "info",
        ]);
    });

    it("fails closed and surfaces the real Docker reconfiguration error", async () => {
        const registered = registerSandbox();
        const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);
        initialize.mockRejectedValueOnce(new Error("docker broker unavailable"));

        await sandboxCommand(registered).handler("docker off", ctx);

        expect(getSandboxRuntime().state).toBe("error");
        expect(notifyCalls(ctx).at(-1)).toEqual([
            "Docker preference saved, but sandbox reconfiguration failed: docker broker unavailable",
            "error",
        ]);
        const settings = JSON.parse(
            await readFile(join(cwd, ".pi", "settings.json"), "utf8"),
        );
        expect(settings.sandbox.docker).toEqual({ mode: "disabled" });
    });

    it("keeps a later off request authoritative over an in-flight enable", async () => {
        await writeFile(
            join(cwd, ".pi", "sandbox.json"),
            JSON.stringify({ enabled: false }),
        );
        const registered = registerSandbox();
        const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);

        const preflight = deferred();
        analysisPreflight.mockImplementationOnce(() => preflight.promise);
        const enabling = sandboxCommand(registered).handler("on", ctx);
        await Bun.sleep(10);
        const disabling = sandboxCommand(registered).handler("off", ctx);
        await disabling;
        expect(getSandboxRuntime().state).toBe("disabled");

        preflight.resolve();
        await enabling;
        expect(getSandboxRuntime().state).toBe("disabled");
        expect(analysisShutdown).toHaveBeenCalledTimes(1);
        expect(reset).toHaveBeenCalledTimes(1);
    });

    it("surfaces cleanup failure from an in-flight candidate before disabling", async () => {
        await writeFile(
            join(cwd, ".pi", "sandbox.json"),
            JSON.stringify({ enabled: false }),
        );
        const registered = registerSandbox();
        const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);

        const preflight = deferred();
        analysisPreflight.mockImplementationOnce(() => preflight.promise);
        reset.mockRejectedValueOnce(new Error("late candidate cleanup failed"));
        const enabling = sandboxCommand(registered).handler("on", ctx);
        await Bun.sleep(10);

        await sandboxCommand(registered).handler("off", ctx);
        expect(reset).toHaveBeenCalledTimes(1);
        expect(getSandboxRuntime().state).toBe("error");
        expect(notifyCalls(ctx).at(-1)).toEqual([
            expect.stringContaining("late candidate cleanup failed"),
            "error",
        ]);

        preflight.resolve();
        await enabling;
        expect(reset).toHaveBeenCalledTimes(1);
        expect(getSandboxRuntime().state).toBe("error");

        await sandboxCommand(registered).handler("off", ctx);
        expect(getSandboxRuntime().state).toBe("disabled");
    });

    it("does not publish a candidate after session shutdown supersedes startup", async () => {
        const preflight = deferred();
        analysisPreflight.mockImplementationOnce(() => preflight.promise);
        const registered = registerSandbox();
        const ctx = context(cwd);

        const starting = registered.handlers.get("session_start")?.({}, ctx);
        await Bun.sleep(10);
        await registered.handlers.get("session_shutdown")?.({}, ctx);
        expect(getSandboxRuntime().state).toBe("uninitialized");

        preflight.resolve();
        await starting;
        expect(getSandboxRuntime().state).toBe("uninitialized");
        expect(analysisShutdown).toHaveBeenCalledTimes(1);
        expect(reset).toHaveBeenCalledTimes(1);
    });

    it("publishes error instead of local execution when reset fails", async () => {
        const registered = registerSandbox();
        const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);
        reset.mockRejectedValueOnce(new Error("reset failed"));

        await sandboxCommand(registered).handler("off", ctx);

        expect(getSandboxRuntime().state).toBe("error");
        let captured: unknown;
        try {
            await createSandboxBashOperations().exec(...execArgs);
            throw new Error("expected reset-failed to fail");
        } catch (error) {
            captured = error;
        }
        // Exact bounded public reason — the security contract never
        // forwards the publisher's raw reset-failure text.
        expect(captured).toBeInstanceOf(Error);
        if (!(captured instanceof Error)) {
            throw new Error("captured was not an Error");
        }
        expect(captured.message).toBe(
            "Sandbox execution unavailable: initialization failed",
        );
        // Provenance: the error is the typed SandboxUnavailableError
        // with the closed-set kind carried on the non-enumerable `kind`
        // slot.
        expect(isSandboxUnavailableError(captured)).toBe(true);
        if (isSandboxUnavailableError(captured)) {
            expect(captured.getKind()).toBe("initialization-failed");
        }
        // The raw reset secret (the publisher's raw error message) MUST
        // NEVER reach the surfaced message nor a JSON dump. It is held
        // only on the non-enumerable `initError` slot for telemetry,
        // accessible via the typed accessor.
        const serialized = JSON.stringify(captured);
        expect(captured.message).not.toContain("reset failed");
        expect(serialized).not.toContain("reset failed");

        await sandboxCommand(registered).handler("off", ctx);
        expect(reset).toHaveBeenCalledTimes(2);
        expect(getSandboxRuntime().state).toBe("disabled");
    });

    it("supports Pi's awaited shutdown-old then start-new reload sequence", async () => {
        const first = registerSandbox();
        const ctx = context(cwd);
        await first.handlers.get("session_start")?.({}, ctx);
        await first.handlers.get("session_shutdown")?.({}, ctx);
        expect(getSandboxRuntime().state).toBe("uninitialized");

        const second = registerSandbox();
        await second.handlers.get("session_start")?.({}, ctx);

        expect(reset).toHaveBeenCalledTimes(1);
        expect(getSandboxRuntime().state).toBe("enabled");
    });

    it("cleans an obsolete instance without disturbing the newer runtime", async () => {
        const first = registerSandbox();
        const ctx = context(cwd);
        await first.handlers.get("session_start")?.({}, ctx);

        const second = registerSandbox();
        await second.handlers.get("session_start")?.({}, ctx);
        const currentRuntime = getSandboxRuntime();
        expect(currentRuntime.state).toBe("enabled");

        await first.handlers.get("session_shutdown")?.({}, ctx);

        expect(reset).toHaveBeenCalledTimes(1);
        expect(analysisShutdown).toHaveBeenCalledTimes(1);
        expect(getSandboxRuntime()).toBe(currentRuntime);

        await second.handlers.get("session_shutdown")?.({}, ctx);
    });

    it("keeps ownership and retries when session shutdown cleanup fails", async () => {
        const registered = registerSandbox();
        const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);
        reset.mockRejectedValueOnce(new Error("shutdown cleanup failed"));

        await expect(
            registered.handlers.get("session_shutdown")?.({}, ctx),
        ).rejects.toThrow("shutdown cleanup failed");
        expect(getSandboxRuntime().state).toBe("error");

        await registered.handlers.get("session_shutdown")?.({}, ctx);
        expect(reset).toHaveBeenCalledTimes(2);
        expect(getSandboxRuntime().state).toBe("uninitialized");
    });
});

describe("sandbox per-session persistence and propagation", () => {
    let cwd: string;
    let sessionDir: string;
    let originalEnv: string | undefined;

    const stateFile = (sessionId = SESSION_ID): string =>
        join(sessionDir, sessionStateFilename(sessionId));

    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), "sandbox-persist-"));
        sessionDir = await mkdtemp(join(tmpdir(), "sandbox-session-"));
        await mkdir(join(cwd, ".pi"));
        await writeFile(
            join(cwd, ".pi", "sandbox.json"),
            JSON.stringify({ enabled: true }),
        );
        initialize.mockReset();
        initialize.mockImplementation(async () => undefined);
        reset.mockReset();
        reset.mockImplementation(async () => undefined);
        analysisShutdown.mockClear();
        analysisPreflight.mockReset();
        analysisPreflight.mockImplementation(async () => undefined);
        createAnalysisSandboxService.mockClear();
        capturedWidgetDef.def = null;
        originalEnv = process.env[ENV_KEY];
        delete process.env[ENV_KEY];
    });

    afterEach(async () => {
        await rm(cwd, { recursive: true, force: true });
        await rm(sessionDir, { recursive: true, force: true });
        if (originalEnv === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = originalEnv;
    });

    it("restores the sandbox status from its session-scoped state file", async () => {
        await writeFile(
            stateFile(),
            JSON.stringify({ enabled: false, updatedAt: "2026-01-01T00:00:00.000Z" }),
        );
        const registered = registerSandbox();
        const ctx = context(cwd, sessionDir);

        await registered.handlers.get("session_start")?.({}, ctx);

        expect(getSandboxRuntime().state).toBe("disabled");
        const widget = renderWidget();
        expect(widget).not.toBeNull();
        expect(widget).toContain("⚠");
        expect(widget).toContain("fg:warning:");

        // notify called with warning containing "DISABLED"
        const calls = notifyCalls(ctx);
        const warningCalls = calls.filter(([, level]) => level === "warning");
        expect(warningCalls.length).toBeGreaterThan(0);
        expect(warningCalls[0][0]).toContain("DISABLED");
        expect(warningCalls[0][0]).toContain("session-file");
    });

    it("PI_SANDBOX_SESSION_STATUS=disabled forces disabled and overrides file", async () => {
        await writeFile(
            stateFile(),
            JSON.stringify({ enabled: true, updatedAt: "2026-01-01T00:00:00.000Z" }),
        );
        process.env[ENV_KEY] = "disabled";

        const registered = registerSandbox();
        const ctx = context(cwd, sessionDir);

        await registered.handlers.get("session_start")?.({}, ctx);

        expect(getSandboxRuntime().state).toBe("disabled");
        const calls = notifyCalls(ctx);
        const warningCalls = calls.filter(([, level]) => level === "warning");
        expect(warningCalls.some(([m]) => m.includes("env"))).toBe(true);
    });

    it("does NOT emit a security warning when explicitlyDisabled is false (default source)", async () => {
        // Reach into the extension: directly verify the warning gate helper.
        // (Default-off cannot be exercised here without controlling the global
        //  ~/.pi/agent/sandbox.json; that case is unit-tested in index.test.ts.)
        const { explicitlyDisabled } = await import("./index.ts");
        const resolved = {
            config: { enabled: false } as Parameters<
                typeof explicitlyDisabled
            >[0]["config"],
            source: "default" as const,
        };
        expect(explicitlyDisabled(resolved)).toBe(false);
    });

    it("--no-sandbox flag wins over session file and emits warning", async () => {
        await writeFile(
            stateFile(),
            JSON.stringify({ enabled: true, updatedAt: "2026-01-01T00:00:00.000Z" }),
        );
        const handlers = new Map<string, Handler>();
        const pi = {
            registerFlag: () => undefined,
            registerTool: () => undefined,
            registerCommand: () => undefined,
            on: (event: string, handler: Handler) => handlers.set(event, handler),
            getFlag: () => true, // --no-sandbox
        } as unknown as ExtensionAPI;
        sandboxExtension(pi);
        const ctx = context(cwd, sessionDir);

        await handlers.get("session_start")?.({}, ctx);

        expect(getSandboxRuntime().state).toBe("disabled");
        const fileExists = await readFile(
            stateFile(),
            "utf-8",
        ).then(
            () => true,
            () => false,
        );
        // --no-sandbox does not modify the persisted file (it's a one-shot override).
        expect(fileExists).toBe(true);

        const calls = notifyCalls(ctx);
        const warningCalls = calls.filter(([, level]) => level === "warning");
        expect(
            warningCalls.some(([m]) => m.includes("--no-sandbox")),
        ).toBe(true);
    });

    it("/sandbox off persists file and sets env var + emits security warning", async () => {
        const registered = registerSandbox();
        const ctx = context(cwd, sessionDir);
        await registered.handlers.get("session_start")?.({}, ctx);

        await sandboxCommand(registered).handler("off", ctx);

        expect(getSandboxRuntime().state).toBe("disabled");
        expect(process.env[ENV_KEY]).toBe("disabled");
        const saved = JSON.parse(await readFile(stateFile(), "utf-8"));
        expect(saved.enabled).toBe(false);
        expect(typeof saved.updatedAt).toBe("string");

        const calls = notifyCalls(ctx);
        const securityWarning = calls.filter(
            ([m, level]) =>
                level === "warning" &&
                (m.includes("security risk") || m.includes("DISABLED")),
        );
        expect(securityWarning.length).toBeGreaterThan(0);
    });

    it("/sandbox on persists file and sets env var", async () => {
        await writeFile(
            stateFile(),
            JSON.stringify({ enabled: false, updatedAt: "2026-01-01T00:00:00.000Z" }),
        );
        const registered = registerSandbox();
        const ctx = context(cwd, sessionDir);
        await registered.handlers.get("session_start")?.({}, ctx);

        await sandboxCommand(registered).handler("on", ctx);

        expect(getSandboxRuntime().state).toBe("enabled");
        expect(process.env[ENV_KEY]).toBe("enabled");
        const saved = JSON.parse(await readFile(stateFile(), "utf-8"));
        expect(saved.enabled).toBe(true);
    });

    it("does not leak a session toggle into the next Pi session", async () => {
        const first = registerSandbox();
        const firstContext = context(cwd, sessionDir, SESSION_ID);
        await first.handlers.get("session_start")?.({}, firstContext);
        await sandboxCommand(first).handler("off", firstContext);
        expect(process.env[ENV_KEY]).toBe("disabled");

        await first.handlers.get("session_shutdown")?.({}, firstContext);
        expect(process.env[ENV_KEY]).toBeUndefined();

        const second = registerSandbox();
        await second.handlers
            .get("session_start")
            ?.({}, context(cwd, sessionDir, "session-b"));
        expect(getSandboxRuntime().state).toBe("enabled");
    });

    it("restores a genuinely inherited session override after shutdown", async () => {
        process.env[ENV_KEY] = "disabled";
        const registered = registerSandbox();
        const ctx = context(cwd, sessionDir);
        await registered.handlers.get("session_start")?.({}, ctx);
        await sandboxCommand(registered).handler("on", ctx);
        expect(process.env[ENV_KEY]).toBe("enabled");

        await registered.handlers.get("session_shutdown")?.({}, ctx);
        expect(process.env[ENV_KEY]).toBe("disabled");
    });

    it("subagent child sees env var and applies it on its own session_start", async () => {
        // Simulate the parent having toggled on. The child process inherits env.
        process.env[ENV_KEY] = "disabled";
        // The child has its OWN session dir (fresh sandbox session), but inherits the env.
        const childSessionDir = await mkdtemp(join(tmpdir(), "sandbox-child-"));
        try {
            const registered = registerSandbox();
            const ctx = context(cwd, childSessionDir);

            await registered.handlers.get("session_start")?.({}, ctx);

            expect(getSandboxRuntime().state).toBe("disabled");
            const widget = renderWidget();
            expect(widget).toContain("⚠");
        } finally {
            await rm(childSessionDir, { recursive: true, force: true });
        }
    });

    it("widget renders the disabled warning glyph after /sandbox off", async () => {
        const registered = registerSandbox();
        const ctx = context(cwd, sessionDir);
        await registered.handlers.get("session_start")?.({}, ctx);
        await sandboxCommand(registered).handler("off", ctx);

        const widget = renderWidget();
        expect(widget).not.toBeNull();
        expect(widget).toContain("⚠");
        expect(widget).toContain("fg:warning:");
    });
});
