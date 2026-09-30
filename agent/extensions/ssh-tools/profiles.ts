import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    assertPathSurvivesPiNormalization,
    normalizeRemotePath,
} from "./remote-path.ts";
import { sshOk, type SshExecOptions } from "./transport.ts";

/** A `/ssh` argument before the remote working directory is resolved. */
export type SshProfile = {
    name: string;
    remote: string;
    cwd?: string;
};

const SSH_CONFIG_PATH = join(homedir(), ".ssh", "config");

/**
 * Read `Host` aliases from the local `~/.ssh/config`. The file is user state
 * and is never written here; it is re-read on each `/ssh` invocation so a newly
 * added host is picked up without restarting pi.
 */
export function parseSshConfigProfiles(): SshProfile[] {
    if (!existsSync(SSH_CONFIG_PATH)) {
        return [];
    }

    const profiles = new Map<string, SshProfile>();
    for (const rawLine of readFileSync(SSH_CONFIG_PATH, "utf8").split("\n")) {
        const line = rawLine.replace(/\s+#.*$/, "").trim();
        const match = line.match(/^Host\s+(.+)$/i);
        if (!match) continue;

        for (const alias of match[1]
            .split(/\s+/)
            .map((value) => value.trim())) {
            if (!alias) continue;
            if (
                alias.includes("*") ||
                alias.includes("?") ||
                alias.startsWith("!")
            ) {
                continue;
            }
            if (!profiles.has(alias)) {
                profiles.set(alias, { name: alias, remote: alias });
            }
        }
    }

    return Array.from(profiles.values()).toSorted((a, b) =>
        a.name.localeCompare(b.name),
    );
}

/**
 * Index of the `:` that separates host from `:/remote/path`, or -1.
 *
 * A bracketed IPv6 literal contains colons of its own, so the split has to
 * happen after the closing bracket. `user@[2001:db8::1]:/repo` splits after the
 * final `]`; a bare `[2001:db8::1]` has no separator.
 */
function findRemoteSeparator(arg: string): number {
    // A user@ prefix may itself contain a bracketed IPv6 literal, so the host
    // bracket is located from whichever bracket appears last.
    const open = arg.lastIndexOf("[");
    if (open !== -1) {
        const bracket = arg.indexOf("]", open);
        if (bracket === -1) return -1;
        return arg[bracket + 1] === ":" ? bracket + 1 : -1;
    }
    return arg.indexOf(":");
}

/**
 * A destination ssh may interpret as an option rather than a host.
 *
 * `remote` reaches `spawn("ssh", [remote, command])` with no shell, so
 * metacharacters are inert, but a leading dash makes ssh read it as an
 * argument. `-oProxyCommand=<cmd>` is the dangerous case: it runs a local
 * command while connecting.
 *
 * The whole destination must be dash-free, not just the part after `@`. ssh
 * sees the argument as one string, so `-oProxyCommand=id@host` is an option
 * even though its host part is a plausible name.
 */
function assertHostArgument(remote: string): void {
    if (remote.startsWith("-") || remote.includes("@-")) {
        throw new Error(
            `SSH target ${JSON.stringify(remote)} would be read by ssh as an option, not a host. Use a hostname, user@host, or bracketed IPv6 address.`,
        );
    }
}

/**
 * Interpret a `/ssh` argument. A bare name uses a known profile; anything
 * containing `:` is split into `host` and `:/remote/path`. The explicit path is
 * what makes a remote working directory selectable without SSH I/O.
 */
export function normalizeTargetArg(
    arg: string,
    profiles: SshProfile[],
): SshProfile {
    // Only the host token may be trimmed. Trimming the entire argument would
    // silently select a different remote directory when its name ends in space.
    const trimmed = arg.trimStart();
    const known = profiles.find((profile) => profile.name === trimmed.trim());
    if (known) {
        assertHostArgument(known.remote);
        return known;
    }

    const separator = findRemoteSeparator(trimmed);
    if (separator > 0) {
        const remote = trimmed.slice(0, separator);
        assertHostArgument(remote);
        return {
            name: trimmed,
            remote,
            cwd: trimmed.slice(separator + 1),
        };
    }
    const host = trimmed.trim();
    assertHostArgument(host);
    return { name: host, remote: host };
}

/**
 * Control characters a remote could use to forge prompt lines or to drive the
 * terminal: C0, DEL/C1, and the two Unicode line separators.
 */
// oxlint-disable-next-line no-control-regex
const REMOTE_CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

/**
 * The `pwd` output is chosen by the remote, so it is untrusted input that must
 * not carry more than a plain path. A second line would be promoted into the
 * system prompt as if the model had been told it, and the local tools stay
 * enabled, so a hostile host could use it to exfiltrate local files.
 */
function assertUsableReportedPath(value: string, remote: string): void {
    if (!value.startsWith("/") || REMOTE_CONTROL_CHARS.test(value)) {
        throw new Error(
            `Remote working directory reported by ${remote} was ${JSON.stringify(value)}, which is not a usable absolute path. Pass it explicitly instead: /ssh ${remote}:/absolute/path`,
        );
    }
    // A character pi rewrites names a different path here than it would after
    // pi touches it, so the working directory and the tool call could disagree.
    // This reuses the same rule the model-supplied paths are held to.
    assertPathSurvivesPiNormalization(value);
}

/**
 * `ConnectTimeout` bounds only TCP connect and auth. A host that accepts the
 * connection and then stalls would leave `/ssh` pending forever, because
 * nothing else in the command path sets a deadline. A caller's `timeoutSeconds`
 * overrides this.
 */
export const ACTIVATION_PROBE_TIMEOUT_SECONDS = 30;

export async function resolveRemoteCwd(
    profile: SshProfile,
    options: SshExecOptions = {},
): Promise<string> {
    const explicit = profile.cwd;
    if (explicit !== undefined) {
        assertPathSurvivesPiNormalization(explicit);
        if (!explicit.startsWith("/")) {
            // A relative remote working directory would make every relative
            // path resolve against the local session directory, which is the
            // exact defect this extension exists to prevent.
            throw new Error(
                `Remote working directory must be an absolute path, but "${explicit}" is relative. Use /ssh ${profile.name}:/absolute/path`,
            );
        }
        return normalizeRemotePath(explicit);
    }
    const reported = await sshOk(profile.remote, "pwd", {
        // `ConnectTimeout` bounds only TCP connect and auth. A host that
        // accepts the connection and then stalls would leave `/ssh` pending
        // forever, because nothing else in the command path sets a deadline.
        // The caller may override it; the default is the floor that exists.
        timeoutSeconds: ACTIVATION_PROBE_TIMEOUT_SECONDS,
        ...options,
    });
    // Strip only the single line terminator `pwd` is expected to emit. A
    // blanket trim() also erases characters that name a different directory,
    // such as a trailing non-breaking space, which would silently select the
    // wrong working directory instead of refusing it.
    const pwd = reported.toString("utf8").replace(/\r?\n$/, "");
    assertUsableReportedPath(pwd, profile.remote);
    return normalizeRemotePath(pwd);
}
