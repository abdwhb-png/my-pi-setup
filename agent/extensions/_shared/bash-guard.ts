/**
 * Shared bash guard logic — no pi dependencies, just pure pattern matching.
 *
 * Provides isDangerous() used by both the safe-bash extension and any
 * other extension that wraps bash execution (e.g. the compressor).
 */

const DANGEROUS_PATTERNS: RegExp[] = [
    // ═══ rm — all invocations blocked (safe_bash replace mode; use write/edit tools) ═══
    /\brm\b/,

    // ═══ rm on critical locations ═══
    // Matches rm with any combination of -f/-r flags targeting '/' or '~'
    // Also catches subpaths like /etc, /var since they start with /
    /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?(\/|~\/?(\s|$|\b))/,
    // Same with -r before -f
    /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?(\/|~\/?(\s|$|\b))/,
    // rm -rf /* (glob removal — catches /* where bare / is missed)
    /\brm\s+(-[a-zA-Z]*[fr][a-zA-Z]*\s+)?\/\*/,
    // rm targeting critical system directories (even with path traversal, $HOME, or quote obfuscation)
    /\brm\s+(-[a-zA-Z]*[fr][a-zA-Z]*\s+)?(\$|\.\.\/|\S*\/etc|\S*\/var|\S*\/boot|\S*\/bin|\S*\/usr)/,
    // rm with flags + argument starting with / (catches quote obfuscation like rm -rf ''/"etc")
    /\brm\s+(-[a-zA-Z]*[fr][a-zA-Z]*\s+)?['"]+\//,

    // ═══ Privilege escalation ═══
    /\bsudo\b/,

    // ═══ Filesystem destruction ═══
    /\b(mkfs|mkswap|fdisk|parted|gdisk)\b/,
    /\bdd\s+if=/,
    />\s*\/dev\/(sh|hd|sd|nvme|vd)[a-z]/,

    // ═══ Fork bomb ═══
    /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,

    // ═══ Permission abuse ═══
    /\bchmod\s+(-[a-zA-Z]+\s+)?([0-7]{3,4})\s+\//,
    /\bchown\s+(-[a-zA-Z]+\s+)?root/,

    // ═══ Remote pipe to shell ═══
    /\b(curl|wget)\s.*\|\s*(ba)?sh/,
    // Indirect: curl/wget to file then execute
    /\b(curl|wget)\s+.*(?:-o|-O|>)\s+\S+\s+(?:&&|;)\s+(?:bash|sh|zsh)\b/,
    // base64 decode pipe shell
    /base64\s+-d\s*\|\s*(ba)?sh/,
    // openssl dec pipe shell
    /\bopenssl\s+enc\s+-d\s.*\|\s*(ba)?sh/,

    // ═══ Reverse shell / network tools ═══
    /\bnc\s+-[a-zA-Z]*e\b/,
    /\bsocat\s+.*(?:exec|system)/i,
    /\/dev\/(tcp|udp)\//,

    // ═══ Language-based execution with dangerous patterns ═══
    /\b(python|python3|python2)\s+-c\s+.*\b(?:os\.system|subprocess\.(?:call|Popen|check_call|run))\s*\(/,
    /\bnode\s+-[e"]\s+.*\b(?:exec(?:Sync)?|spawn(?:Sync)?)\s*\(/,
    /\bperl\s+-e\s+.*\b(?:system|exec)/,
    /\bruby\s+-e\s+.*\b(?:system|exec)/,

    // ═══ System shutdown / halt / reboot ═══
    /\b(?:shutdown|reboot|halt|poweroff)\b/,

    // ═══ init to runlevel 0 (halt), 1 (single), 6 (reboot) ═══
    /\binit\s+[016]/,

    // ═══ Process kill critical ═══
    /\bkill\s+-9\s+1\b/,

    // ═══ Block chmod 777 on any path starting with / ═══
    // (already partially covered above, this covers /etc /var /boot etc)
    /\bchmod\s+(-[a-zA-Z]+\s+)?777\s+\/(?!\.)/,

    // ═══ Potential cryptominer detection ═══
    /\b(xmrig|minergate|cpuminer)\b/,
];

/**
 * Normalize a command string to reduce common obfuscation tricks.
 */
function normalize(command: string): string {
    return (
        command
            // Shell line continuation
            .replace(/\\\n/g, ' ')
            // Escaped spaces (e.g., rm\ -rf\ /)
            .replace(/\\ /g, ' ')
            // HTML entities for /
            .replace(/&#x2F;/gi, '/')
            .replace(/&#47;/gi, '/')
            // Collapse multiple spaces
            .replace(/\s{2,}/g, ' ')
            .trim()
    );
}

/**
 * Check if a command is dangerous.
 * Returns null if safe, or an error message string if blocked.
 */
export function isDangerous(command: string): string | null {
    const normalized = normalize(command);
    for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(normalized)) {
            return `Command blocked by safe_bash: matches dangerous pattern ${pattern}`;
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
    grep: 'grep',
    rg: 'grep',
    find: 'find',
    fd: 'find',
    ls: 'ls',
    ack: 'grep',
    ag: 'grep',
};

/**
 * Extract the first word (command name) from a shell command string.
 */
function firstWord(command: string): string | undefined {
    const norm = normalize(command);
    const space = norm.indexOf(' ');
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
        native === 'grep' ? 'grep' : native === 'find' ? 'find' : 'ls';

    const speedNote =
        native === 'grep'
            ? ' (uses ripgrep, 10-100x faster with structured JSON output)'
            : native === 'find'
              ? ' (uses fd, faster and respects .gitignore)'
              : ' (uses Node.js fs APIs, more reliable parsing)';

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
