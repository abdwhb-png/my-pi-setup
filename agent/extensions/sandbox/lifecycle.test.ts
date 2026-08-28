/// <reference types="bun" />

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
    BashOperations,
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const initialize = mock(async (): Promise<void> => undefined);
const reset = mock(async (): Promise<void> => undefined);
const wrapWithSandbox = mock(async (command: string) => command);
const cleanupAfterCommand = mock(() => undefined);

mock.module("@anthropic-ai/sandbox-runtime", () => ({
    SandboxManager: {
        initialize,
        reset,
        wrapWithSandbox,
        cleanupAfterCommand,
    },
}));

const {
    default: sandboxExtension,
} = await import("./index.ts");
const {
    createSharedBashOperations,
    getSandboxExecutionState,
} = await import("../_shared/bash/sandbox-execution-broker.ts");

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

function context(cwd: string): ExtensionContext {
    return {
        cwd,
        hasUI: false,
        ui: { notify: mock(() => undefined) },
    } as unknown as ExtensionContext;
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
    });

    afterEach(async () => {
        await rm(cwd, { recursive: true, force: true });
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
