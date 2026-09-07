/**
 * Shared bash guard logic — no pi dependencies, just pure pattern matching.
 *
 * Provides isDangerous() used by both the safe-bash extension and any
 * other extension that wraps bash execution (e.g. the compressor).
 */

import { resolve as resolvePath } from "node:path";

/** A named bundle of regexes representing one class of dangerous command. */
export interface DangerGroup {
    /** Stable id used in settings.json `safeBash.guardPolicy` (e.g. `"sudo"`). */
    id: string;
    /** Human-readable summary shown in error messages and docs. */
    label: string;
    /** One or more regexes; matching ANY of them trips the group. */
    patterns: RegExp[];
}

/** Structured result used by enforcement and telemetry. */
export interface DangerMatch {
    groupId: string;
    groupLabel: string;
    patternId: string;
    pattern: string;
    normalizedCommand: string;
    message: string;
}

/**
 * Canonical danger groups. Group `id`s are public stable handles for
 * configuring `safeBash.guardPolicy`.
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
        id: "file-delete-api",
        label: "interpreter one-liner direct filesystem deletion APIs",
        patterns: [
            /\b(?:python|python3|python2)\s+-c\s+(?:['"]\s*|[\s\S]*?[^'"\w])(?:shutil\.rmtree|(?:Path\([^)]*\)|[A-Za-z_$][\w$]*)\.(?:unlink|rmdir)|os\.(?:remove|unlink|rmdir|removedirs))\s*\(/,
            /\b(?:python|python3|python2)\s+(?:-\s+)?<<-?\s*['"]?[A-Za-z_][\w]*['"]?[\s\S]*(?:shutil\.rmtree|(?:Path\([^)]*\)|[A-Za-z_$][\w$]*)\.(?:unlink|rmdir)|os\.(?:remove|unlink|rmdir|removedirs))\s*\(/,
            /\bnode\s+(?:-e|--eval)(?:\s+|=)[\s\S]*(?<!['"])\.(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\s*\(/,
            /\bperl\s+-e\s+(?:['"]\s*|[\s\S]*?[^'"\w])(?:unlink|rmdir)\b/,
            /\bruby\s+-e\s+(?:['"]\s*|[\s\S]*?[^'"\w])(?:FileUtils\.rm_rf|File\.(?:delete|unlink)|Dir\.rmdir)\s*\(/,
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
 */
export function inspectDangerousMatches(
    command: string,
    executionName = "safe_bash",
): DangerMatch[] {
    const normalizedCommand = normalize(command);
    const matches: DangerMatch[] = [];
    for (const group of DANGER_GROUPS) {
        for (const [patternIndex, pattern] of group.patterns.entries()) {
            if (!pattern.test(normalizedCommand)) continue;
            matches.push({
                groupId: group.id,
                groupLabel: group.label,
                patternId: `${group.id}:${patternIndex + 1}`,
                pattern: pattern.toString(),
                normalizedCommand,
                message: `Command blocked by ${executionName}: matches dangerous pattern ${pattern} (group: ${group.id})`,
            });
            break;
        }
    }
    return matches;
}

export function inspectDangerous(
    command: string,
    executionName = "safe_bash",
): DangerMatch | null {
    return inspectDangerousMatches(command, executionName)[0] ?? null;
}

export function isDangerous(command: string): string | null {
    return inspectDangerous(command)?.message ?? null;
}

/**
 * Verdict for a cwd-scoped delete authorization request.
 *
 * - `inside`: every resolvable target stays lexically under `cwd`.
 * - `outside`: at least one resolvable target is outside `cwd` (fail closed).
 * - `unknown`: at least one target cannot be resolved statically, so the
 *   command is treated as unsafe.
 */
export interface DeleteTargetScope {
    verdict: "inside" | "outside" | "unknown";
    offendingTarget?: string;
    targets: string[];
}

/** Shell command separators that create an independent command segment. */
const SHELL_SEPARATORS = /&&|\|\||;|\||\r?\n/;

/** Tokenize a shell word list, respecting single/double quotes and backslash escapes. */
function tokenizeShell(s: string): string[] {
    const tokens: string[] = [];
    let cur = "";
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === "\\") {
            if (i + 1 < s.length) {
                cur += s[++i];
            }
            continue;
        }
        if (inSingle) {
            if (ch === "'") inSingle = false;
            else cur += ch;
            continue;
        }
        if (inDouble) {
            if (ch === '"') inDouble = false;
            else cur += ch;
            continue;
        }
        if (ch === "'") {
            inSingle = true;
            continue;
        }
        if (ch === '"') {
            inDouble = true;
            continue;
        }
        if (/\s/.test(ch)) {
            if (cur) {
                tokens.push(cur);
                cur = "";
            }
            continue;
        }
        cur += ch;
    }
    if (cur) tokens.push(cur);
    return tokens;
}

/**
 * Expand a target operand into an absolute, resolvable path, or return null
 * when the target cannot be resolved statically (unknown).
 */
function expandTargetOperand(op: string): string | null {
    if (op === "~" || op.startsWith("~/")) {
        const home = process.env.HOME;
        if (!home) return null;
        return home + op.slice(1);
    }
    if (op === "$HOME" || op.startsWith("$HOME/")) {
        const home = process.env.HOME;
        if (!home) return null;
        return home + op.slice("$HOME".length);
    }
    if (op === "${HOME}" || op.startsWith("${HOME}/")) {
        const home = process.env.HOME;
        if (!home) return null;
        return home + op.slice("${HOME}".length);
    }
    // Any other variable / command substitution / backtick is unresolvable.
    if (/[$`]/.test(op)) return null;
    // Glob characters cannot be resolved to a single path.
    if (/[*?[\]]/.test(op)) return null;
    return op;
}

/** Lexical containment: resolved target is `cwd` itself or under `cwd + "/"`. */
function isContained(resolved: string, root: string): boolean {
    return resolved === root || resolved.startsWith(root + "/");
}

/** Collect rm absolute targets from a command, or null if any is unresolvable. */
function collectRmTargets(
    command: string,
    cwd: string,
): { targets: string[]; unknown: boolean } | null {
    const root = resolvePath(cwd);
    const targets: string[] = [];
    let unknown = false;

    for (const segment of command.split(SHELL_SEPARATORS)) {
        const tokens = tokenizeShell(segment);
        if (tokens.length === 0 || tokens[0] !== "rm") continue;
        let flagMode = true;
        for (let i = 1; i < tokens.length; i++) {
            const tok = tokens[i];
            if (flagMode) {
                if (tok === "--") {
                    flagMode = false;
                    continue;
                }
                if (tok === "-") {
                    // lone dash = stdin itself (unresolvable)
                    unknown = true;
                    continue;
                }
                if (tok.startsWith("-")) continue;
                flagMode = false;
            }
            const expanded = expandTargetOperand(tok);
            if (expanded === null) {
                unknown = true;
                continue;
            }
            targets.push(resolvePath(root, expanded));
        }
    }
    return { targets, unknown };
}

/**
 * Regex capturing path-like string literals from interpreter deletion APIs:
 * the first string argument of common delete calls plus `Path("...")`.
 */
const DELETE_PATH_LITERAL_RE =
    /(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir|removedirs)|fs\.(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)|FileUtils\.rm_rf|File\.(?:delete|unlink)|Dir\.rmdir|(?:Path\s*\([^)]*\)|[A-Za-z_$][\w$]*)\.(?:unlink|rmdir|rm|rmSync|unlinkSync|rmdirSync)|\b(?:unlink|rmdir)\b)\s*\(\s*["']([^"']+)["']|Path\s*\(\s*["']([^"']+)["']/g;

/** Collect file-delete-api absolute targets, or null if a literal is unresolvable. */
function collectApiTargets(
    command: string,
    cwd: string,
): { targets: string[]; unknown: boolean } | null {
    const root = resolvePath(cwd);
    const literals = new Set<string>();
    let m: RegExpExecArray | null;
    DELETE_PATH_LITERAL_RE.lastIndex = 0;
    while ((m = DELETE_PATH_LITERAL_RE.exec(command)) !== null) {
        const lit = m[1] ?? m[2];
        if (lit) literals.add(lit.trim());
    }

    const targets: string[] = [];
    let unknown = false;
    for (const lit of literals) {
        // Skip overlarge / clearly non-path literals (e.g. error strings).
        if (lit.length < 1 || lit.length > 4096) continue;
        const expanded = expandTargetOperand(lit);
        if (expanded === null) {
            unknown = true;
            continue;
        }
        targets.push(resolvePath(root, expanded));
    }
    return { targets, unknown };
}

/**
 * Determine whether a dangerous delete command stays inside `cwd`.
 *
 * Supports the `rm` and `file-delete-api` danger groups. Any other groupId,
 * an unresolvable target (variable/glob/backtick), or a bare invocation with
 * no targets resolves to `unknown` (fail closed). Outside targets are reported
 * with their first offending absolute path.
 */
export function inspectDeleteScope(
    command: string,
    cwd: string,
    groupId: string,
): DeleteTargetScope {
    if (groupId === "rm") {
        const collected = collectRmTargets(command, cwd);
        if (!collected) {
            return { verdict: "unknown", targets: [] };
        }
        return toScope(
            collected.targets,
            collected.unknown,
            resolvePath(cwd),
        );
    }
    if (groupId === "file-delete-api") {
        const collected = collectApiTargets(command, cwd);
        if (!collected) {
            return { verdict: "unknown", targets: [] };
        }
        return toScope(
            collected.targets,
            collected.unknown,
            resolvePath(cwd),
        );
    }
    // Any other group cannot be scoped — fail closed.
    return { verdict: "unknown", targets: [] };
}

function toScope(
    targets: string[],
    unknown: boolean,
    root: string,
): DeleteTargetScope {
    if (unknown) return { verdict: "unknown", targets };
    if (targets.length === 0) return { verdict: "unknown", targets };
    for (const target of targets) {
        if (!isContained(target, root)) {
            return { verdict: "outside", offendingTarget: target, targets };
        }
    }
    return { verdict: "inside", targets };
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
export function redirectShellCommand(
    command: string,
    executionName = "safe_bash",
): string | null {
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

    return `BLOCKED: Use native '${toolName}' tool${speedNote} instead of ${executionName} '${first}'`;
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
    executionName = "safe_bash",
): string | null {
    if (!enforceNative) return null;
    if (allowList.length > 0) {
        const first = firstWord(command);
        if (first && allowList.includes(first)) return null;
    }
    return redirectShellCommand(command, executionName);
}
