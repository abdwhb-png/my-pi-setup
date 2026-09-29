/**
 * Shared bash guard logic — no pi dependencies: pattern matching, lexical path
 * resolution, and a symlink check for chmod operands.
 *
 * Provides isDangerous() used by both the safe-bash extension and any
 * other extension that wraps bash execution (e.g. the compressor).
 */

import { lstatSync } from "node:fs";
import { homedir } from "node:os";
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
        label: "rm invocations at a command position (incl. git rm, xargs, -exec)",
        patterns: [
            // rm at a command position. The bare word is not enough: it also
            // appears as an identifier in interpreter one-liners (audit event
            // 53ab0c7f). `git rm`, `xargs` and `-exec` positions stay in the
            // group so the scope check, not the pattern, decides them.
            /(?:^|[;&|]|\n|-exec\s+|xargs\s+(?:-\S+\s+)*)\s*(?:sudo\s+|command\s+|env\s+\S+\s+)*(?:git\s+)?rm(?=[\s;&|]|$)/,
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
        label: "chmod (scope-decided: cwd containment, protected roots, catastrophic modes)",
        patterns: [
            // Any chmod is a candidate: the verdict comes from inspectChmodScope
            // (mode + resolved targets), never from this pattern alone.
            /\bchmod\b/,
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
            // `node` and `bun` share the shape. The bare-call alternative
            // (`await rm(dir)`) is what the command-position rm pattern used to
            // catch by accident before it was anchored (audit event 53ab0c7f).
            /\b(?:node|bun)\s+(?:-e|--eval)(?:\s+|=)[\s\S]*(?:(?<!['"])\.|(?<![\w.$]))(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\s*\(/,
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
        patterns: [
            // Command position only: the bare word also appears inside string
            // literals and identifiers (audit event 9697380d).
            /(?:^|[;&|]|\n)\s*(?:sudo\s+|command\s+|env\s+\S+\s+)*(?:shutdown|reboot|halt|poweroff)(?=[\s;&|]|$)/,
            // systemctl reaches the same state without the bare verb.
            /(?:^|[;&|]|\n)\s*(?:sudo\s+)?systemctl\s+(?:poweroff|reboot|halt)(?=[\s;&|]|$)/,
        ],
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
 * - `unresolvable`: an invocation was found, but its operand is dynamic
 *   (variable, glob, lone `-`) or missing.
 * - `no-invocation`: the group pattern matched text this parser cannot read as
 *   an `rm`/`git rm` segment — `xargs rm`, `find -exec rm`, or a mention inside
 *   a string. Fail closed.
 * - `unknown`: the group cannot be scoped at all.
 */
export interface DeleteTargetScope {
    verdict: DeleteScopeVerdict;
    /**
     * The operand that broke the scope: a resolved absolute path for `outside`,
     * the raw unresolved operand for `unresolvable`.
     */
    offendingTarget?: string;
    targets: string[];
}

/** Scope verdicts for the delete groups. */
export type DeleteScopeVerdict =
    | "inside"
    | "outside"
    | "unresolvable"
    | "no-invocation"
    | "unknown";

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

/** Index of the first target operand for an `rm` or `git rm` segment. */
function rmInvocationIndex(tokens: readonly string[]): number | undefined {
    if (tokens[0] === "rm") return 1;
    if (tokens[0] === "git" && tokens[1] === "rm") return 2;
    return undefined;
}

/** Collect rm absolute targets from a command, or null if any is unresolvable. */
/** Targets collected from one command, plus what stopped the resolver. */
interface CollectedTargets {
    targets: string[];
    /** An operand (or literal) could not be resolved statically. */
    unknown: boolean;
    /** An `rm`/`git rm` segment was found, even with no operand. */
    sawInvocation: boolean;
    /** Raw operand that could not be resolved, when one exists. */
    offendingOperand?: string;
}

function collectRmTargets(command: string, cwd: string): CollectedTargets {
    const root = resolvePath(cwd);
    const targets: string[] = [];
    let unknown = false;
    let sawInvocation = false;
    let offendingOperand: string | undefined;

    for (const segment of command.split(SHELL_SEPARATORS)) {
        const tokens = tokenizeShell(segment);
        // `git rm` deletes working-tree files, so it is scoped like `rm` rather
        // than blocked blindly (audit event d955fa02).
        const invocationIndex = rmInvocationIndex(tokens);
        if (invocationIndex === undefined) continue;
        sawInvocation = true;
        let flagMode = true;
        for (let i = invocationIndex; i < tokens.length; i++) {
            const tok = tokens[i];
            if (flagMode) {
                if (tok === "--") {
                    flagMode = false;
                    continue;
                }
                if (tok === "-") {
                    // lone dash = stdin itself (unresolvable)
                    unknown = true;
                    offendingOperand ??= tok;
                    continue;
                }
                if (tok.startsWith("-")) continue;
                flagMode = false;
            }
            const expanded = expandTargetOperand(tok);
            if (expanded === null) {
                unknown = true;
                offendingOperand ??= tok;
                continue;
            }
            targets.push(resolvePath(root, expanded));
        }
    }
    return { targets, unknown, sawInvocation, offendingOperand };
}

/**
 * Regex capturing path-like string literals from interpreter deletion APIs:
 * the first string argument of common delete calls plus `Path("...")`.
 */
const DELETE_PATH_LITERAL_RE =
    /(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir|removedirs)|fs\.(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)|FileUtils\.rm_rf|File\.(?:delete|unlink)|Dir\.rmdir|(?:Path\s*\([^)]*\)|[A-Za-z_$][\w$]*)\.(?:unlink|rmdir|rm|rmSync|unlinkSync|rmdirSync)|\b(?:unlink|rmdir)\b)\s*\(\s*["']([^"']+)["']|Path\s*\(\s*["']([^"']+)["']/g;

/** Collect file-delete-api absolute targets, or null if a literal is unresolvable. */
function collectApiTargets(command: string, cwd: string): CollectedTargets {
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
    let offendingOperand: string | undefined;
    for (const lit of literals) {
        // Skip overlarge / clearly non-path literals (e.g. error strings).
        if (lit.length < 1 || lit.length > 4096) continue;
        const expanded = expandTargetOperand(lit);
        if (expanded === null) {
            unknown = true;
            offendingOperand ??= lit;
            continue;
        }
        targets.push(resolvePath(root, expanded));
    }
    // This scope only runs after the group's own pattern matched a deletion
    // call, so an invocation exists even when no path literal was captured.
    return { targets, unknown, sawInvocation: true, offendingOperand };
}

/**
 * Determine whether a dangerous delete command stays inside `cwd`.
 *
 * Supports the `rm` and `file-delete-api` danger groups. Any other groupId,
 * an unresolvable target (variable/glob/backtick), or a bare invocation with
 * no targets resolves to `unknown` (fail closed). Outside targets are reported
 * with their first offending absolute path.
 */
/**
 * Determine whether a dangerous delete command stays inside `cwd`.
 *
 * Supports the `rm` and `file-delete-api` danger groups; any other groupId
 * fails closed to `unknown`. Dynamic operands fail closed to `unresolvable`,
 * and opaque invocation forms (`xargs rm`, `find -exec rm`) or invocations with
 * no operand fail closed to `no-invocation`. Outside targets are reported with
 * their first offending absolute path.
 */
export function inspectDeleteScope(
    command: string,
    cwd: string,
    groupId: string,
): DeleteTargetScope {
    if (groupId === "rm") {
        return toScope(collectRmTargets(command, cwd), resolvePath(cwd));
    }
    if (groupId === "file-delete-api") {
        return toScope(collectApiTargets(command, cwd), resolvePath(cwd));
    }
    // Any other group cannot be scoped — fail closed.
    return { verdict: "unknown", targets: [] };
}

function toScope(collected: CollectedTargets, root: string): DeleteTargetScope {
    const { targets, unknown, sawInvocation, offendingOperand } = collected;
    if (unknown || targets.length === 0) {
        return {
            verdict: sawInvocation ? "unresolvable" : "no-invocation",
            offendingTarget: offendingOperand,
            targets,
        };
    }
    for (const target of targets) {
        if (!isContained(target, root)) {
            return { verdict: "outside", offendingTarget: target, targets };
        }
    }
    return { verdict: "inside", targets };
}

/**
 * Verdict for a cwd-scoped command authorization request. Extends the delete
 * verdicts with the chmod-specific reasons a mode can be rejected.
 */
export type CommandScopeVerdict =
    | "inside"
    | "outside"
    | "protected"
    | "symlink"
    | "catastrophic-mode"
    | "unresolvable"
    | "no-invocation"
    | "unknown";

/** Result of resolving a command's operands against `cwd`. */
export interface CommandScope {
    verdict: CommandScopeVerdict;
    /** First target that broke the scope, when the verdict names one. */
    offendingTarget?: string;
    /** Mode operand as written (chmod only). */
    mode?: string;
    targets: string[];
}

/**
 * Roots a chmod may never touch, even when the caller's cwd is inside them.
 * `~/.pi` is the harness-managed tree; the rest are system roots where a
 * permission change is never a project-scoped operation.
 */
export function defaultProtectedRoots(): string[] {
    return [
        resolvePath(homedir(), ".pi"),
        "/etc",
        "/usr",
        "/bin",
        "/sbin",
        "/lib",
        "/boot",
        "/var",
    ];
}

/** Octal mode: 1-4 digits, optionally `0o`-prefixed. */
const OCTAL_MODE_RE = /^(?:0o)?[0-7]{1,4}$/;

/** Symbolic mode: one or more `[ugoa]*[-+=][rwxXstugo]*` clauses. */
const SYMBOLIC_MODE_RE =
    /^[ugoa]*[-+=][rwxXstugo]*(?:,[ugoa]*[-+=][rwxXstugo]*)*$/;

/** setuid, setgid, or other-write — never a project-scoped permission change. */
function isCatastrophicOctal(mode: string): boolean {
    const value = Number.parseInt(mode.replace(/^0o/, ""), 8);
    if (!Number.isFinite(value)) return false;
    return (
        (value & 0o4000) !== 0 ||
        (value & 0o2000) !== 0 ||
        (value & 0o002) !== 0
    );
}

/** Symbolic equivalent of isCatastrophicOctal: setuid/setgid or world-write. */
function isCatastrophicSymbolic(mode: string): boolean {
    return mode.split(",").some((clause) => {
        const parsed = /^([ugoa]*)([-+=])([rwxXstugo]*)$/.exec(clause);
        if (!parsed) return false;
        const [, who, operator, perms] = parsed;
        if (operator === "-") return false;
        if (perms.includes("s")) return true;
        if (!perms.includes("w")) return false;
        // An omitted `who` means all of ugo.
        const affected = who === "" ? "a" : who;
        return affected.includes("o") || affected.includes("a");
    });
}

function isCatastrophicMode(mode: string): boolean {
    return OCTAL_MODE_RE.test(mode)
        ? isCatastrophicOctal(mode)
        : isCatastrophicSymbolic(mode);
}

interface ChmodParse {
    mode?: string;
    targets: string[];
    unknown: boolean;
}

/** Collect chmod mode + resolved absolute targets, or mark the parse unknown. */
function parseChmod(command: string, cwd: string): ChmodParse {
    const root = resolvePath(cwd);
    const targets: string[] = [];
    let mode: string | undefined;
    let unknown = false;

    for (const segment of command.split(SHELL_SEPARATORS)) {
        const tokens = tokenizeShell(segment);
        if (tokens.length === 0 || tokens[0] !== "chmod") continue;
        let flagMode = true;
        for (let i = 1; i < tokens.length; i++) {
            const tok = tokens[i];
            if (flagMode) {
                if (tok === "--") {
                    flagMode = false;
                    continue;
                }
                // Mode copied from another file: the effective bits are not
                // visible here, so fail closed instead of guessing.
                if (tok.startsWith("--reference")) {
                    unknown = true;
                    continue;
                }
                if (tok.startsWith("-") && tok.length > 1) continue;
                flagMode = false;
            }
            if (
                mode === undefined &&
                (OCTAL_MODE_RE.test(tok) || SYMBOLIC_MODE_RE.test(tok))
            ) {
                mode = tok;
                continue;
            }
            const expanded = expandTargetOperand(tok);
            if (expanded === null) {
                unknown = true;
                continue;
            }
            targets.push(resolvePath(root, expanded));
        }
    }

    return { mode, targets, unknown };
}

function isProtectedTarget(
    target: string,
    protectedRoots: readonly string[],
): boolean {
    return protectedRoots.some((protectedRoot) =>
        isContained(target, protectedRoot),
    );
}

/**
 * True when the resolved target is a symlink.
 *
 * `chmod` follows symlink arguments and changes the mode of the file they point
 * at (unlike `rm`, which unlinks the link itself), so a link is never a
 * project-scoped permission change. Only the final component is inspected: a
 * symlinked parent directory is not resolved.
 *
 * A path this process cannot stat is a path `chmod` cannot act on either, so
 * stat failures keep the lexical verdict instead of blocking the command.
 */
function isSymlinkTarget(target: string): boolean {
    try {
        return lstatSync(target).isSymbolicLink();
    } catch {
        return false;
    }
}

/**
 * Determine whether a chmod stays inside `cwd`, avoids protected roots and
 * symlink targets, and uses a non-catastrophic mode.
 *
 * Resolution is lexical: `~`/`$HOME` expand, variables and globs are
 * unresolvable (fail closed), and the final target component must not be a
 * symlink.
 */
export function inspectChmodScope(
    command: string,
    cwd: string,
    protectedRoots: readonly string[] = defaultProtectedRoots(),
): CommandScope {
    const parsed = parseChmod(command, cwd);
    if (parsed.unknown || parsed.targets.length === 0) {
        return {
            verdict: "unknown",
            mode: parsed.mode,
            targets: parsed.targets,
        };
    }

    const roots = protectedRoots.map((protectedRoot) =>
        resolvePath(protectedRoot),
    );
    for (const target of parsed.targets) {
        if (isProtectedTarget(target, roots)) {
            return {
                verdict: "protected",
                offendingTarget: target,
                mode: parsed.mode,
                targets: parsed.targets,
            };
        }
    }

    const root = resolvePath(cwd);
    for (const target of parsed.targets) {
        if (isSymlinkTarget(target)) {
            return {
                verdict: "symlink",
                offendingTarget: target,
                mode: parsed.mode,
                targets: parsed.targets,
            };
        }
    }

    for (const target of parsed.targets) {
        if (!isContained(target, root)) {
            return {
                verdict: "outside",
                offendingTarget: target,
                mode: parsed.mode,
                targets: parsed.targets,
            };
        }
    }

    if (parsed.mode !== undefined && isCatastrophicMode(parsed.mode)) {
        return {
            verdict: "catastrophic-mode",
            mode: parsed.mode,
            targets: parsed.targets,
        };
    }

    return { verdict: "inside", mode: parsed.mode, targets: parsed.targets };
}

/**
 * Scope verdict for any cwd-scoped danger group. Unsupported groups fail
 * closed to `unknown`.
 */
export function inspectCommandScope(
    command: string,
    cwd: string,
    groupId: string,
    protectedRoots: readonly string[] = defaultProtectedRoots(),
): CommandScope {
    if (groupId === "chmod") {
        return inspectChmodScope(command, cwd, protectedRoots);
    }
    return inspectDeleteScope(command, cwd, groupId);
}

/**
 * Canonical list of shell commands (by first word) that have a native Pi tool
 * equivalent and can therefore be allow-listed to bypass native-tool
 * redirection. Single source of truth for `AllowedShellCommand` and for
 * validating `allowedShellCommands` in settings.json.
 */
export const ALLOWED_SHELL_COMMANDS = [
    "grep",
    "rg",
    "find",
    "fd",
    "ls",
    "ack",
    "ag",
] as const;

/** Shell command name accepted in `allowedShellCommands`. */
export type AllowedShellCommand = (typeof ALLOWED_SHELL_COMMANDS)[number];

/** Membership check for `allowedShellCommands` values. */
export function isAllowedShellCommand(
    value: unknown,
): value is AllowedShellCommand {
    return (
        typeof value === "string" &&
        ALLOWED_SHELL_COMMANDS.some((command) => command === value)
    );
}

/**
 * Shell commands that have native Pi tool equivalents, mapped to their
 * native tool names. When the LLM tries to use these via safe_bash, we
 * redirect it to the better native implementation.
 *
 * Keyed by `AllowedShellCommand`, so the compiler rejects an allow-listed
 * command that has no native target.
 */
const SHELL_TO_NATIVE_MAP: Record<AllowedShellCommand, string> = {
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
    const native = isAllowedShellCommand(first)
        ? SHELL_TO_NATIVE_MAP[first]
        : undefined;
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
 * `allowList` (optional) bypasses redirection for commands listed by first
 * word, from the closed `AllowedShellCommand` set, regardless of profile.
 * Useful when the user explicitly wants a shell command (e.g. `grep`, `find`)
 * to run through safe_bash instead of the native tool. `isDangerous()` still
 * runs upstream — only the redirect is bypassed.
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
