/// <reference types="bun" />

import { describe, expect, it, mock } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import type { ZeroboxInputChannel } from "../runtime/status-channel.ts";

import {
    appendAnalysisHostShutdownFailure,
    executeAnalysisHostRequest,
    runAnalysisChild,
    type ChildExecutionInput,
    type AnalysisHostDependencies,
} from "./host.ts";
import { normalizeAnalysisRequest } from "./protocol.ts";

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function dependencies() {
    let preparedCommand: unknown;
    let readablePaths: string[] = [];
    let childInput: ChildExecutionInput | undefined;
    const dispose = mock(async () => undefined);
    const runChild = mock(async (input: Parameters<AnalysisHostDependencies["runChild"]>[0]) => {
        childInput = input;
        return {
            stdout: JSON.stringify({ ok: true, result: { output: "42", stderr: "" } }),
            stderr: "",
            exitCode: 0,
            truncated: false,
        };
    });
    const deps: AnalysisHostDependencies = {
        service: {
            prepareAnalysis: async (command, paths) => {
                preparedCommand = command;
                readablePaths = paths;
                return {
                    spawn: {
                        file: "/managed/zerobox",
                        args: ["--status-fd=3", "--", command.file, ...command.args],
                        cwd: command.cwd,
                        env: { PATH: "/usr/bin:/bin" },
                        statusProtocol: { fd: 3, version: 1 },
                        extraStdio: [99],
                        supervise: () => ({ ready: Promise.resolve(), settled: Promise.resolve() }),
                    },
                    dispose,
                };
            },
        },
        runChild,
        now: (() => {
            let time = 100;
            return () => ++time;
        })(),
        bunPath: "/trusted/bun",
        nodePath: "/usr/bin/node",
        prlimitPath: "/usr/bin/prlimit",
        sandboxRoot: dirname(fileURLToPath(import.meta.url)),
    };
    return {
        childInput: () => {
            if (!childInput) throw new Error("Analysis child was not invoked");
            return childInput;
        },
        deps,
        dispose,
        preparedCommand: () => preparedCommand,
        readablePaths: () => readablePaths,
        runChild,
    };
}

describe("analysis sandbox host", () => {
    it("uses a fixed structured command and keeps model data off argv", async () => {
        const harness = dependencies();
        const secret = "never-put-this-in-the-command";
        const request = normalizeAnalysisRequest({
            id: "call-1",
            language: "javascript",
            program: "export default SECRET.length",
            bindings: { SECRET: secret },
        });

        const result = await executeAnalysisHostRequest(request, harness.deps);

        expect(result).toEqual({
            output: "42",
            stderr: "",
            runtime: "quickjs",
            durationMs: 1,
            truncated: false,
        });
        const command = harness.preparedCommand() as { file: string; args: string[] };
        expect(command.file).toBe("/usr/bin/prlimit");
        expect(command.args.slice(0, 5)).toEqual([
            "--as=4294967296",
            "--cpu=30",
            "--nofile=64",
            "--",
            "/trusted/bun",
        ]);
        const input = harness.childInput();
        expect(input.file).toBe("/managed/zerobox");
        expect(input.args.join(" ")).not.toContain(request.program);
        expect(input.args.join(" ")).not.toContain(secret);
        expect(input.stdin).toContain(secret);
        expect(input.outputBytes).toBe(32 * 1024 ** 2 * 6 + 64 * 1024);
        expect(harness.readablePaths()).toContain(harness.deps.sandboxRoot);
        expect(harness.dispose).toHaveBeenCalledTimes(1);
    });

    it("keeps the worker response envelope outside the logical output cap", async () => {
        const harness = dependencies();
        await executeAnalysisHostRequest(
            normalizeAnalysisRequest({
                id: "exact-output-cap",
                language: "typescript",
                program: "export default 'x'",
                limits: { outputBytes: 1 },
            }),
            harness.deps,
        );

        expect(harness.childInput().outputBytes).toBe(64 * 1024 + 6);
    });

    it("uses only the fixed Node JSPI worker for Python", async () => {
        const harness = dependencies();
        const request = normalizeAnalysisRequest({
            id: "call-python",
            language: "python",
            program: "result = 42",
        });

        await executeAnalysisHostRequest(request, harness.deps);

        const command = harness.preparedCommand() as { args: string[] };
        expect(command.args).toContain("/usr/bin/node");
        expect(command.args).toContain("--as=12884901888");
        expect(command.args).toContain("--wasm-max-mem-pages=16384");
        expect(command.args).toContain("--experimental-wasm-jspi");
        expect(command.args.some((arg) => arg.endsWith("eryx-loader.mjs"))).toBe(true);
        expect(command.args.some((arg) => arg.endsWith("python-worker.mjs"))).toBe(true);
    });

    it("preserves a worker failure when handle disposal also fails", async () => {
        const harness = dependencies();
        const primary = new Error("worker failed");
        const cleanup = new Error("dispose failed");
        harness.runChild.mockImplementationOnce(async () => {
            throw primary;
        });
        harness.dispose.mockImplementationOnce(async () => {
            throw cleanup;
        });

        let rejection: unknown;
        try {
            await executeAnalysisHostRequest(
                normalizeAnalysisRequest({
                    id: "cleanup-priority",
                    language: "javascript",
                    program: "export default 1",
                }),
                harness.deps,
            );
        } catch (error) {
            rejection = error;
        }
        expect(rejection).toBe(primary);
        if (!(rejection instanceof Error)) throw new Error("expected Error");
        expect(Reflect.get(rejection, "cleanupError")).toBe(cleanup);
    });

    it("surfaces service shutdown failure in the host protocol response", async () => {
        const shutdown = mock(async () => {
            throw new Error("lease cleanup failed");
        });

        expect(
            await appendAnalysisHostShutdownFailure(
                {
                    ok: false,
                    error: "worker failed",
                },
                { shutdown },
            ),
        ).toEqual({
            ok: false,
            error: "worker failed; cleanup failed: lease cleanup failed",
        });
        expect(shutdown).toHaveBeenCalledTimes(1);
    });

    it("cleans child resources when supervision throws synchronously", async () => {
        const root = await mkdtemp(join(tmpdir(), "analysis-host-"));
        const cleanup = mock(async () => undefined);
        const primary = new Error("supervise failed");
        try {
            const input = {
                file: "/bin/true",
                args: [],
                cwd: root,
                env: { ZEROBOX_HOME: join(root, "zerobox-home") },
                statusProtocol: { fd: 3, version: 1 },
                extraStdio: [],
                stdin: "{}",
                wallTimeMs: 1_000,
                outputBytes: 1_024,
                cleanup,
                supervise: () => {
                    throw primary;
                },
            } satisfies ChildExecutionInput;

            await expect(runAnalysisChild(input)).rejects.toBe(primary);
            expect(cleanup).toHaveBeenCalledTimes(1);
            expect(
                (await readdir(root)).filter((name) =>
                    name.startsWith("i-"),
                ),
            ).toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("does not spawn and cleans prepared resources when aborted during input-channel setup", async () => {
        const controller = new AbortController();
        const channelStarted = deferred<void>();
        const channelReady = deferred<ZeroboxInputChannel>();
        const channelDispose = mock(async () => undefined);
        const cleanup = mock(async () => undefined);
        const spawnChild = mock(() => {
            throw new Error("child must not spawn after abort");
        });
        const createInputChannel = mock(() => {
            channelStarted.resolve();
            return channelReady.promise;
        });
        const execution = runAnalysisChild(
            {
                file: "/managed/worker",
                args: [],
                cwd: "/private",
                env: { ZEROBOX_HOME: "/private/zerobox-home" },
                statusProtocol: { fd: 3, version: 1 },
                extraStdio: [],
                stdin: "{}",
                wallTimeMs: 1_000,
                outputBytes: 1_024,
                signal: controller.signal,
                cleanup,
                supervise: () => ({
                    ready: Promise.resolve(),
                    settled: Promise.resolve(),
                }),
            },
            spawnChild,
            createInputChannel,
        );
        await channelStarted.promise;

        controller.abort();
        channelReady.resolve({
            childStdio: 99,
            releaseParentRead: async () => undefined,
            write: async () => undefined,
            dispose: channelDispose,
        });

        await expect(execution).rejects.toMatchObject({ code: "aborted" });
        expect(spawnChild).not.toHaveBeenCalled();
        expect(channelDispose).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("terminates a live child when status settlement fails after readiness", async () => {
        const root = await mkdtemp(join(tmpdir(), "analysis-host-"));
        const cleanup = mock(async () => undefined);
        const primary = new Error("status failed");
        let resolveReady!: () => void;
        const ready = new Promise<void>((resolve) => {
            resolveReady = resolve;
        });
        let rejectSettled!: (error: Error) => void;
        const settled = new Promise<void>((_resolve, reject) => {
            rejectSettled = reject;
        });
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        let childStdinFd: number | undefined;
        const child = Object.assign(new EventEmitter(), {
            pid: undefined,
            stdout,
            stderr,
            kill: mock((_signal: NodeJS.Signals) => {
                if (childStdinFd !== undefined) {
                    closeSync(childStdinFd);
                    childStdinFd = undefined;
                }
                queueMicrotask(() => {
                    child.emit("exit", 1);
                    stdout.end();
                    stderr.end();
                    child.emit("close", 1);
                });
                return true;
            }),
        });
        try {
            const execution = runAnalysisChild({
                file: "/managed/worker",
                args: [],
                cwd: root,
                env: { ZEROBOX_HOME: join(root, "zerobox-home") },
                statusProtocol: { fd: 3, version: 1 },
                extraStdio: [],
                stdin: "{}",
                wallTimeMs: 5_000,
                outputBytes: 1_024,
                cleanup,
                supervise: () => ({
                    ready,
                    settled,
                }),
            }, (_file, _args, options) => {
                const childStdio = Array.isArray(options.stdio)
                    ? options.stdio[0]
                    : undefined;
                if (typeof childStdio !== "number") {
                    throw new Error("expected numeric child stdin");
                }
                childStdinFd = openSync(`/proc/self/fd/${childStdio}`, "r");
                return child as unknown as ChildProcess;
            });
            await Bun.sleep(10);
            resolveReady();
            await Bun.sleep(20);
            rejectSettled(primary);

            let rejection: unknown;
            try {
                await Promise.race([
                    execution,
                    Bun.sleep(1_000).then(() => {
                        throw new Error("child did not settle");
                    }),
                ]);
            } catch (error) {
                rejection = error;
            }
            expect(rejection).toBe(primary);
            expect(child.kill).toHaveBeenCalledWith("SIGTERM");
            expect(cleanup).toHaveBeenCalledTimes(1);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
