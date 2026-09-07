/// <reference types="bun" />

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
    BashOperations,
    ExtensionAPI,
    ExtensionContext,
    Theme,
} from "@earendil-works/pi-coding-agent";

const initialize = mock(async (): Promise<void> => undefined);
const reset = mock(async (): Promise<void> => undefined);
const createZeroboxBackend = mock(() => ({}));
const createSandboxService = mock(() => ({
    probe: initialize,
    startBashSession: initialize,
    prepareBash: mock(async () => {
        throw new Error("not exercised");
    }),
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

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void>;
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
    const pi = {
        registerFlag: () => undefined,
        registerTool: () => undefined,
        registerCommand: (
            name: string,
            definition: CommandDefinition,
        ) => commands.set(name, definition),
        on: (event: string, handler: Handler) => handlers.set(event, handler),
        getFlag: () => false,
    } as unknown as ExtensionAPI;
    sandboxExtension(pi);
    return { handlers, commands };
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

    it("keeps both brokers unpublished until Analysis preflight succeeds", async () => {
        const preflight = deferred();
        analysisPreflight.mockImplementation(() => preflight.promise);
        const registered = registerSandbox();
        const ctx = context(cwd);

        const starting = registered.handlers.get("session_start")?.({}, ctx);
        await Bun.sleep(10);
        expect(getSandboxRuntime().state).toBe("uninitialized");
        expect(getSandboxRuntime().state).toBe("uninitialized");

        preflight.reject(new Error("analysis preflight failed"));
        await starting;
        expect(getSandboxRuntime().state).toBe("error");
        expect(getSandboxRuntime().state).toBe("error");
        expect(analysisShutdown).toHaveBeenCalledTimes(1);
        expect(reset).toHaveBeenCalledTimes(1);
    });

    it("retains a failed candidate cleanup for the next transition", async () => {
        analysisPreflight.mockRejectedValueOnce(new Error("preflight failed"));
        reset.mockRejectedValueOnce(new Error("candidate cleanup failed"));
        const registered = registerSandbox();
        const ctx = context(cwd);

        await registered.handlers.get("session_start")?.({}, ctx);
        expect(getSandboxRuntime().state).toBe("error");
        expect(reset).toHaveBeenCalledTimes(1);

        await sandboxCommand(registered).handler("off", ctx);
        expect(reset).toHaveBeenCalledTimes(2);
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

    it("blocks execution while sandbox on and off transitions are pending", async () => {
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
        expect(getSandboxRuntime().state).toBe("uninitialized");
        await expectUnavailable("uninitialized");
        enabling.resolve();
        await enableTransition;
        expect(getSandboxRuntime().state).toBe("enabled");

        const disabling = deferred();
        reset.mockImplementation(() => disabling.promise);
        const disableTransition = sandboxCommand(registered).handler("off", ctx);
        expect(getSandboxRuntime().state).toBe("uninitialized");
        await expectUnavailable("uninitialized");
        disabling.resolve();
        await disableTransition;
        expect(getSandboxRuntime().state).toBe("disabled");
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
                "Docker authority: off",
                "Project preference: inherit",
                "Effective policy: off",
                "Runtime: inactive (sandbox off)",
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
                    "Effective Docker: off",
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
            ).toContain("Docker grant saved for this project");
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
                "Docker grant saved for this project",
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
            "Docker project preference saved: off",
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
        expect(reset).toHaveBeenCalledTimes(2);
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
