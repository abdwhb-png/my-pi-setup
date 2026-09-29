import { spawn } from "node:child_process";
import { shellQuote } from "./remote-path.ts";

/**
 * SSH transport: argv construction, process lifecycle, and failure reporting.
 *
 * The `SshProcess` seam exists so remote command construction and the
 * abort/timeout lifecycle are testable without a live host. It is the only
 * place this module touches `node:child_process`.
 */

export type SshExecResult = {
    stdout: Buffer;
    stderr: Buffer;
    exitCode: number | null;
};

export interface SshProcess {
    writeStdin(chunk: string | Buffer): void;
    endStdin(): void;
    onStdout(listener: (chunk: Buffer) => void): void;
    onStderr(listener: (chunk: Buffer) => void): void;
    onError(listener: (error: Error) => void): void;
    onClose(listener: (code: number | null) => void): void;
    kill(): void;
}

export type SshLaunch = (args: readonly string[]) => SshProcess;

export type SshExecOptions = {
    stdin?: string | Buffer;
    signal?: AbortSignal;
    onStdoutData?: (data: Buffer) => void;
    onStderrData?: (data: Buffer) => void;
    timeoutSeconds?: number;
    spawnFn?: SshLaunch;
};

/** OpenSSH reserves 255 for its own failures: transport, host key, auth. */
const SSH_TRANSPORT_EXIT = 255;

const SSH_OPTIONS = [
    ["-o", "BatchMode=yes"],
    ["-o", "ConnectTimeout=10"],
] as const;

const WRITE_TEMP_SUFFIX = ".pi-ssh.tmp";

const launchSshProcess: SshLaunch = (args) => {
    const child = spawn("ssh", [...args], {
        stdio: ["pipe", "pipe", "pipe"] as const,
    });
    return {
        writeStdin: (chunk) => {
            child.stdin?.write(chunk);
        },
        endStdin: () => {
            child.stdin?.end();
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
        kill: () => {
            child.kill();
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
 * Write through a sibling temporary file and rename, so a failed or truncated
 * write never leaves a half-written target. Content arrives on stdin and is
 * never placed on the command line, which also removes the argv size ceiling
 * that a base64-in-command approach hits around 96 KB.
 */
export function buildWriteScript(absolutePath: string): string {
    const target = shellQuote(absolutePath);
    const temp = shellQuote(`${absolutePath}${WRITE_TEMP_SUFFIX}`);
    return `if cat > ${temp}; then mv -f ${temp} ${target}; else rm -f ${temp}; exit 1; fi`;
}

/** One round trip that distinguishes "absent" from "present but inaccessible". */
export function buildProbeScript(
    absolutePath: string,
    flags: readonly string[],
): string {
    const quoted = shellQuote(absolutePath);
    const checks = flags.map((flag) => `[ -${flag} ${quoted} ]`).join(" && ");
    return `if [ -e ${quoted} ]; then ${checks} && printf OK || printf NOACCESS; else printf NOENT; fi`;
}

export function sshExec(
    remote: string,
    command: string,
    options: SshExecOptions = {},
): Promise<SshExecResult> {
    return new Promise<SshExecResult>((resolve, reject) => {
        const launch = options.spawnFn ?? launchSshProcess;
        let child: SshProcess;
        try {
            child = launch(buildSshArgs(remote, command));
        } catch (error) {
            reject(error);
            return;
        }

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let settled = false;
        let timedOut = false;

        const timer =
            typeof options.timeoutSeconds === "number" &&
            options.timeoutSeconds > 0
                ? setTimeout(() => {
                      timedOut = true;
                      child.kill();
                  }, options.timeoutSeconds * 1000)
                : undefined;

        const onAbort = () => {
            child.kill();
        };

        const cleanup = () => {
            if (timer) clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
        };

        child.onStdout((chunk) => {
            stdoutChunks.push(chunk);
            options.onStdoutData?.(chunk);
        });
        child.onStderr((chunk) => {
            stderrChunks.push(chunk);
            options.onStderrData?.(chunk);
        });
        child.onError((error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        });
        child.onClose((code) => {
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
            if (options.signal.aborted) {
                onAbort();
            } else {
                options.signal.addEventListener("abort", onAbort, {
                    once: true,
                });
            }
        }

        if (options.stdin !== undefined) {
            try {
                child.writeStdin(options.stdin);
            } catch (error) {
                settled = true;
                cleanup();
                reject(error);
                return;
            }
        }
        child.endStdin();
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

export type RemoteProbeResult = "OK" | "NOENT" | "NOACCESS";

export async function remoteProbe(
    remote: string,
    absolutePath: string,
    flags: readonly string[],
    options: SshExecOptions = {},
): Promise<RemoteProbeResult> {
    const stdout = await sshOk(
        remote,
        buildProbeScript(absolutePath, flags),
        options,
    );
    const token = stdout.toString("utf8").trim();
    if (token === "OK" || token === "NOENT" || token === "NOACCESS") {
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
    options: SshExecOptions = {},
): Promise<void> {
    const result = await remoteProbe(remote, absolutePath, flags, options);
    if (result === "OK") return;
    if (result === "NOENT") {
        throw new Error(`Remote path not found on ${remote}: ${absolutePath}`);
    }
    const requirement = flags.includes("w")
        ? "readable and writable"
        : "readable";
    throw new Error(
        `Remote path is not ${requirement} on ${remote}: ${absolutePath}`,
    );
}
