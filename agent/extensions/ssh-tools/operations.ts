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
    type SshExecOptions,
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

function writeRemoteFile(
    remote: string,
    absolutePath: string,
    content: string,
    options: SshExecOptions,
): Promise<Buffer> {
    return sshOk(remote, buildWriteScript(absolutePath), {
        ...options,
        stdin: content,
    });
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
            assertRemoteAccess(
                target.remote,
                absolutePath,
                READ_WRITABLE,
                options,
            ),
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
            const { exitCode } = await sshExec(target.remote, "exec bash -se", {
                spawnFn: options.spawnFn,
                stdin: script,
                signal: signal ?? options.signal,
                timeoutSeconds: timeout,
                onStdoutData: onData,
                onStderrData: onData,
            });
            return { exitCode };
        },
    };
}
