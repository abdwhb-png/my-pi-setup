import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashOperations, ExtensionAPI, ExtensionContext, MessageRenderer } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiMainScreen, type Component } from "@earendil-works/pi-tui";
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { claimSandboxRuntime, publishSandboxRuntime } from "../_shared/sandbox-runtime/index.ts";
import { emptyGrants, publishShellRuntime } from "../_shared/shell-runtime/index.ts";
import { createSandboxCommandRunner, SANDBOX_RUN_MESSAGE } from "./run-command.ts";

const keys = [Symbol.for("pi.sandbox-runtime.v2"), Symbol.for("pi.shell-capabilities.v1")];
let previous: unknown[];
let cwd: string;
const outputFiles: string[] = [];
beforeEach(async () => {
    previous = keys.map(key => Reflect.get(globalThis, key));
    cwd = await mkdtemp(join(tmpdir(), "sandbox-run-command-"));
    for (const key of keys) Reflect.deleteProperty(globalThis, key);
});
afterEach(async () => {
    keys.forEach((key, index) => previous[index] === undefined ? Reflect.deleteProperty(globalThis, key) : Reflect.set(globalThis, key, previous[index]));
    await rm(cwd, { recursive: true, force: true });
    for (const file of outputFiles.splice(0)) await rm(file, { force: true });
});

function fixture(exec: BashOperations["exec"], mode: "sandbox" | "host" = "sandbox") {
    const owner = Symbol("sandbox-run-command");
    claimSandboxRuntime(owner);
    const policy = {
        state: "ready" as const, projectRoot: cwd, mode, requestedMode: mode,
        profile: mode === "host" ? "host" as const : "default" as const,
        requestedProfile: mode === "host" ? "host" as const : "default" as const,
        grants: emptyGrants(), requestedGrants: emptyGrants(), authorityPath: "/unused",
    };
    publishShellRuntime(owner, () => policy, undefined, () => ({ ...policy, mode: "sandbox", profile: "default", requestedMode: "sandbox", requestedProfile: "default" }));
    publishSandboxRuntime(owner, {
        state: "enabled",
        createBashOperations: options => ({ exec: async (...args) => {
            const base = { status: "sandboxed" as const, profile: "bash-general" as const, backend: "zerobox" as const, tmpNamespace: "host" as const, phase: "process" as const };
            options.onExecution?.({ ...base, outcome: "pending" });
            try {
                const result = await exec(...args);
                options.onExecution?.({ ...base, outcome: result.exitCode === 0 ? "succeeded" : "failed", ...(result.exitCode === null ? {} : { exitCode: result.exitCode }) });
                return result;
            } catch (error) {
                options.onExecution?.({ ...base, outcome: args[2].signal?.aborted ? "aborted" : "failed" });
                throw error;
            }
        } }),
        createThinkBashOperations: () => ({ exec }),
        analysis: { state: "retrying" },
    });
    const messages: Array<Parameters<ExtensionAPI["sendMessage"]>[0]> = [];
    const notifications: string[] = [];
    const renderers = new Map<string, MessageRenderer>();
    const pi = {
        registerMessageRenderer: (kind: string, renderer: MessageRenderer) => renderers.set(kind, renderer),
        sendMessage: (message: Parameters<ExtensionAPI["sendMessage"]>[0], options?: Parameters<ExtensionAPI["sendMessage"]>[1]) => {
            expect(options?.triggerTurn).toBe(false);
            messages.push(message);
        },
    } as unknown as ExtensionAPI;
    const ctx = { cwd, mode: "rpc", ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionContext;
    return { owner, runner: createSandboxCommandRunner(pi), ctx, messages, notifications, renderers };
}

test("explicit Sandbox execution keeps the command intact while the agent mode is host", async () => {
    const commands: string[] = [];
    const f = fixture(async (command, _cwd, options) => {
        commands.push(command);
        options.onData(Buffer.from("command output"));
        return { exitCode: 17 };
    }, "host");
    const command = "printf '%s' 'Mixed Case' | cat\nprintf done";
    await f.runner.run(command, f.ctx);
    expect(commands).toEqual([command]);
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]).toMatchObject({ customType: SANDBOX_RUN_MESSAGE, details: { command, execution: { mode: "sandbox", backend: "zerobox", outcome: "failed", exitCode: 17 } } });
});

test("a refused Sandbox request never falls back to executing its command on the host", async () => {
    let calls = 0;
    const f = fixture(async () => { calls++; return { exitCode: 0 }; });
    publishSandboxRuntime(f.owner, { state: "error" });
    await f.runner.run("printf escaped > escaped", f.ctx);
    expect(calls).toBe(0);
    await expect(readFile(join(cwd, "escaped"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.messages[0]).toMatchObject({ details: { execution: { status: "unknown", mode: "sandbox", outcome: "blocked" } } });
    expect(f.messages[0]?.content).toContain("Sandbox requested — blocked");
});

test("empty requests are rejected without dispatch or a result message", async () => {
    let calls = 0;
    const f = fixture(async () => { calls++; return { exitCode: 0 }; });
    await f.runner.run(" \n ", f.ctx);
    expect(calls).toBe(0);
    expect(f.notifications).toEqual(["Usage: /sandbox run <command>"]);
    expect(f.messages).toHaveLength(0);
});

test("cancellation drains the command and rejects a second concurrent request", async () => {
    let start!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    let calls = 0;
    const f = fixture(async (_command, _cwd, options) => {
        calls++;
        options.onData(Buffer.from("before cancellation"));
        start();
        await new Promise<void>(resolve => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("aborted");
    });
    const running = f.runner.run("waiting", f.ctx);
    try {
        await started;
        await f.runner.run("second", f.ctx);
        expect(calls).toBe(1);
        expect(f.notifications.join("")).toContain("already running");
    } finally {
        await f.runner.cancel();
        await running;
    }
    expect(f.messages[0]).toMatchObject({ details: { execution: { outcome: "aborted" } } });
    expect(f.messages[0]?.content).toContain("before cancellation");
});

test("large output stays bounded and retains a readable full output file", async () => {
    const output = "large-output\n".repeat(10_000);
    const f = fixture(async (_command, _cwd, options) => { options.onData(Buffer.from(output)); return { exitCode: 0 }; });
    await f.runner.run("large output", f.ctx);
    const details = f.messages[0]?.details;
    if (!details || typeof details !== "object" || !("fullOutputPath" in details) || typeof details.fullOutputPath !== "string") throw new Error("Missing full output file");
    outputFiles.push(details.fullOutputPath);
    expect(await readFile(details.fullOutputPath, "utf8")).toBe(output);
    expect(String(f.messages[0]?.content).length).toBeLessThan(60_000);
});

test("cancelled large output retains the full output file from its last update", async () => {
    let start!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    const output = "before-cancellation\n".repeat(10_000);
    const f = fixture(async (_command, _cwd, options) => {
        options.onData(Buffer.from(output));
        start();
        await new Promise<void>(resolve => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("aborted");
    });
    const running = f.runner.run("large waiting output", f.ctx);
    await started;
    await f.runner.cancel();
    await running;
    const details = f.messages[0]?.details;
    expect(details).toHaveProperty("fullOutputPath");
    if (!details || typeof details !== "object" || !("fullOutputPath" in details) || typeof details.fullOutputPath !== "string") throw new Error("Missing cancelled full output file");
    outputFiles.push(details.fullOutputPath);
    expect(await readFile(details.fullOutputPath, "utf8")).toBe(output);
});

test.each(["\x1b", "\x1b[27u"])("TUI execution renders its route and cancels with Escape %j", async key => {
    let start!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    const f = fixture(async (_command, _cwd, options) => {
        options.onData(Buffer.from("live output"));
        start();
        await new Promise<void>(resolve => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("aborted");
    });
    const theme = getThemeByName("dark");
    if (!theme) throw new Error("Missing built-in theme");
    const tui = new TuiMainScreen(new ProcessTerminal());
    let renders = 0;
    tui.requestRender = () => { renders++; };
    let view: Component | undefined;
    f.ctx.mode = "tui";
    f.ctx.ui.custom = async factory => {
        type Result = Parameters<Parameters<typeof factory>[3]>[0];
        let done!: (value: Result) => void;
        const finished = new Promise<Result>(resolve => { done = resolve; });
        view = await factory(tui, theme, new KeybindingsManager(), done);
        return await finished;
    };
    const running = f.runner.run("waiting", f.ctx);
    try {
        await started;
        expect(view?.render(40).join("\n")).toContain("Sandbox");
        expect(renders).toBeGreaterThan(0);
        view?.handleInput?.(key);
        await running;
        expect(f.messages[0]).toMatchObject({ details: { execution: { outcome: "aborted" } } });
    } finally {
        await f.runner.cancel();
    }
});
