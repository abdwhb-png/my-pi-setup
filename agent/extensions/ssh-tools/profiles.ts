import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeRemoteDir } from "./remote-path.ts";
import { sshOk } from "./transport.ts";

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
 * Interpret a `/ssh` argument. A bare name uses a known profile; anything
 * containing `:` is split into `host` and `:/remote/path`. The explicit path is
 * what makes a remote working directory selectable without SSH I/O.
 */
export function normalizeTargetArg(
    arg: string,
    profiles: SshProfile[],
): SshProfile {
    const trimmed = arg.trim();
    const known = profiles.find((profile) => profile.name === trimmed);
    if (known) return known;

    const separator = trimmed.indexOf(":");
    if (separator > 0) {
        return {
            name: trimmed,
            remote: trimmed.slice(0, separator),
            cwd: trimmed.slice(separator + 1),
        };
    }
    return { name: trimmed, remote: trimmed };
}

export async function resolveRemoteCwd(profile: SshProfile): Promise<string> {
    const explicit = profile.cwd?.trim();
    if (explicit) {
        if (!explicit.startsWith("/")) {
            // A relative remote working directory would make every relative
            // path resolve against the local session directory, which is the
            // exact defect this extension exists to prevent.
            throw new Error(
                `Remote working directory must be an absolute path, but "${explicit}" is relative. Use /ssh ${profile.name}:/absolute/path`,
            );
        }
        return normalizeRemoteDir(explicit);
    }
    const reported = await sshOk(profile.remote, "pwd");
    const pwd = reported.toString("utf8").trim();
    if (!pwd.startsWith("/")) {
        throw new Error(
            `Remote working directory reported by ${profile.remote} was ${JSON.stringify(pwd)}, which is not an absolute path.`,
        );
    }
    return normalizeRemoteDir(pwd);
}
