import type {
    BashOperations,
    EditOperations,
    ReadOperations,
    WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { shellQuote } from "./remote-path.ts";
import {
    assertRemoteAccess,
    buildWriteScript,
    describeFailure,
    type SshExecOptions,
    type SshExecResult,
    SSH_TRANSPORT_EXIT,
    sshExec,
    sshOk,
} from "./transport.ts";

/** The host and directory SSH mode is currently pointed at. */
export type ActiveSshTarget = {
    name: string;
    remote: string;
    remoteCwd: string;
};

const READABLE = ["r"] as const;
const READ_WRITABLE = ["r", "w"] as const;

/** Extension match without `node:path`, so no local separator leaks in. */
function imageMimeType(path: string): string | null {
    const dot = path.lastIndexOf(".");
    if (dot <= path.lastIndexOf("/")) return null;
    switch (path.slice(dot + 1).toLowerCase()) {
        case "jpg":
        case "jpeg":
            return "image/jpeg";
        case "png":
            return "image/png";
        case "gif":
            return "image/gif";
        case "webp":
            return "image/webp";
        default:
            return null;
    }
}

function readRemoteFile(
    remote: string,
    absolutePath: string,
    options: SshExecOptions,
) {
    return sshOk(remote, `cat ${shellQuote(absolutePath)}`, options);
}

const OUTCOME_UNKNOWN =
    "The transfer was interrupted, so whether the file was replaced is UNKNOWN. Do not retry blindly: read the remote file first to see whether the new content landed.";

/**
 * `expectedBytes` must be the byte length of the content on the wire, not its
 * JavaScript string length. A multi-byte character would otherwise make the
 * remote completeness check fail on a transfer that actually succeeded.
 */
async function writeRemoteFile(
    remote: string,
    absolutePath: string,
    content: string,
    options: SshExecOptions,
): Promise<Buffer> {
    let result: SshExecResult;
    try {
        result = await sshExec(
            remote,
            buildWriteScript(absolutePath, Buffer.byteLength(content)),
            { ...options, stdin: content },
        );
    } catch (error) {
        // An abort or timeout can land after the remote `mv` committed, so the
        // extension cannot claim the previous file is intact. Saying "failed"
        // would invite a retry against a file that may already be updated.
        const message = error instanceof Error ? error.message : String(error);
        if (message === "aborted" || message.startsWith("timeout:")) {
            throw new Error(`${OUTCOME_UNKNOWN} (${message})`, {
                cause: error,
            });
        }
        throw error;
    }
    if (result.exitCode === 0) {
        return result.stdout;
    }
    // ssh reserves 255 for its own failures, so a session that died after the
    // rename committed is indistinguishable from one that never started. Both
    // are an unknown outcome rather than a known failure.
    const cause = new Error(describeFailure(remote, result));
    if (result.exitCode === SSH_TRANSPORT_EXIT) {
        throw new Error(
            `${OUTCOME_UNKNOWN} (ssh exited ${SSH_TRANSPORT_EXIT} before reporting a result: ${cause.message})`,
            { cause },
        );
    }
    // A reported non-zero exit is a real failure: the remote script ran to
    // completion, so whether the rename happened is known.
    throw cause;
}

/**
 * Operations receive paths that are already absolute and remote. Path
 * resolution happens in the extension's tool wrappers, never in the pi tool
 * factory `cwd`, because pi resolves paths as `ctx?.cwd || cwd`.
 */
export function createRemoteReadOps(
    target: ActiveSshTarget,
    options: SshExecOptions = {},
): ReadOperations {
    return {
        readFile: (absolutePath) =>
            readRemoteFile(target.remote, absolutePath, options),
        access: (absolutePath) =>
            assertRemoteAccess(target.remote, absolutePath, READABLE, options),
        detectImageMimeType: async (absolutePath) =>
            imageMimeType(absolutePath),
    };
}

export function createRemoteWriteOps(
    target: ActiveSshTarget,
    options: SshExecOptions = {},
): WriteOperations {
    return {
        writeFile: async (absolutePath, content) => {
            await writeRemoteFile(
                target.remote,
                absolutePath,
                content,
                options,
            );
        },
        mkdir: async (dir) => {
            await sshOk(target.remote, `mkdir -p ${shellQuote(dir)}`, options);
        },
    };
}

export function createRemoteEditOps(
    target: ActiveSshTarget,
    options: SshExecOptions = {},
): EditOperations {
    return {
        readFile: (absolutePath) =>
            readRemoteFile(target.remote, absolutePath, options),
        writeFile: async (absolutePath, content) => {
            await writeRemoteFile(
                target.remote,
                absolutePath,
                content,
                options,
            );
        },
        access: (absolutePath) =>
            assertRemoteAccess(target.remote, absolutePath, READ_WRITABLE, {
                ...options,
                // The edit path writes through a temp file and renames, which
                // would replace a symlink instead of its target. Detecting it
                // here costs no extra round trip.
                detectLink: true,
            }),
    };
}

export function createRemoteBashOps(
    target: ActiveSshTarget,
    options: SshExecOptions = {},
): BashOperations {
    return {
        /**
         * `cwd` is pi's *local* session directory: `bash.js` resolves
         * `ctx?.cwd || cwd` before calling `exec`. It is deliberately ignored so
         * a local path can never be `cd`-ed into on the remote host. A `cd`
         * written by the model inside `command` still applies, because this only
         * prepends the remote working directory.
         */
        exec: async (command, _cwd, { onData, signal, timeout }) => {
            const script = `cd ${shellQuote(target.remoteCwd)}\n${command}\n`;
            const result = await sshExec(target.remote, "exec bash -se", {
                spawnFn: options.spawnFn,
                stdin: script,
                signal: signal ?? options.signal,
                timeoutSeconds: timeout,
                onStdoutData: onData,
                onStderrData: onData,
            });
            if (result.exitCode === SSH_TRANSPORT_EXIT) {
                // ssh returns 255 for its own failures, and a remote command
                // can also exit 255; the two are indistinguishable from the
                // exit code alone. Report both rather than guess, because a
                // bare "exited with code 255" is not actionable.
                const detail =
                    result.stderr.toString("utf8").trim() ||
                    result.stdout.toString("utf8").trim() ||
                    "no output";
                throw new Error(
                    `Command on ${target.remote} exited with 255. That usually means an SSH transport, host-key, or authentication failure, though a command that exits 255 itself looks the same. Remote output: ${detail}`,
                );
            }
            return { exitCode: result.exitCode };
        },
    };
}
