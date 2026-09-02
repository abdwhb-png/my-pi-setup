/// <reference types="bun" />

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const wrapWithSandbox = mock(async (command: string) => command);
const cleanupAfterCommand = mock(() => undefined);
const analysisShutdown = mock(async () => undefined);
const createAnalysisSandboxService = mock(() => ({
    run: mock(async () => ({
        output: "ok",
        stderr: "",
        runtime: "quickjs" as const,
        durationMs: 1,
        truncated: false,
    })),
    shutdown: analysisShutdown,
}));

const capturedWidgetDef: {
    def: {
        render: (ctx: { theme: Theme; ctx: ExtensionContext }) => unknown;
    } | null;
} = { def: null };

mock.module("@anthropic-ai/sandbox-runtime", () => ({
    SandboxManager: {
        initialize,
        reset,
        wrapWithSandbox,
        cleanupAfterCommand,
    },
}));
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

const {
    default: sandboxExtension,
} = await import("./index.ts");
const {
    createSharedBashOperations,
    getSandboxExecutionState,
} = await import("../_shared/bash/sandbox-execution-broker.ts");
const {
    getAnalysisSandboxBrokerState,
    getAnalysisSandboxService,
} = await import("../_shared/analysis/sandbox-analysis-broker.ts");

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void>;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;

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
    const commands = new Map<string, CommandHandler>();
    const pi = {
        registerFlag: () => undefined,
        registerTool: () => undefined,
        registerCommand: (
            name: string,
            definition: { handler: CommandHandler },
        ) => commands.set(name, definition.handler),
        on: (event: string, handler: Handler) => handlers.set(event, handler),
        getFlag: () => false,
    } as unknown as ExtensionAPI;
    sandboxExtension(pi);
    return { handlers, commands };
}

function context(
    cwd: string,
    sessionDir?: string,
): ExtensionContext {
    const notify = mock((_message: string, _level?: string) => undefined);
    (context as unknown as { notify?: typeof notify }).notify = notify;
    return {
        cwd,
        hasUI: false,
        ui: { notify },
        sessionManager: sessionDir
            ? ({ getSessionDir: () => sessionDir } as unknown as ExtensionContext["sessionManager"])
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
        await createSharedBashOperations().exec(...execArgs);
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

        expect(getAnalysisSandboxBrokerState()).toBe("enabled");
        expect(createAnalysisSandboxService).toHaveBeenCalledTimes(1);
        await expect(
            getAnalysisSandboxService().run({
                id: "analysis-call",
                language: "javascript",
                program: "export default 1",
            }),
        ).resolves.toMatchObject({ output: "ok" });

        await registered.handlers.get("session_shutdown")?.({}, ctx);
        expect(analysisShutdown).toHaveBeenCalledTimes(1);
        expect(getAnalysisSandboxBrokerState()).toBe("uninitialized");
    });

    it("blocks execution while sandbox on and off transitions are pending", async () => {
        await writeFile(
            join(cwd, ".pi", "sandbox.json"),
            JSON.stringify({ enabled: false }),
        );
        const registered = registerSandbox();
        const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);
        expect(getSandboxExecutionState()).toBe("disabled");

        const enabling = deferred();
        initialize.mockImplementation(() => enabling.promise);
        const enableTransition = registered.commands.get("sandbox")?.("on", ctx);
        expect(getSandboxExecutionState()).toBe("uninitialized");
        await expectUnavailable("uninitialized");
        enabling.resolve();
        await enableTransition;
        expect(getSandboxExecutionState()).toBe("enabled");

        const disabling = deferred();
        reset.mockImplementation(() => disabling.promise);
        const disableTransition = registered.commands.get("sandbox")?.("off", ctx);
        expect(getSandboxExecutionState()).toBe("uninitialized");
        await expectUnavailable("uninitialized");
        disabling.resolve();
        await disableTransition;
        expect(getSandboxExecutionState()).toBe("disabled");
    });

    it("publishes error instead of local execution when reset fails", async () => {
        const registered = registerSandbox();
        const ctx = context(cwd);
        await registered.handlers.get("session_start")?.({}, ctx);
        reset.mockRejectedValueOnce(new Error("reset failed"));

        await registered.commands.get("sandbox")?.("off", ctx);

        expect(getSandboxExecutionState()).toBe("error");
        await expectUnavailable("reset failed");
    });

    it("does not let stale shutdown reset the current owner runtime", async () => {
        const first = registerSandbox();
        const ctx = context(cwd);
        await first.handlers.get("session_start")?.({}, ctx);

        const second = registerSandbox();
        await second.handlers.get("session_start")?.({}, ctx);
        reset.mockClear();

        await first.handlers.get("session_shutdown")?.({}, ctx);

        expect(reset).not.toHaveBeenCalled();
        expect(getSandboxExecutionState()).toBe("enabled");
    });
});

describe("sandbox per-session persistence and propagation", () => {
    let cwd: string;
    let sessionDir: string;
    let originalEnv: string | undefined;

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

    it("restores the sandbox status from sandbox-state.json on reload", async () => {
        await writeFile(
            join(sessionDir, "sandbox-state.json"),
            JSON.stringify({ enabled: false, updatedAt: "2026-01-01T00:00:00.000Z" }),
        );
        const registered = registerSandbox();
        const ctx = context(cwd, sessionDir);

        await registered.handlers.get("session_start")?.({}, ctx);

        expect(getSandboxExecutionState()).toBe("disabled");
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
            join(sessionDir, "sandbox-state.json"),
            JSON.stringify({ enabled: true, updatedAt: "2026-01-01T00:00:00.000Z" }),
        );
        process.env[ENV_KEY] = "disabled";

        const registered = registerSandbox();
        const ctx = context(cwd, sessionDir);

        await registered.handlers.get("session_start")?.({}, ctx);

        expect(getSandboxExecutionState()).toBe("disabled");
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
            join(sessionDir, "sandbox-state.json"),
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

        expect(getSandboxExecutionState()).toBe("disabled");
        const fileExists = await readFile(
            join(sessionDir, "sandbox-state.json"),
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

        await registered.commands.get("sandbox")?.("off", ctx);

        expect(getSandboxExecutionState()).toBe("disabled");
        expect(process.env[ENV_KEY]).toBe("disabled");
        const saved = JSON.parse(
            await readFile(join(sessionDir, "sandbox-state.json"), "utf-8"),
        );
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
            join(sessionDir, "sandbox-state.json"),
            JSON.stringify({ enabled: false, updatedAt: "2026-01-01T00:00:00.000Z" }),
        );
        const registered = registerSandbox();
        const ctx = context(cwd, sessionDir);
        await registered.handlers.get("session_start")?.({}, ctx);

        await registered.commands.get("sandbox")?.("on", ctx);

        expect(getSandboxExecutionState()).toBe("enabled");
        expect(process.env[ENV_KEY]).toBe("enabled");
        const saved = JSON.parse(
            await readFile(join(sessionDir, "sandbox-state.json"), "utf-8"),
        );
        expect(saved.enabled).toBe(true);
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

            expect(getSandboxExecutionState()).toBe("disabled");
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
        await registered.commands.get("sandbox")?.("off", ctx);

        const widget = renderWidget();
        expect(widget).not.toBeNull();
        expect(widget).toContain("⚠");
        expect(widget).toContain("fg:warning:");
    });
});
