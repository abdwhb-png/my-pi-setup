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

export interface CreateBashOperationsOptions {
    stdin?: string;
    shellPath?: string;
    env?: NodeJS.ProcessEnv;
    detached?: boolean;
    prepareCommand?: (
        context: BashPreparationContext,
    ) => BashPreparationContext | Promise<BashPreparationContext>;
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

const activeProcessIds = new Set<number>();
const EXIT_STDIO_GRACE_MS = 100;

function killProcessTree(pid: number): void {
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
        process.kill(-pid, "SIGKILL");
    } catch {
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // Process may already be gone.
        }
    }
}

export function killActiveBashProcesses(): void {
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

export function createBashOperations(
    options: CreateBashOperationsOptions = {},
): BashOperations {
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

            try {
                try {
                    await access(prepared.cwd, constants.F_OK);
                } catch {
                    throw new Error(
                        `Working directory does not exist: ${prepared.cwd}\nCannot execute bash commands.`,
                    );
                }
                if (signal?.aborted) throw new Error("aborted");

                const shell = getShellConfig(options.shellPath);
                const spawn = options.spawn ?? nodeSpawn;
                const child = spawn(
                    shell.shell,
                    [...shell.args, prepared.command],
                    {
                        cwd: prepared.cwd,
                        detached:
                            options.detached ?? process.platform !== "win32",
                        env: prepared.env,
                        stdio: [
                            options.stdin === undefined ? "ignore" : "pipe",
                            "pipe",
                            "pipe",
                        ],
                        windowsHide: true,
                    },
                );
                const pid = child.pid;
                if (pid !== undefined) activeProcessIds.add(pid);

                let exited = false;
                let timedOut = false;
                let timeoutHandle: Timer | undefined;
                const markExited = () => {
                    exited = true;
                };
                const killChild = () => {
                    if (pid !== undefined) killProcessTree(pid);
                    else child.kill("SIGKILL");
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
                    const stdinPromise =
                        options.stdin === undefined
                            ? Promise.resolve()
                            : writeStdin(child, options.stdin, () => exited);
                    const [exitCode] = await Promise.all([
                        waitForChildProcess(child),
                        stdinPromise,
                    ]);
                    if (signal?.aborted) throw new Error("aborted");
                    if (timedOut) throw new Error(`timeout:${timeout}`);
                    return { exitCode };
                } catch (error) {
                    if (!exited) killChild();
                    throw error;
                } finally {
                    child.removeListener("exit", markExited);
                    child.stdout?.removeListener("data", onData);
                    child.stderr?.removeListener("data", onData);
                    if (timeoutHandle) clearTimeout(timeoutHandle);
                    signal?.removeEventListener("abort", onAbort);
                    if (pid !== undefined) activeProcessIds.delete(pid);
                }
            } finally {
                await options.afterClose?.(prepared);
            }
        },
    };
}
