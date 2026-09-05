import {
    spawn as nodeSpawn,
    type ChildProcess,
    type SpawnOptions,
} from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";

import {
    type BashOperations,
    getShellConfig,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";

export const MAX_STDIN_BYTES = 1_048_576;

export const bashWithStdinSchema = Type.Object({
    command: Type.String({ description: "Bash command to execute" }),
    timeout: Type.Optional(
        Type.Number({ description: "Timeout in seconds (optional)" }),
    ),
    stdin: Type.Optional(
        Type.String({
            description:
                "UTF-8 text written exactly to stdin, without an added newline",
        }),
    ),
});

export type BashWithStdinInput = Static<typeof bashWithStdinSchema>;

export interface BashPreparationContext {
    command: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
}

export type BashSpawn = (
    command: string,
    args: string[],
    options: SpawnOptions,
) => ChildProcess;

export interface PreparedBashSpawn {
    file: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    extraStdio: readonly ("pipe" | "ignore" | number)[];
    beforeSpawn?: () => void;
    cleanup?: () => void | Promise<void>;
    supervise(child: ChildProcess): {
        ready: Promise<void>;
        settled: Promise<void>;
    };
}

interface ResolvedBashSpawn extends Omit<PreparedBashSpawn, "supervise"> {
    supervise?: PreparedBashSpawn["supervise"];
}

export interface CreateBashOperationsOptions {
    stdin?: string;
    shellPath?: string;
    env?: NodeJS.ProcessEnv;
    detached?: boolean;
    prepareCommand?: (
        context: BashPreparationContext,
    ) => BashPreparationContext | Promise<BashPreparationContext>;
    prepareSpawn?: (
        context: BashPreparationContext,
    ) => PreparedBashSpawn | Promise<PreparedBashSpawn>;
    afterClose?: (context: BashPreparationContext) => void | Promise<void>;
    spawn?: BashSpawn;
    /**
     * Optional command rewriter. Applied after prepareCommand, before spawn.
     * Caller builds this from loadBashRewrites + applyFirstRewrite.
     * Returning a string rewrites the command silently.
     * Returning { command, applied } rewrites and records the applied rewrite.
     * Returning null leaves the command unchanged.
     */
    rewriteCommand?: (
        command: string,
    ) => string | { command: string; applied: unknown } | null;
}

const EXIT_STDIO_GRACE_MS = 100;
const PREPARED_CLOSE_GRACE_MS = 1_000;
const PREPARED_TERMINATION_GRACE_MS = 250;

function waitForClose(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => child.once("close", () => resolve()));
}

async function waitForPreparedClose(
    closePromise: Promise<void>,
): Promise<void> {
    await Promise.race([
        closePromise,
        new Promise<void>((resolve) =>
            setTimeout(resolve, PREPARED_CLOSE_GRACE_MS),
        ),
    ]);
}

function killProcessTree(
    pid: number,
    signal: NodeJS.Signals = "SIGKILL",
): void {
    if (process.platform === "win32") {
        try {
            nodeSpawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
                stdio: "ignore",
                detached: true,
                windowsHide: true,
            });
        } catch {
            // Process may already be gone.
        }
        return;
    }

    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            // Process may already be gone.
        }
    }
}

function attachCleanupFailure(primary: unknown, cleanup: unknown): void {
    if (
        (typeof primary !== "object" || primary === null) &&
        typeof primary !== "function"
    ) {
        return;
    }
    const attach: unknown = Reflect.get(primary, "attachCleanupError");
    if (typeof attach === "function") {
        Reflect.apply(attach, primary, [cleanup]);
        return;
    }
    Object.defineProperty(primary, "cleanupError", {
        configurable: true,
        enumerable: false,
        value: cleanup,
    });
}

function killActiveBashProcesses(activeProcessIds: Set<number>): void {
    for (const pid of activeProcessIds) killProcessTree(pid);
    activeProcessIds.clear();
}

/**
 * Mirrors Pi's idle-grace wait without importing its private utility path.
 * Active detached descendants keep pipes alive; quiet inherited handles stop
 * blocking after a short post-exit idle period.
 */
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let exited = false;
        let exitCode: number | null = null;
        let idleTimer: Timer | undefined;
        let stdoutEnded = child.stdout === null;
        let stderrEnded = child.stderr === null;

        const cleanup = () => {
            if (idleTimer) clearTimeout(idleTimer);
            child.removeListener("error", onError);
            child.removeListener("exit", onExit);
            child.removeListener("close", onClose);
            child.stdout?.removeListener("end", onStdoutEnd);
            child.stderr?.removeListener("end", onStderrEnd);
            child.stdout?.removeListener("data", onData);
            child.stderr?.removeListener("data", onData);
        };
        const finalize = (code: number | null) => {
            if (settled) return;
            settled = true;
            cleanup();
            child.stdout?.destroy();
            child.stderr?.destroy();
            resolve(code);
        };
        const finalizeIfStreamsEnded = () => {
            if (exited && stdoutEnded && stderrEnded) finalize(exitCode);
        };
        const armIdleTimer = () => {
            if (idleTimer) clearTimeout(idleTimer);
            // oxlint-disable-next-line typescript/no-unsafe-assignment -- Bun exposes setTimeout as any with mixed Bun/Node globals
            idleTimer = setTimeout(
                () => finalize(exitCode),
                EXIT_STDIO_GRACE_MS,
            );
        };
        const onData = () => {
            if (exited && !settled) armIdleTimer();
        };
        const onStdoutEnd = () => {
            stdoutEnded = true;
            finalizeIfStreamsEnded();
        };
        const onStderrEnd = () => {
            stderrEnded = true;
            finalizeIfStreamsEnded();
        };
        const onError = (error: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };
        const onExit = (code: number | null) => {
            exited = true;
            exitCode = code;
            finalizeIfStreamsEnded();
            if (!settled) armIdleTimer();
        };
        const onClose = (code: number | null) => finalize(code);

        child.stdout?.once("end", onStdoutEnd);
        child.stderr?.once("end", onStderrEnd);
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.once("error", onError);
        child.once("exit", onExit);
        child.once("close", onClose);
    });
}

function writeStdin(
    child: ChildProcess,
    stdin: string,
    hasExited: () => boolean,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const stream = child.stdin;
        if (!stream) {
            reject(new Error("Failed to open child stdin"));
            return;
        }

        let settled = false;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            stream.removeListener("error", onError);
            if (error && !hasExited()) reject(error);
            else resolve();
        };
        const onError = (error: Error) => finish(error);

        stream.once("error", onError);
        stream.end(stdin, "utf8", finish);
    });
}

function createTrackedBashOperations(
    options: CreateBashOperationsOptions,
    activeProcessIds: Set<number>,
): BashOperations {
    if (options.prepareCommand && options.prepareSpawn) {
        throw new Error("prepareCommand and prepareSpawn cannot be combined");
    }
    const stdinBytes =
        options.stdin === undefined
            ? 0
            : Buffer.byteLength(options.stdin, "utf8");

    return {
        async exec(command, cwd, { onData, signal, timeout, env }) {
            if (stdinBytes > MAX_STDIN_BYTES) {
                throw new Error(`stdin exceeds ${MAX_STDIN_BYTES} UTF-8 bytes`);
            }
            if (signal?.aborted) throw new Error("aborted");

            const prepared = options.prepareCommand
                ? await options.prepareCommand({
                      command,
                      cwd,
                      env: env ?? options.env ?? process.env,
                  })
                : {
                      command,
                      cwd,
                      env: env ?? options.env ?? process.env,
                  };

            // Apply project-configured rewrites after prepareCommand, before spawn.
            // Guards in execute() already ran on the original command.
            if (options.rewriteCommand) {
                const rewritten = options.rewriteCommand(prepared.command);
                if (typeof rewritten === "string") {
                    prepared.command = rewritten;
                } else if (
                    rewritten &&
                    typeof rewritten === "object" &&
                    "command" in rewritten
                ) {
                    prepared.command = rewritten.command;
                }
            }

            let spawnSpec: ResolvedBashSpawn | undefined;
            let primaryFailure: unknown;
            let hasPrimaryFailure = false;
            let executionResult: { exitCode: number | null } | undefined;
            try {
                spawnSpec = options.prepareSpawn
                    ? await options.prepareSpawn(prepared)
                    : (() => {
                          const shell = getShellConfig(options.shellPath);
                          return {
                              file: shell.shell,
                              args: [...shell.args, prepared.command],
                              cwd: prepared.cwd,
                              env: prepared.env,
                              extraStdio: [] as const,
                              supervise: undefined,
                              cleanup: undefined,
                          };
                      })();
                try {
                    await access(spawnSpec.cwd, constants.F_OK);
                } catch {
                    throw new Error(
                        `Working directory does not exist: ${spawnSpec.cwd}\nCannot execute bash commands.`,
                    );
                }
                if (signal?.aborted) throw new Error("aborted");
                spawnSpec.beforeSpawn?.();

                const spawn = options.spawn ?? nodeSpawn;
                const child = spawn(spawnSpec.file, spawnSpec.args, {
                    cwd: spawnSpec.cwd,
                    detached: options.detached ?? process.platform !== "win32",
                    env: spawnSpec.env,
                    stdio: [
                        options.stdin === undefined ? "ignore" : "pipe",
                        "pipe",
                        "pipe",
                        ...spawnSpec.extraStdio,
                    ],
                    windowsHide: true,
                });
                const pid = child.pid;
                if (pid !== undefined) activeProcessIds.add(pid);
                const closePromise = options.prepareSpawn
                    ? waitForClose(child)
                    : Promise.resolve();

                let exited = false;
                let timedOut = false;
                let timeoutHandle: Timer | undefined;
                let hardKillHandle: Timer | undefined;
                const markExited = () => {
                    exited = true;
                };
                const killChild = (hard = false) => {
                    const terminationSignal =
                        options.prepareSpawn && !hard ? "SIGTERM" : "SIGKILL";
                    if (pid !== undefined)
                        killProcessTree(pid, terminationSignal);
                    else child.kill(terminationSignal);
                    if (options.prepareSpawn && !hard && !hardKillHandle) {
                        hardKillHandle = setTimeout(() => {
                            if (!exited) killChild(true);
                        }, PREPARED_TERMINATION_GRACE_MS);
                    }
                };
                const onAbort = () => killChild();

                child.once("exit", markExited);
                child.stdout?.on("data", onData);
                child.stderr?.on("data", onData);
                if (signal)
                    signal.addEventListener("abort", onAbort, { once: true });
                if (timeout !== undefined && timeout > 0) {
                    // oxlint-disable-next-line typescript/no-unsafe-assignment -- Bun exposes setTimeout as any with mixed Bun/Node globals
                    timeoutHandle = setTimeout(() => {
                        timedOut = true;
                        killChild();
                    }, timeout * 1000);
                }

                try {
                    const supervision = spawnSpec.supervise?.(child);
                    const readyPromise =
                        supervision?.ready ?? Promise.resolve();
                    const settledPromise =
                        supervision?.settled ?? Promise.resolve();
                    void settledPromise.catch(() => {
                        if (!exited) killChild();
                    });
                    const exitPromise = waitForChildProcess(child);
                    await readyPromise;
                    const stdinPromise =
                        options.stdin === undefined
                            ? Promise.resolve()
                            : writeStdin(child, options.stdin, () => exited);
                    const [exitCode] = await Promise.all([
                        exitPromise,
                        stdinPromise,
                    ]);
                    await settledPromise;
                    await closePromise;
                    if (signal?.aborted) throw new Error("aborted");
                    if (timedOut) throw new Error(`timeout:${timeout}`);
                    executionResult = { exitCode };
                } catch (error) {
                    if (!exited) killChild();
                    if (options.prepareSpawn && pid !== undefined) {
                        await waitForPreparedClose(closePromise);
                    }
                    if (signal?.aborted) throw new Error("aborted");
                    if (timedOut) throw new Error(`timeout:${timeout}`);
                    throw error;
                } finally {
                    child.removeListener("exit", markExited);
                    child.stdout?.removeListener("data", onData);
                    child.stderr?.removeListener("data", onData);
                    if (timeoutHandle) clearTimeout(timeoutHandle);
                    if (hardKillHandle) clearTimeout(hardKillHandle);
                    signal?.removeEventListener("abort", onAbort);
                    if (pid !== undefined) activeProcessIds.delete(pid);
                }
            } catch (error) {
                hasPrimaryFailure = true;
                primaryFailure = error;
            }
            const cleanupFailures: unknown[] = [];
            try {
                await spawnSpec?.cleanup?.();
            } catch (error) {
                cleanupFailures.push(error);
            }
            try {
                await options.afterClose?.(prepared);
            } catch (error) {
                cleanupFailures.push(error);
            }
            const cleanupFailure =
                cleanupFailures.length === 0
                    ? undefined
                    : cleanupFailures.length === 1
                      ? cleanupFailures[0]
                      : new AggregateError(
                            cleanupFailures,
                            "Multiple Bash cleanup operations failed",
                        );
            if (hasPrimaryFailure) {
                if (cleanupFailures.length > 0)
                    attachCleanupFailure(primaryFailure, cleanupFailure);
                throw primaryFailure;
            }
            if (cleanupFailures.length > 0) throw cleanupFailure;
            if (!executionResult)
                throw new Error("Bash execution produced no result");
            return executionResult;
        },
    };
}

export interface BashProcessSupervisor {
    createOperations(options?: CreateBashOperationsOptions): BashOperations;
    shutdown(): void;
}

/**
 * Create one process owner. Extensions must keep this instance and shut it
 * down themselves; separately evaluated Jiti module graphs never share its
 * process set.
 */
export function createBashProcessSupervisor(): BashProcessSupervisor {
    const activeProcessIds = new Set<number>();
    return {
        createOperations: (options = {}) =>
            createTrackedBashOperations(options, activeProcessIds),
        shutdown: () => killActiveBashProcesses(activeProcessIds),
    };
}

/**
 * Convenience for isolated callers that do not own a longer-lived process
 * lifecycle. Extension entrypoints should use createBashProcessSupervisor().
 */
export function createBashOperations(
    options: CreateBashOperationsOptions = {},
): BashOperations {
    return createBashProcessSupervisor().createOperations(options);
}
