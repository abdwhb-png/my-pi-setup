/**
 * Remote path and shell-quoting rules.
 *
 * These live in the extension rather than in a pi tool factory `cwd` argument
 * because every pi tool definition resolves paths as `ctx?.cwd || cwd`
 * (`read.js:56`, `write.js:31`, `edit.js:94`) and `ctx.cwd` is the *local*
 * session directory. A `cwd` passed to `createReadToolDefinition` and friends is
 * only a fallback, so remote paths must be made absolute here before they reach
 * pi. See README.md for the full explanation.
 *
 * All joining is done with POSIX string handling. `node:path` is deliberately
 * unused so a local platform separator can never enter a remote path.
 */

/** The exact character class pi rewrites to an ASCII space in `resolveToCwd`. */
const PI_NORMALIZED_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/;

export function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** POSIX dirname, so a temp file can be created on the target's filesystem. */
export function remoteDirname(path: string): string {
    const normalized = normalizeRemoteDir(path);
    const slash = normalized.lastIndexOf("/");
    if (slash <= 0) return "/";
    return normalized.slice(0, slash);
}

function collapseSeparators(path: string): string {
    return path.replace(/\/{2,}/g, "/");
}

export function normalizeRemoteDir(path: string): string {
    const collapsed = collapseSeparators(path);
    return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

/** Collapse duplicate separators and resolve `.` and `..` segments. */
function normalizeSegments(path: string): string {
    const absolute = path.startsWith("/");
    const resolved: string[] = [];
    for (const segment of path.split("/")) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") {
            // At the filesystem root there is nothing above to pop, so the
            // segment is dropped rather than allowed to escape the root.
            resolved.pop();
            continue;
        }
        resolved.push(segment);
    }
    return absolute ? `/${resolved.join("/")}` : resolved.join("/");
}

/**
 * pi's `resolveToCwd` rewrites these characters to an ASCII space before the
 * path ever reaches a remote command, so a path containing one would silently
 * target a different file. Reject it instead: a loud refusal beats writing the
 * wrong file. Mirrors `UNICODE_SPACES` in pi's `dist/utils/paths.js`.
 */
function assertPathSurvivesPiNormalization(path: string): void {
    if (PI_NORMALIZED_SPACES.test(path)) {
        throw new Error(
            `Remote path ${JSON.stringify(path)} contains a Unicode space that pi rewrites to an ASCII space, which would target a different file. Rename the file on the remote host, or reach it with ssh_bash.`,
        );
    }
}

export function assertInsideRemoteCwd(path: string, remoteCwd: string): string {
    assertPathSurvivesPiNormalization(path);
    const base = normalizeRemoteDir(remoteCwd);
    // Resolve `..` before the prefix test. Without this, "/home/dev/../etc/x"
    // passes a naive startsWith check and pi then normalizes it to "/etc/x".
    const target = normalizeSegments(path);
    if (base === "/" || target === base || target.startsWith(`${base}/`)) {
        return target;
    }
    throw new Error(
        `Remote path ${target} is outside the active SSH working directory ${base}. Use a relative path or switch SSH mode to that directory.`,
    );
}

/**
 * Resolve a model-supplied path to an absolute remote path.
 *
 * Absolute paths are used as-is, so `ssh_read` and `ssh_write` can reach
 * out-of-tree system files. Relative paths resolve under the active remote
 * working directory and may not escape it.
 */
export function resolveRemotePath(path: string, remoteCwd: string): string {
    assertPathSurvivesPiNormalization(path);
    const base = normalizeRemoteDir(remoteCwd);
    if (!base.startsWith("/")) {
        // A relative base would make the result relative, and pi would then
        // resolve it against the local session directory.
        throw new Error(
            `Remote working directory must be an absolute path, but ${JSON.stringify(remoteCwd)} is relative.`,
        );
    }
    if (path.startsWith("/")) {
        return normalizeSegments(path);
    }
    if (base === "/") {
        return normalizeSegments(`/${path}`);
    }
    return assertInsideRemoteCwd(normalizeSegments(`${base}/${path}`), base);
}

/**
 * `ssh_edit` is sandboxed to the active remote working directory, unlike
 * `ssh_read` and `ssh_write`, so a stray absolute path cannot rewrite a system
 * file. Relative paths still resolve under the remote working directory.
 */
export function resolveSandboxedRemotePath(
    path: string,
    remoteCwd: string,
): string {
    return path.startsWith("/")
        ? assertInsideRemoteCwd(path, remoteCwd)
        : resolveRemotePath(path, remoteCwd);
}
