/**
 * Shared bash guard logic — no pi dependencies, just pure pattern matching.
 *
 * Provides isDangerous() used by both the safe-bash extension and any
 * other extension that wraps bash execution (e.g. the compressor).
 */

/** A named bundle of regexes representing one class of dangerous command. */
export interface DangerGroup {
    /** Stable id used in settings.json `safeBash.allowDangerous` (e.g. `"sudo"`). */
    id: string;
    /** Human-readable summary shown in error messages and docs. */
    label: string;
    /** One or more regexes; matching ANY of them trips the group. */
    patterns: RegExp[];
}

/**
 * Canonical danger groups. Group `id`s are the public, stable handle for
 * selectively disabling a class of check via `safeBash.allowDangerous`.
 * Patterns are verbatim from the previous flat `DANGEROUS_PATTERNS` array —
 * only their container changed.
 */
export const DANGER_GROUPS: readonly DangerGroup[] = [
    {
        id: "rm",
        label: "rm (all invocations blocked in replace mode)",
        patterns: [
            // bare rm — all invocations blocked in replace mode; use write/edit tools
            /\brm\b/,
            // rm with -f/-r targeting '/' or '~', incl. subpaths like /etc, /var
            /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?(\/|~\/?(\s|$|\b))/,
            // same with -r before -f
            /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?(\/|~\/?(\s|$|\b))/,
            // rm -rf /*
            /\brm\s+(-[a-zA-Z]*[fr][a-zA-Z]*\s+)?\/\*/,
            // rm targeting system dirs (path traversal, $HOME, quote obfuscation)
            /\brm\s+(-[a-zA-Z]*[fr][a-zA-Z]*\s+)?(\$|\.\.\/|\S*\/etc|\S*\/var|\S*\/boot|\S*\/bin|\S*\/usr)/,
            // rm with flags + arg starting with / (catches quote obfuscation)
            /\brm\s+(-[a-zA-Z]*[fr][a-zA-Z]*\s+)?['"]+\//,
        ],
    },
    {
        id: "sudo",
        label: "sudo (privilege escalation)",
        patterns: [/\bsudo\b/],
    },
    {
        id: "mkfs",
        label: "mkfs / mkswap / fdisk / parted / gdisk",
        patterns: [/\b(mkfs|mkswap|fdisk|parted|gdisk)\b/],
    },
    {
        id: "dd",
        label: "dd if=",
        patterns: [/\bdd\s+if=/],
    },
    {
        id: "raw-disk-write",
        label: "write to raw disk device (/dev/sdX etc.)",
        patterns: [/>\s*\/dev\/(sh|hd|sd|nvme|vd)[a-z]/],
    },
    {
        id: "forkbomb",
        label: "fork bomb",
        patterns: [/:\(\)\s*\{\s*:\|:&\s*\}\s*;:/],
    },
    {
        id: "chmod",
        label: "chmod on root paths (incl. chmod 777 /)",
        patterns: [
            /\bchmod\s+(-[a-zA-Z]+\s+)?([0-7]{3,4})\s+\//,
            /\bchmod\s+(-[a-zA-Z]+\s+)?777\s+\/(?!\.)/,
        ],
    },
    {
        id: "chown",
        label: "chown to root",
        patterns: [/\bchown\s+(-[a-zA-Z]+\s+)?root/],
    },
    {
        id: "remote-shell",
        label: "curl/wget/base64/openssl piped to shell",
        patterns: [
            /\b(curl|wget)\s.*\|\s*(ba)?sh/,
            // indirect: curl/wget to file then execute
            /\b(curl|wget)\s+.*(?:-o|-O|>)\s+\S+\s+(?:&&|;)\s+(?:bash|sh|zsh)\b/,
            /base64\s+-d\s*\|\s*(ba)?sh/,
            /\bopenssl\s+enc\s+-d\s.*\|\s*(ba)?sh/,
        ],
    },
    {
        id: "reverse-shell",
        label: "reverse shell / network tools (nc, socat, /dev/tcp)",
        patterns: [
            /\bnc\s+-[a-zA-Z]*e\b/,
            /\bsocat\s+.*(?:exec|system)/i,
            /\/dev\/(tcp|udp)\//,
        ],
    },
    {
        id: "exec-injection",
        label: "python/node/perl/ruby one-liner shell calls",
        patterns: [
            /\b(python|python3|python2)\s+-c\s+.*\b(?:os\.system|subprocess\.(?:call|Popen|check_call|run))\s*\(/,
            /\bnode\s+-[e"]\s+.*\b(?:exec(?:Sync)?|spawn(?:Sync)?)\s*\(/,
            /\bperl\s+-e\s+.*\b(?:system|exec)/,
            /\bruby\s+-e\s+.*\b(?:system|exec)/,
        ],
    },
    {
        id: "shutdown",
        label: "shutdown / reboot / halt / poweroff",
        patterns: [/\b(?:shutdown|reboot|halt|poweroff)\b/],
    },
    {
        id: "init",
        label: "init to runlevel 0 (halt), 1 (single), 6 (reboot)",
        patterns: [/\binit\s+[016]/],
    },
    {
        id: "kill",
        label: "kill -9 1 (PID 1)",
        patterns: [/\bkill\s+-9\s+1\b/],
    },
    {
        id: "cryptominer",
        label: "cryptominer binaries (xmrig, minergate, cpuminer)",
        patterns: [/\b(xmrig|minergate|cpuminer)\b/],
    },
];

/** Canonical list of all danger-group ids (for validation, docs, completions). */
export const DANGER_GROUP_IDS: readonly string[] = DANGER_GROUPS.map(
    (g) => g.id,
);

/**
 * Normalize a command string to reduce common obfuscation tricks.
 */
function normalize(command: string): string {
    return (
        command
            // Shell line continuation
            .replace(/\\\n/g, " ")
            // Escaped spaces (e.g., rm\ -rf\ /)
            .replace(/\\ /g, " ")
            // HTML entities for /
            .replace(/&#x2F;/gi, "/")
            .replace(/&#47;/gi, "/")
            // Collapse multiple spaces
            .replace(/\s{2,}/g, " ")
            .trim()
    );
}

/**
 * Check if a command is dangerous.
 * Returns null if safe, or an error message string if blocked.
 *
 * @param command - Raw shell command string.
 * @param allowedGroups - Optional set of danger-group ids (e.g. `"sudo"`,
 *   `"rm"`) to skip entirely. Unknown ids are ignored. When a group is
 *   allowed, NONE of its patterns run — so a command is only blocked by
 *   the remaining groups. Empty/undefined = all groups enforced
 *   (backward compatible).
 */
export function isDangerous(
    command: string,
    allowedGroups: ReadonlySet<string> = new Set(),
): string | null {
    const normalized = normalize(command);
    for (const group of DANGER_GROUPS) {
        if (allowedGroups.has(group.id)) continue;
        for (const pattern of group.patterns) {
            if (pattern.test(normalized)) {
                return `Command blocked by safe_bash: matches dangerous pattern ${pattern} (group: ${group.id})`;
            }
        }
    }
    return null;
}

/**
 * Shell commands that have native Pi tool equivalents, mapped to their
 * native tool names. When the LLM tries to use these via safe_bash, we
 * redirect it to the better native implementation.
 */
const SHELL_TO_NATIVE_MAP: Record<string, string> = {
    grep: "grep",
    rg: "grep",
    find: "find",
    fd: "find",
    ls: "ls",
    ack: "grep",
    ag: "grep",
};

/**
 * Extract the first word (command name) from a shell command string.
 */
function firstWord(command: string): string | undefined {
    const norm = normalize(command);
    const space = norm.indexOf(" ");
    if (space === -1) return norm;
    return norm.slice(0, space);
}

/**
 * Check if a command should be redirected to a native Pi tool instead.
 * Returns null if the command has no native equivalent, or a redirect
 * message string (safe_bash will throw this as an error for the LLM).
 *
 * Example: `grep -r "foo" .` → "BLOCKED: Use native 'grep' tool (uses ripgrep, 10-100x faster with structured JSON output) instead of 'bash grep'"
 */
export function redirectShellCommand(command: string): string | null {
    const first = firstWord(command);
    if (!first) return null;
    const native = SHELL_TO_NATIVE_MAP[first];
    if (!native) return null;

    const toolName =
        native === "grep" ? "grep" : native === "find" ? "find" : "ls";

    const speedNote =
        native === "grep"
            ? " (uses ripgrep, 10-100x faster with structured JSON output)"
            : native === "find"
              ? " (uses fd, faster and respects .gitignore)"
              : " (uses Node.js fs APIs, more reliable parsing)";

    return `BLOCKED: Use native '${toolName}' tool${speedNote} instead of safe_bash '${first}'`;
}

/**
 * Audit-policy-aware variant of redirectShellCommand.
 *
 * When `enforceNative` is true (standard profile), behaves identically to
 * redirectShellCommand — returns a BLOCKED error string for redirectable
 * commands.
 *
 * When `enforceNative` is false (audit / advanced profiles), redirection is
 * relaxed: returns null so the command is allowed through.
 *
 * `allowList` (optional) bypasses redirection for specific commands by first
 * word, regardless of profile. Useful when the user explicitly wants a shell
 * command (e.g. `grep`, `find`) to run through safe_bash instead of the native
 * tool. `isDangerous()` still runs upstream — only the redirect is bypassed.
 *
 * The caller (safe-bash/index.ts) is responsible for reading the active
 * policy flag via shouldEnforceNativeTools() before calling this function.
 */
export function redirectShellCommandWithPolicy(
    command: string,
    enforceNative: boolean,
    allowList: ReadonlyArray<string> = [],
): string | null {
    if (!enforceNative) return null;
    if (allowList.length > 0) {
        const first = firstWord(command);
        if (first && allowList.includes(first)) return null;
    }
    return redirectShellCommand(command);
}
