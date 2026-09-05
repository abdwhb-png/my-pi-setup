import {
    spawn,
    type ChildProcess,
    type SpawnOptions,
} from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { SandboxNodeEnvironment } from "../node-shim";
import {
    SandboxExecutionError,
    type SandboxCommand,
    type SandboxSpawnSpec,
} from "../runtime/contracts.ts";
import { validatePiSandboxConfig } from "../runtime/policies.ts";
import {
    createSandboxService,
    type SandboxService,
} from "../runtime/service.ts";
import { createZeroboxInputChannel } from "../runtime/status-channel.ts";
import { createZeroboxBackend } from "../runtime/zerobox-backend.ts";
import {
    analysisHostResponseBudget,
    parseAnalysisRequest,
    type AnalysisHostResponse,
    type AnalysisResult,
    type NormalizedAnalysisRequest,
} from "./protocol.ts";

export interface ChildExecutionInput extends SandboxSpawnSpec {
    stdin: string;
    wallTimeMs: number;
    outputBytes: number;
    signal?: AbortSignal;
}

export interface ChildExecutionResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    truncated: boolean;
}

export type AnalysisChildRunner = (
    input: ChildExecutionInput,
) => Promise<ChildExecutionResult>;

export type AnalysisChildSpawn = (
    file: string,
    args: string[],
    options: SpawnOptions,
) => ChildProcess;

export interface AnalysisHostDependencies {
    service: Pick<SandboxService, "prepareAnalysis">;
    runChild: AnalysisChildRunner;
    now(): number;
    bunPath: string;
    nodePath: string;
    prlimitPath: string;
    sandboxRoot: string;
    signal?: AbortSignal;
}

interface WorkerResponse {
    ok: boolean;
    result?: { output: string; stderr: string };
    error?: string;
}

// Bun/JSC can reserve more virtual address space than QuickJS's own 1 GiB
// heap cap. Keep the host ceiling separate so ASLR does not make valid
// TypeScript transforms intermittently fail before QuickJS enforces its cap.
const QUICKJS_HOST_ADDRESS_SPACE_BYTES = 4 * 1024 ** 3;
const PYTHON_HOST_ADDRESS_SPACE_BYTES = 12 * 1024 ** 3;
const WASM_PAGE_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 250;
const EXIT_STDIO_GRACE_MS = 100;

export function fixedWorkerCommand(
    request: NormalizedAnalysisRequest,
    dependencies: AnalysisHostDependencies,
): SandboxCommand {
    const analysisDirectory = fileURLToPath(new URL("./", import.meta.url));
    if (!analysisDirectory.startsWith(`${dependencies.sandboxRoot}/`)) {
        throw new Error("Analysis worker escaped the sandbox package root");
    }
    const workerArgs =
        request.worker === "quickjs"
            ? [
                  dependencies.bunPath,
                  fileURLToPath(
                      new URL("./quickjs-worker.ts", import.meta.url),
                  ),
              ]
            : [
                  dependencies.nodePath,
                  `--wasm-max-mem-pages=${Math.floor(request.limits.memoryBytes / WASM_PAGE_BYTES)}`,
                  "--no-warnings",
                  "--experimental-wasm-jspi",
                  "--experimental-loader",
                  fileURLToPath(new URL("./eryx-loader.mjs", import.meta.url)),
                  fileURLToPath(
                      new URL("./python-worker.mjs", import.meta.url),
                  ),
              ];
    const addressSpaceBytes =
        request.worker === "quickjs"
            ? QUICKJS_HOST_ADDRESS_SPACE_BYTES
            : PYTHON_HOST_ADDRESS_SPACE_BYTES;
    return {
        file: dependencies.prlimitPath,
        args: [
            `--as=${addressSpaceBytes}`,
            `--cpu=${request.limits.cpuSeconds}`,
            "--nofile=64",
            "--",
            ...workerArgs,
        ],
        cwd: dependencies.sandboxRoot,
        stdin: JSON.stringify(request),
    };
}

function readableWorkerPaths(dependencies: AnalysisHostDependencies): string[] {
    return [
        dependencies.sandboxRoot,
        dependencies.bunPath,
        dependencies.nodePath,
        dependencies.prlimitPath,
        dirname(dependencies.bunPath),
        dirname(dependencies.nodePath),
        dirname(dependencies.prlimitPath),
        "/bin",
        "/lib",
        "/lib64",
        "/usr",
        "/etc/ld.so.cache",
    ];
}

function parseWorkerResponse(stdout: string): WorkerResponse {
    let value: unknown;
    try {
        value = JSON.parse(stdout);
    } catch {
        throw new Error("Analysis worker returned invalid JSON");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Analysis worker returned an invalid response");
    }
    const response = value as Record<string, unknown>;
    if (response.ok === false && typeof response.error === "string") {
        return { ok: false, error: response.error };
    }
    if (
        response.ok !== true ||
        typeof response.result !== "object" ||
        response.result === null ||
        Array.isArray(response.result)
    ) {
        throw new Error("Analysis worker returned an invalid response");
    }
    const result = response.result as Record<string, unknown>;
    if (
        typeof result.output !== "string" ||
        typeof result.stderr !== "string"
    ) {
        throw new Error("Analysis worker returned invalid output fields");
    }
    return {
        ok: true,
        result: { output: result.output, stderr: result.stderr },
    };
}

function attachCleanupFailure(primary: unknown, cleanup: unknown): void {
    if (primary instanceof SandboxExecutionError) {
        primary.attachCleanupError(cleanup);
    } else if (primary instanceof Error) {
        Object.defineProperty(primary, "cleanupError", {
            configurable: true,
            enumerable: false,
            value: cleanup,
        });
    }
}

export async function executeAnalysisHostRequest(
    request: NormalizedAnalysisRequest,
    dependencies: AnalysisHostDependencies,
): Promise<AnalysisResult> {
    const startedAt = dependencies.now();
    const command = fixedWorkerCommand(request, dependencies);
    const handle = await dependencies.service.prepareAnalysis(
        command,
        readableWorkerPaths(dependencies),
    );
    let primaryFailure: unknown;
    let hasPrimaryFailure = false;
    let result: AnalysisResult | undefined;
    try {
        const child = await dependencies.runChild({
            ...handle.spawn,
            stdin: command.stdin ?? "",
            wallTimeMs: request.limits.wallTimeMs,
            outputBytes: analysisHostResponseBudget(request.limits.outputBytes),
            signal: dependencies.signal,
        });
        let response: WorkerResponse;
        try {
            response = parseWorkerResponse(child.stdout);
        } catch (error) {
            const diagnostics = child.stderr.trim();
            const message =
                error instanceof Error ? error.message : String(error);
            const exit = `exit=${String(child.exitCode)} stdoutBytes=${Buffer.byteLength(child.stdout, "utf8")}`;
            throw new Error(
                diagnostics
                    ? `${message}: ${exit}: ${diagnostics}`
                    : `${message}: ${exit}`,
                { cause: error },
            );
        }
        if (!response.ok || !response.result) {
            throw new Error(
                response.error ||
                    child.stderr.trim() ||
                    "Analysis worker failed",
            );
        }
        result = {
            output: response.result.output,
            stderr: [response.result.stderr, child.stderr]
                .filter(Boolean)
                .join("\n"),
            runtime: request.worker,
            durationMs: Math.max(0, dependencies.now() - startedAt),
            truncated: child.truncated,
        };
    } catch (error) {
        hasPrimaryFailure = true;
        primaryFailure = error;
    }
    let cleanupFailure: unknown;
    let hasCleanupFailure = false;
    try {
        await handle.dispose();
    } catch (cleanup) {
        hasCleanupFailure = true;
        cleanupFailure = cleanup;
    }
    if (hasPrimaryFailure) {
        if (hasCleanupFailure)
            attachCleanupFailure(primaryFailure, cleanupFailure);
        throw primaryFailure;
    }
    if (hasCleanupFailure) throw cleanupFailure;
    if (!result) throw new Error("Analysis host produced no result");
    return result;
}

function killProcessTree(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            // Process already exited.
        }
    }
}

async function rejectBeforeAnalysisSpawn(
    input: ChildExecutionInput,
    primary: unknown,
    inputChannel?: Awaited<ReturnType<typeof createZeroboxInputChannel>>,
): Promise<never> {
    const results = await Promise.allSettled([
        ...(inputChannel ? [inputChannel.dispose()] : []),
        Promise.resolve(input.cleanup?.()),
    ]);
    const failures: unknown[] = [];
    for (const result of results) {
        if (result.status === "rejected") {
            failures.push(result.reason as unknown);
        }
    }
    if (failures.length > 0) {
        attachCleanupFailure(
            primary,
            failures.length === 1
                ? failures[0]
                : new AggregateError(
                      failures,
                      "Failed to clean prepared analysis resources",
                  ),
        );
    }
    throw primary;
}

export async function runAnalysisChild(
    input: ChildExecutionInput,
    spawnChild: AnalysisChildSpawn = spawn,
    createInputChannel: typeof createZeroboxInputChannel = createZeroboxInputChannel,
): Promise<ChildExecutionResult> {
    if (input.signal?.aborted) {
        return rejectBeforeAnalysisSpawn(
            input,
            new SandboxExecutionError("aborted"),
        );
    }
    const zeroboxHome = input.env.ZEROBOX_HOME;
    if (!zeroboxHome) throw new SandboxExecutionError("setup-failed");
    let abortedDuringSetup = false;
    const onSetupAbort = () => {
        abortedDuringSetup = true;
    };
    input.signal?.addEventListener("abort", onSetupAbort, { once: true });
    let inputChannel: Awaited<ReturnType<typeof createZeroboxInputChannel>>;
    try {
        inputChannel = await createInputChannel(dirname(zeroboxHome));
    } catch (error) {
        input.signal?.removeEventListener("abort", onSetupAbort);
        return rejectBeforeAnalysisSpawn(
            input,
            abortedDuringSetup || input.signal?.aborted
                ? new SandboxExecutionError("aborted")
                : error,
        );
    }
    input.signal?.removeEventListener("abort", onSetupAbort);
    if (abortedDuringSetup || input.signal?.aborted) {
        return rejectBeforeAnalysisSpawn(
            input,
            new SandboxExecutionError("aborted"),
            inputChannel,
        );
    }
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawnChild(input.file, input.args, {
                cwd: input.cwd,
                env: input.env as SandboxNodeEnvironment,
                detached: true,
                stdio: [
                    inputChannel.childStdio,
                    "pipe",
                    "pipe",
                    ...input.extraStdio,
                ],
            });
        } catch (error) {
            void Promise.allSettled([
                inputChannel.dispose(),
                Promise.resolve(input.cleanup?.()),
            ]).finally(() =>
                reject(
                    new SandboxExecutionError("spawn-failed", { cause: error }),
                ),
            );
            return;
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let capturedBytes = 0;
        let terminalError: Error | undefined;
        let exited = false;
        let finalizing = false;
        let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
        let exitStdioTimer: ReturnType<typeof setTimeout> | undefined;
        const terminate = (error: Error): void => {
            if (terminalError) return;
            terminalError = error;
            if (child.pid) killProcessTree(child.pid, "SIGTERM");
            else child.kill("SIGTERM");
            hardKillTimer = setTimeout(() => {
                if (exited) return;
                if (child.pid) killProcessTree(child.pid, "SIGKILL");
                else child.kill("SIGKILL");
            }, TERMINATION_GRACE_MS);
            hardKillTimer.unref();
        };
        const onAbort = () => terminate(new SandboxExecutionError("aborted"));
        const timer = setTimeout(
            () => terminate(new SandboxExecutionError("timeout")),
            input.wallTimeMs,
        );
        timer.unref();
        input.signal?.addEventListener("abort", onAbort, { once: true });
        if (input.signal?.aborted) onAbort();

        let supervision:
            | { ready: Promise<void>; settled: Promise<void> }
            | undefined;
        const finalizeChild = (exitCode: number | null) => {
            if (finalizing) return;
            finalizing = true;
            exited = true;
            clearTimeout(timer);
            if (hardKillTimer) clearTimeout(hardKillTimer);
            if (exitStdioTimer) clearTimeout(exitStdioTimer);
            input.signal?.removeEventListener("abort", onAbort);
            child.stdout?.destroy();
            child.stderr?.destroy();
            void (async () => {
                try {
                    await supervision?.settled;
                } catch (error) {
                    terminalError ??=
                        error instanceof Error
                            ? error
                            : new Error(String(error));
                }
                const cleanupFailures: unknown[] = [];
                for (const cleanup of [
                    () => inputChannel.dispose(),
                    async () => input.cleanup?.(),
                ]) {
                    try {
                        await cleanup();
                    } catch (error) {
                        cleanupFailures.push(error);
                    }
                }
                if (cleanupFailures.length > 0) {
                    const cleanupFailure =
                        cleanupFailures.length === 1
                            ? cleanupFailures[0]
                            : new AggregateError(
                                  cleanupFailures,
                                  "Multiple Analysis child cleanup operations failed",
                              );
                    if (terminalError) {
                        attachCleanupFailure(terminalError, cleanupFailure);
                    } else {
                        terminalError = new SandboxExecutionError(
                            "cleanup-failed",
                            { cause: cleanupFailure },
                        );
                    }
                }
                if (terminalError) {
                    reject(terminalError);
                    return;
                }
                resolve({
                    stdout: Buffer.concat(stdout).toString("utf8"),
                    stderr: Buffer.concat(stderr).toString("utf8"),
                    exitCode,
                    truncated: false,
                });
            })();
        };
        child.once("close", finalizeChild);
        child.once("exit", (exitCode: number | null) => {
            exited = true;
            exitStdioTimer = setTimeout(
                () => finalizeChild(exitCode),
                EXIT_STDIO_GRACE_MS,
            );
            exitStdioTimer.unref();
        });
        const capture = (target: Buffer[], chunk: Buffer | string): void => {
            if (terminalError) return;
            const buffer =
                typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            capturedBytes += buffer.byteLength;
            if (capturedBytes > input.outputBytes) {
                terminate(
                    new Error(
                        `Analysis output exceeds ${input.outputBytes} bytes`,
                    ),
                );
                return;
            }
            target.push(buffer);
        };
        child.stdout?.on("data", (chunk) => capture(stdout, chunk));
        child.stderr?.on("data", (chunk) => capture(stderr, chunk));
        child.once("error", (error: Error) =>
            terminate(
                new SandboxExecutionError("spawn-failed", { cause: error }),
            ),
        );

        try {
            supervision = input.supervise(child);
        } catch (error) {
            terminate(
                error instanceof Error ? error : new Error(String(error)),
            );
            return;
        }
        void supervision.settled.catch((error: unknown) =>
            terminate(
                error instanceof Error ? error : new Error(String(error)),
            ),
        );

        void supervision.ready.then(
            async () => {
                if (terminalError) return;
                try {
                    await inputChannel.write(input.stdin);
                    await inputChannel.releaseParentRead();
                } catch (error) {
                    terminate(
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    );
                }
            },
            (error: unknown) =>
                terminate(
                    error instanceof Error ? error : new Error(String(error)),
                ),
        );
    });
}

async function defaultDependencies(signal: AbortSignal): Promise<{
    dependencies: AnalysisHostDependencies;
    service: SandboxService;
}> {
    const sandboxRoot = await realpath(
        fileURLToPath(new URL("../", import.meta.url)),
    );
    const service = createSandboxService({
        backend: createZeroboxBackend(),
        config: validatePiSandboxConfig({}),
    });
    return {
        service,
        dependencies: {
            service,
            runChild: runAnalysisChild,
            now: () => performance.now(),
            bunPath: await realpath(process.execPath),
            nodePath: await realpath("/usr/bin/node"),
            prlimitPath: await realpath("/usr/bin/prlimit"),
            sandboxRoot,
            signal,
        },
    };
}

async function readStdin(): Promise<string> {
    return new Response(Bun.stdin.stream()).text();
}

export async function appendAnalysisHostShutdownFailure(
    response: AnalysisHostResponse,
    service: Pick<SandboxService, "shutdown"> | undefined,
): Promise<AnalysisHostResponse> {
    if (!service) return response;
    try {
        await service.shutdown();
        return response;
    } catch (error) {
        const cleanupMessage =
            error instanceof Error ? error.message : String(error);
        return {
            ok: false,
            error: response.ok
                ? `Analysis host cleanup failed: ${cleanupMessage}`
                : `${response.error}; cleanup failed: ${cleanupMessage}`,
        };
    }
}

if (import.meta.main) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGTERM", abort);
    process.once("SIGINT", abort);
    let service: SandboxService | undefined;
    let response: AnalysisHostResponse = {
        ok: false,
        error: "Analysis host failed before producing a response",
    };
    try {
        const defaults = await defaultDependencies(controller.signal);
        service = defaults.service;
        const request = parseAnalysisRequest(JSON.parse(await readStdin()));
        const result = await executeAnalysisHostRequest(
            request,
            defaults.dependencies,
        );
        response = { ok: true, result };
    } catch (error) {
        response = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    } finally {
        process.removeListener("SIGTERM", abort);
        process.removeListener("SIGINT", abort);
        response = await appendAnalysisHostShutdownFailure(response, service);
    }
    process.stdout.write(JSON.stringify(response));
}
