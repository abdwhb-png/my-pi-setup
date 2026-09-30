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
        // The rename committed, so the outcome is known. pi's write and edit
        // factories re-check the abort signal after this returns and would
        // throw a bare "Operation aborted", which reads as "nothing happened"
        // and invites a duplicate write. Reporting the truth here, while this
        // error can still be the one the model reads, beats letting a
        // misleading message replace it.
        if (options.signal?.aborted) {
            throw new Error(
                "The write completed on the remote host, but the turn was aborted before the tool result was reported. The file HAS been updated. Do not retry: read the remote file to confirm its contents.",
                { cause: new Error("aborted") },
            );
        }
        return result.stdout;
    }
    // ssh reserves 255 for its own failures, so a session that died after the
    // rename committed is indistinguishable from one that never started. Both
    // are an unknown outcome rather than a known failure.
    const cause = new Error(describeFailure(remote, result));
    if (result.exitCode === null) {
        // No exit code at all means the child was killed, so whether the rename
        // committed is unknown exactly as for a dropped transfer.
        throw new Error(
            `${OUTCOME_UNKNOWN} (ssh closed without reporting an exit code: ${cause.message})`,
            { cause },
        );
    }
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
/**
 * `expectedPath` is the absolute path this extension resolved. pi re-resolves
 * the path against its LOCAL cwd and then probes the LOCAL filesystem for
 * macOS AM/PM, NFD, and curly-quote variants, so the path that reaches these
 * operations can differ from the one that was asked for. A local file must
 * never decide which remote file gets read.
 */
export function createRemoteReadOps(
    target: ActiveSshTarget,
    expectedPath: string,
    options: SshExecOptions = {},
): ReadOperations {
    const assertUnchanged = (path: string) => {
        if (path !== expectedPath) {
            throw new Error(
                `Refusing to read ${JSON.stringify(path)}: pi resolved the requested path to it, but the SSH extension resolved ${JSON.stringify(expectedPath)}. A local file would otherwise choose the remote file. Pass the path pi's local probing would substitute as the request instead.`,
            );
        }
    };
    return {
        // Async so a rejected path surfaces as a rejected promise rather than a
        // synchronous throw, matching what pi's operations contract expects.
        readFile: async (absolutePath) => {
            assertUnchanged(absolutePath);
            return readRemoteFile(target.remote, absolutePath, options);
        },
        access: async (absolutePath) => {
            assertUnchanged(absolutePath);
            return assertRemoteAccess(
                target.remote,
                absolutePath,
                READABLE,
                options,
            );
        },
        detectImageMimeType: async (absolutePath) => {
            assertUnchanged(absolutePath);
            return imageMimeType(absolutePath);
        },
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

/** pi's own ceiling, so an oversized timeout cannot silently lose its timer. */
const MAX_TIMEOUT_SECONDS = 2_147_483.647;

/**
 * pi enforces the timeout contract inside its LOCAL shell operations
 * (`bash.js`, `resolveTimeoutMs`), which this extension replaces. Without the
 * same check a negative or oversized timeout skips the timer entirely, so the
 * remote command would run with no bound at all.
 */
function assertValidTimeout(timeout: number | undefined): void {
    if (timeout === undefined) return;
    if (!Number.isFinite(timeout) || timeout <= 0) {
        throw new Error("Invalid timeout: must be a finite number of seconds");
    }
    if (timeout > MAX_TIMEOUT_SECONDS) {
        throw new Error(
            `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`,
        );
    }
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
            assertValidTimeout(timeout);
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
