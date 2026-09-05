/**
 * Generic, project-configurable command rewrite engine.
 *
 * Project declares regex match → rewrite rules under `.pi/settings.json`
 * key `bashRewrites`. Pi applies the first matching rule to the command
 * before spawn, after safety guards have already run on the original.
 *
 * No sail-specific knowledge. The project owns runtime command policy.
 */
import { loadExtensionConfig } from "../config-loader";

export type CommandRewriteProfile =
    | "bash"
    | "safe_bash"
    | "think_execute"
    | "think_batch_execute";

export interface BashRewriteRule {
    /** Regex source, matched against the full joined command string. */
    match: string;
    /** Replacement with $1, $2 capture groups (standard String.replace). */
    rewrite: string;
    /** Which tools apply. Default ['bash', 'safe_bash']. user_bash never included. */
    tools?: CommandRewriteProfile[];
    /** Human label for /bash-rewrites listing. */
    description?: string;
    /** Machine-readable tag surfaced in details.rewriteApplied. */
    reason?: string;
}

export interface BashRewritesConfig {
    rules: BashRewriteRule[];
}

export interface AppliedRewrite {
    from: string;
    to: string;
    reason?: string;
    description?: string;
}

const VALID_TOOLS: ReadonlySet<string> = new Set([
    "bash",
    "safe_bash",
    "think_execute",
    "think_batch_execute",
]);

function isValidRegex(source: string): boolean {
    try {
        new RegExp(source);
        return true;
    } catch {
        return false;
    }
}

function normalizeRule(
    raw: unknown,
    validTools: ReadonlySet<string> = VALID_TOOLS,
): BashRewriteRule | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.match !== "string" || typeof r.rewrite !== "string")
        return null;
    if (!isValidRegex(r.match)) {
        console.warn(
            `[bash-rewrites] Dropping rule with invalid regex: ${r.match}`,
        );
        return null;
    }
    const rule: BashRewriteRule = {
        match: r.match,
        rewrite: r.rewrite,
    };
    if (typeof r.reason === "string") rule.reason = r.reason;
    if (typeof r.description === "string") rule.description = r.description;
    if (Array.isArray(r.tools)) {
        const tools = r.tools.filter(
            (t): t is CommandRewriteProfile =>
                typeof t === "string" && validTools.has(t),
        );
        if (tools.length > 0) rule.tools = tools;
    }
    return rule;
}

export function normalizeCommandRewriteRules(
    raw: unknown,
    validTools: ReadonlySet<string> = VALID_TOOLS,
): BashRewriteRule[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((rule) => normalizeRule(rule, validTools))
        .filter((rule): rule is BashRewriteRule => rule !== null);
}

function normalize(raw: unknown): Partial<BashRewritesConfig> {
    // The settings key 'bashRewrites' holds the rules array directly.
    if (!Array.isArray(raw)) return {};
    const rules = normalizeCommandRewriteRules(raw);
    return rules.length > 0 ? { rules } : {};
}

function mergeConfigs(
    base: BashRewritesConfig,
    overlay: Partial<BashRewritesConfig>,
): BashRewritesConfig {
    return {
        rules: [...base.rules, ...(overlay.rules ?? [])],
    };
}

/**
 * Load bash rewrite rules from settings.json (global + project).
 * Project rules are concatenated after global rules (first-match-wins ordering).
 */
export function loadBashRewrites(cwd: string): BashRewritesConfig {
    return loadExtensionConfig<BashRewritesConfig>(cwd, {
        defaults: { rules: [] },
        normalize,
        merge: mergeConfigs,
        sources: [{ settingsKey: "bashRewrites" }],
    });
}

export interface RewriteResult {
    /** The command to execute (rewritten or original). */
    command: string;
    /** Details of the applied rewrite, or null if no rule matched. */
    applied: AppliedRewrite | null;
}

/**
 * Apply the first matching rewrite rule to a command.
 *
 * - Rules are checked in array order (global first, then project).
 * - A rule is skipped if its `tools` is defined and excludes `toolName`.
 * - If the rewrite produces a string identical to the input, `applied` is null (no-op).
 */
export function applyFirstRewrite(
    command: string,
    toolName: CommandRewriteProfile,
    rules: BashRewriteRule[],
): RewriteResult {
    for (const rule of rules) {
        if (rule.tools && !rule.tools.includes(toolName)) continue;
        const re = new RegExp(rule.match);
        if (!re.test(command)) continue;
        const rewritten = command.replace(re, rule.rewrite);
        if (rewritten === command) return { command, applied: null };
        return {
            command: rewritten,
            applied: {
                from: command,
                to: rewritten,
                ...(rule.reason ? { reason: rule.reason } : {}),
                ...(rule.description ? { description: rule.description } : {}),
            },
        };
    }
    return { command, applied: null };
}
