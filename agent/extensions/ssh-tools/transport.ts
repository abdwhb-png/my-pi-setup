import { spawn } from "node:child_process";
import { remoteDirname, shellQuote } from "./remote-path.ts";

/**
 * SSH transport: argv construction, process lifecycle, and failure reporting.
 *
 * The `SshProcess` seam exists so remote command construction and the
 * abort/timeout lifecycle are testable without a live host. It is the only
 * place this module touches `node:child_process`.
 */

/** OpenSSH reserves 255 for its own failures: transport, host key, auth. */
export const SSH_TRANSPORT_EXIT = 255;

export type SshExecResult = {
    stdout: Buffer;
    stderr: Buffer;
    exitCode: number | null;
};

export interface SshProcess {
    /** Returns false when the stream is full and the caller should await drain. */
    writeStdin(chunk: string | Buffer): boolean;
    endStdin(): void;
    /** Resolves when buffered stdin has drained, or immediately if it never filled. */
    onStdinDrain(listener: () => void): void;
    onStdinError(listener: (error: Error) => void): void;
    onStdout(listener: (chunk: Buffer) => void): void;
    onStderr(listener: (chunk: Buffer) => void): void;
    onError(listener: (error: Error) => void): void;
    onClose(listener: (code: number | null) => void): void;
    kill(signal?: NodeJS.Signals): void;
}

export type SshLaunch = (args: readonly string[]) => SshProcess;

/** A byte allowance for one retained stream. */
type RetentionBudget = {
    used: number;
    limit: number;
};

export type SshExecOptions = {
    stdin?: string | Buffer;
    signal?: AbortSignal;
    onStdoutData?: (data: Buffer) => void;
    onStderrData?: (data: Buffer) => void;
    timeoutSeconds?: number;
    spawnFn?: SshLaunch;
    /**
     * Cap on retained *diagnostic* stdout, applied only in streaming mode
     * (when `onStdoutData` is set). Output still streams in full; this bounds
     * only what is kept to build an error message.
     */
    maxRetainedOutputBytes?: number;
    /**
     * Hard ceiling on a data-returning call such as a file read. Exceeding it
     * is an error, never a silent truncation: `ssh_read` returning a shortened
     * file would look like a successful read of different content.
     */
    maxDataBytes?: number;
    /** Grace period between SIGTERM and SIGKILL on abort or timeout. */
    killGraceMs?: number;
};

const DEFAULT_MAX_RETAINED_OUTPUT = 1_048_576;
const DEFAULT_MAX_DATA_BYTES = 16_777_216;
const DEFAULT_KILL_GRACE_MS = 2_000;
/**
 * stderr is only ever kept to build an error message, in both streaming and
 * data mode, so it is always bounded. The cap is separate from the streaming
 * stdout tail so a verbose or hostile remote cannot exhaust local memory
 * during a data call, where stdout legitimately needs its larger budget.
 */
export const DEFAULT_MAX_DIAGNOSTIC_BYTES = 65_536;

const SSH_OPTIONS = [
    ["-o", "BatchMode=yes"],
    ["-o", "ConnectTimeout=10"],
] as const;

const launchSshProcess: SshLaunch = (args) => {
    const child = spawn("ssh", [...args], {
        stdio: ["pipe", "pipe", "pipe"] as const,
    });
    return {
        writeStdin: (chunk) => {
            // A stream error is fatal for the transfer: without a listener it
            // becomes an uncaught exception instead of a rejected tool call.
            child.stdin?.on("error", () => undefined);
            return child.stdin?.write(chunk) ?? false;
        },
        endStdin: () => {
            child.stdin?.end();
        },
        onStdinDrain: (listener) => {
            child.stdin?.once("drain", listener);
        },
        onStdinError: (listener) => {
            child.stdin?.on("error", listener);
        },
        onStdout: (listener) => {
            child.stdout?.on("data", listener);
        },
        onStderr: (listener) => {
            child.stderr?.on("data", listener);
        },
        onError: (listener) => {
            child.on("error", listener);
        },
        onClose: (listener) => {
            child.on("close", listener);
        },
        kill: (signal) => {
            child.kill(signal);
        },
    };
};

/**
 * `BatchMode=yes` turns a host-key or password prompt into an immediate error
 * instead of a tool call that blocks on the terminal's TTY. `ConnectTimeout`
 * bounds the connect phase so an unreachable host cannot hang either.
 */
export function buildSshArgs(remote: string, command: string): string[] {
    return [...SSH_OPTIONS.flat(), remote, command];
}

/**
 * Write content to `absolutePath` atomically and completely.
 *
 * The temp file is created with `mktemp` in the target's own directory, so a
 * rename stays within one filesystem and two writers to the same target get
 * distinct inodes. A shared, target-derived temp name let one writer truncate
 * another's temp or follow a pre-existing symlink at that path.
 *
 * Completeness is checked by byte count, not exit status: `cat` exits 0 on an
 * early EOF, so a dropped connection could otherwise publish a truncated file
 * over an intact target.
 */
export function buildWriteScript(
    absolutePath: string,
    expectedBytes: number,
): string {
    const target = shellQuote(absolutePath);
    // The template is a literal, so it is single quoted; only the command
    // substitution in the assignment needs double quotes to expand.
    const temp = `"$(mktemp ${shellQuote(`${remoteDirname(absolutePath)}/.pi-ssh.XXXXXX`)})"`;
    // Refusal messages are quoted as a WHOLE string. Interpolating the already
    // single-quoted path into a double-quoted echo would re-enable $() and
    // backticks, because single quotes are literal inside double quotes.
    const directoryRefusal = shellQuote(
        `refusing to write: ${absolutePath} is a directory`,
    );
    const symlinkRefusal = shellQuote(
        `refusing to write: ${absolutePath} is a symlink`,
    );
    return [
        `tmp=${temp} || exit 1`,
        `trap 'rm -f "$tmp"' EXIT`,
        // mv into a directory succeeds by moving the file inside it, and a
        // rename over a symlink replaces the link rather than its referent.
        // Both silently write somewhere the model did not name.
        `[ -d ${target} ] && { printf '%s\\n' ${directoryRefusal} >&2; exit 1; }`,
        `[ -L ${target} ] && { printf '%s\\n' ${symlinkRefusal} >&2; exit 1; }`,
        `cat > "$tmp" || exit 1`,
        `actual=$(wc -c < "$tmp")`,
        `[ "$actual" -eq ${expectedBytes} ] || { rm -f "$tmp"; echo "short write: got $actual of ${expectedBytes} bytes" >&2; exit 1; }`,
        `mv -f "$tmp" ${target} || exit 1`,
        `trap - EXIT`,
    ].join("\n");
}

/** One round trip that distinguishes "absent" from "present but inaccessible". */
/**
 * One round trip that distinguishes absent, present-but-inaccessible, and (for
 * `ssh_edit`) symlinked.
 *
 * `-L` is checked before `-e` because `[ -e ]` follows the link and would
 * report the referent's state, hiding that the target is a link at all. The
 * edit path needs this: its temp-then-rename would replace the link rather than
 * the file the model meant.
 */
export function buildProbeScript(
    absolutePath: string,
    flags: readonly string[],
    options: { detectLink?: boolean } = {},
): string {
    const quoted = shellQuote(absolutePath);
    if (options.detectLink) {
        return `if [ -L ${quoted} ]; then printf LINK; else ${probeBody(quoted, flags)}; fi`;
    }
    return probeBody(quoted, flags);
}

function probeBody(quoted: string, flags: readonly string[]): string {
    const checks = flags.map((flag) => `[ -${flag} ${quoted} ]`).join(" && ");
    return `if [ -e ${quoted} ]; then ${checks} && printf OK || printf NOACCESS; else printf NOENT; fi`;
}

export function sshExec(
    remote: string,
    command: string,
    options: SshExecOptions = {},
): Promise<SshExecResult> {
    return new Promise<SshExecResult>((resolve, reject) => {
        // An already-aborted call must not spawn anything: the remote command
        // would run with nobody listening for the result.
        if (options.signal?.aborted) {
            reject(new Error("aborted"));
            return;
        }

        const launch = options.spawnFn ?? launchSshProcess;
        let child: SshProcess;
        try {
            child = launch(buildSshArgs(remote, command));
        } catch (error) {
            reject(error);
            return;
        }

        // Diagnostic mode streams to a consumer, so only the tail kept for an
        // error message is bounded. Data mode returns stdout as the result, so
        // truncating it would hand back a silently shortened file.
        const diagnostic = options.onStdoutData !== undefined;
        const dataLimit = options.maxDataBytes ?? DEFAULT_MAX_DATA_BYTES;
        const stdoutBudget: RetentionBudget = {
            used: 0,
            limit: diagnostic
                ? (options.maxRetainedOutputBytes ??
                  DEFAULT_MAX_RETAINED_OUTPUT)
                : Number.POSITIVE_INFINITY,
        };
        const stderrBudget: RetentionBudget = {
            used: 0,
            limit: options.maxRetainedOutputBytes ?? DEFAULT_MAX_DIAGNOSTIC_BYTES,
        };
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let settled = false;
        // Tracks process closure separately from promise settlement. The
        // SIGKILL escalation must depend on the process still running, or a
        // child that ignores SIGTERM survives a data-limit rejection forever.
        let childClosed = false;
        let timedOut = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;

        // SIGTERM first, SIGKILL if the child ignores it. A single kill() can
        // leave the process running and the promise never settling.
        const killChild = () => {
            child.kill("SIGTERM");
            killTimer = setTimeout(() => {
                if (!childClosed) child.kill("SIGKILL");
            }, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
            killTimer.unref?.();
        };

        const timer =
            typeof options.timeoutSeconds === "number" &&
            options.timeoutSeconds > 0
                ? setTimeout(() => {
                      timedOut = true;
                      killChild();
                  }, options.timeoutSeconds * 1000)
                : undefined;

        const onAbort = () => {
            killChild();
        };

        const cleanup = () => {
            if (timer) clearTimeout(timer);
            if (killTimer) clearTimeout(killTimer);
            options.signal?.removeEventListener("abort", onAbort);
        };

        // Each stream has its own budget, so a chatty stderr cannot consume the
        // stdout allowance and vice versa.
        const retainDiagnostic = (
            chunks: Buffer[],
            chunk: Buffer,
            budget: RetentionBudget,
        ) => {
            if (budget.used >= budget.limit) return;
            const room = budget.limit - budget.used;
            chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
            budget.used += chunk.length;
        };

        child.onStdout((chunk) => {
            // Output arriving after settlement is ignored: re-entering the data
            // limit branch would reject again and schedule another kill.
            if (settled) return;
            if (!diagnostic) {
                stdoutBudget.used += chunk.length;
                if (stdoutBudget.used > dataLimit) {
                    settled = true;
                    cleanup();
                    killChild();
                    reject(
                        new Error(
                            `Remote output exceeded the ${dataLimit} byte limit for a data-returning call. Read the file in ranges, or use ssh_bash with a streaming command.`,
                        ),
                    );
                    return;
                }
                stdoutChunks.push(chunk);
            } else {
                retainDiagnostic(stdoutChunks, chunk, stdoutBudget);
            }
            options.onStdoutData?.(chunk);
        });
        child.onStderr((chunk) => {
            if (settled) return;
            retainDiagnostic(stderrChunks, chunk, stderrBudget);
            options.onStderrData?.(chunk);
        });
        child.onError((error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        });
        // A broken stdin pipe is a transfer failure, not a process failure: it
        // fires on the stream, and without this it would be an uncaught error.
        child.onStdinError((error) => {
            if (settled) return;
            settled = true;
            cleanup();
            // Killing the child breaks the pipe, so EPIPE lands after the abort
            // or timeout that caused it. Reporting the pipe error instead would
            // lose the two message shapes pi matches on to render "Command
            // aborted" and "Command timed out", and a write would then be
            // reported as a definite failure rather than an unknown outcome.
            if (options.signal?.aborted) {
                reject(new Error("aborted"));
                return;
            }
            if (timedOut) {
                reject(new Error(`timeout:${options.timeoutSeconds}`));
                return;
            }
            reject(error);
        });
        child.onClose((code) => {
            childClosed = true;
            if (settled) return;
            settled = true;
            cleanup();
            // These two message shapes are the contract pi's shell tool matches.
            if (options.signal?.aborted) {
                reject(new Error("aborted"));
                return;
            }
            if (timedOut) {
                reject(new Error(`timeout:${options.timeoutSeconds}`));
                return;
            }
            resolve({
                stdout: Buffer.concat(stdoutChunks),
                stderr: Buffer.concat(stderrChunks),
                exitCode: code,
            });
        });

        if (options.signal) {
            options.signal.addEventListener("abort", onAbort, { once: true });
        }

        if (options.stdin === undefined) {
            child.endStdin();
            return;
        }

        // Respect backpressure: ending stdin while a write is still buffered
        // would truncate the payload the remote command reads.
        let backpressured = false;
        try {
            backpressured = !child.writeStdin(options.stdin);
        } catch (error) {
            settled = true;
            cleanup();
            reject(error);
            return;
        }
        if (!backpressured) {
            child.endStdin();
            return;
        }
        child.onStdinDrain(() => {
            child.endStdin();
        });
    });
}

function failureDetail(result: SshExecResult): string {
    return (
        result.stderr.toString("utf8").trim() ||
        result.stdout.toString("utf8").trim() ||
        "no output from the remote command"
    );
}

function describeFailure(remote: string, result: SshExecResult): string {
    const detail = failureDetail(result);
    if (result.exitCode === SSH_TRANSPORT_EXIT) {
        return `SSH transport or authentication failure on ${remote}: ${detail}`;
    }
    return `Remote command failed with exit code ${result.exitCode} on ${remote}: ${detail}`;
}

export async function sshOk(
    remote: string,
    command: string,
    options: SshExecOptions = {},
): Promise<Buffer> {
    const result = await sshExec(remote, command, options);
    if (result.exitCode === 0) {
        return result.stdout;
    }
    throw new Error(describeFailure(remote, result));
}

export type RemoteProbeResult = "OK" | "NOENT" | "NOACCESS" | "LINK";

export async function remoteProbe(
    remote: string,
    absolutePath: string,
    flags: readonly string[],
    options: SshExecOptions & { detectLink?: boolean } = {},
): Promise<RemoteProbeResult> {
    const stdout = await sshOk(
        remote,
        buildProbeScript(absolutePath, flags, {
            detectLink: options.detectLink,
        }),
        options,
    );
    const token = stdout.toString("utf8").trim();
    if (
        token === "OK" ||
        token === "NOENT" ||
        token === "NOACCESS" ||
        token === "LINK"
    ) {
        return token;
    }
    throw new Error(
        `Unrecognized access probe result ${JSON.stringify(token)} for ${absolutePath} on ${remote}.`,
    );
}

export async function assertRemoteAccess(
    remote: string,
    absolutePath: string,
    flags: readonly string[],
    options: SshExecOptions & { detectLink?: boolean } = {},
): Promise<void> {
    const result = await remoteProbe(remote, absolutePath, flags, options);
    if (result === "OK") return;
    if (result === "NOENT") {
        throw new Error(`Remote path not found on ${remote}: ${absolutePath}`);
    }
    if (result === "LINK") {
        throw new Error(
            `Remote path is a symlink on ${remote}: ${absolutePath}. Refusing to write through it, because the link would be replaced rather than the file it points to. Edit the resolved path, or use ssh_bash.`,
        );
    }
    const requirement = flags.includes("w")
        ? "readable and writable"
        : "readable";
    throw new Error(
        `Remote path is not ${requirement} on ${remote}: ${absolutePath}`,
    );
}
