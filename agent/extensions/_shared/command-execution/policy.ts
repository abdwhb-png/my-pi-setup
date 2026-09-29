import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type {
    CommandScope,
    CommandScopeVerdict,
    DangerMatch,
} from "./guard.ts";
import { inspectCommandScope } from "./guard.ts";

export type CommandGuardPolicy = "ask" | "deny" | "allow" | "cwd-only";

/**
 * Membership check for a `guardPolicy` value. Single source of truth for the
 * accepted set, so a consumer's config loader cannot silently drop a policy the
 * shared type allows (for example the scope-decided `cwd-only`).
 */
export function isCommandGuardPolicy(
    value: unknown,
): value is CommandGuardPolicy {
    return (
        value === "ask" ||
        value === "deny" ||
        value === "allow" ||
        value === "cwd-only"
    );
}

/**
 * Danger groups whose verdict comes from resolving operands against `ctx.cwd`
 * instead of the matched pattern alone.
 *
 * Every consumer that runs commands through this guard must start from this
 * record: their group patterns match unconditionally, so a consumer that
 * defaults to `{}` would blanket-deny the group instead of scoping it.
 */
export const DEFAULT_DANGER_GROUP_POLICY: Readonly<
    Record<string, CommandGuardPolicy>
> = Object.freeze({ chmod: "cwd-only" });

export interface GuardPromptOptions {
    toolName: string;
}

export class GuardSessionApprovals {
    private readonly approved = new Set<string>();

    private key(match: DangerMatch): string {
        return `${match.groupId}::${match.normalizedCommand}`;
    }

    has(match: DangerMatch): boolean {
        return this.approved.has(this.key(match));
    }

    add(match: DangerMatch): void {
        this.approved.add(this.key(match));
    }

    clear(): void {
        this.approved.clear();
    }
}

export function resolveGuardPolicy(
    policies: Readonly<Record<string, CommandGuardPolicy>>,
    groupId: string,
): CommandGuardPolicy {
    return policies[groupId] ?? "deny";
}

export interface GuardAuthorization {
    allowed: boolean;
    reason?: string;
    /**
     * Scope evidence, attached when a `cwd-only` scope denied the command, so
     * telemetry can record what the scope decided and which targets it resolved.
     */
    scopeVerdict?: CommandScopeVerdict;
    scopeTargets?: readonly string[];
}

export interface GuardMatchesAuthorization extends GuardAuthorization {
    match?: DangerMatch;
    /** Effective policy for the denying match, recorded as guard evidence. */
    policy?: CommandGuardPolicy;
}

export async function authorizeDangerousMatches(
    matches: readonly DangerMatch[],
    policies: Readonly<Record<string, CommandGuardPolicy>>,
    ctx: ExtensionContext,
    approvals: GuardSessionApprovals,
    options: GuardPromptOptions,
): Promise<GuardMatchesAuthorization> {
    for (const match of matches) {
        // oxlint-disable-next-line no-await-in-loop -- guard prompts must run sequentially and stop on first denial
        const authorization = await authorizeDangerousCommand(
            match,
            resolveGuardPolicy(policies, match.groupId),
            ctx,
            approvals,
            options,
        );
        if (!authorization.allowed) {
            return {
                ...authorization,
                match,
                policy: resolveGuardPolicy(policies, match.groupId),
            };
        }
    }
    return { allowed: true, match: matches[0] };
}

export async function authorizeDangerousCommand(
    match: DangerMatch,
    policy: CommandGuardPolicy,
    ctx: ExtensionContext,
    approvals: GuardSessionApprovals,
    options: GuardPromptOptions,
): Promise<GuardAuthorization> {
    if (policy === "allow") return { allowed: true };
    if (policy === "deny") return { allowed: false, reason: match.message };
    if (policy === "cwd-only") {
        const scope = inspectCommandScope(
            match.normalizedCommand,
            ctx.cwd,
            match.groupId,
        );
        if (scope.verdict === "inside") return { allowed: true };
        return {
            allowed: false,
            reason: describeScopeDenial(scope, match, options),
            scopeVerdict: scope.verdict,
            scopeTargets: scope.targets,
        };
    }
    if (approvals.has(match)) return { allowed: true };
    if (!ctx.hasUI) {
        return {
            allowed: false,
            reason: `Permission required for ${options.toolName} danger group ${match.groupId}: ${match.normalizedCommand}`,
        };
    }

    const title = `${options.toolName} danger group: ${match.groupId}`;
    const choices = ["Yes", "Yes for this session", "No", "No, provide reason"];
    const decision = await ctx.ui.select(
        `${title}\nAllow ${options.toolName} to run: ${match.normalizedCommand}?`,
        choices,
    );

    if (decision === "Yes") return { allowed: true };
    if (decision === "Yes for this session") {
        approvals.add(match);
        return { allowed: true };
    }
    if (decision === "No, provide reason") {
        const reason = await ctx.ui.input(
            `${title}\nShare why this request was denied (optional).`,
            "Reason shown back to the agent",
        );
        return {
            allowed: false,
            reason:
                typeof reason === "string" && reason.trim()
                    ? reason.trim()
                    : "Denied by user",
        };
    }

    return { allowed: false, reason: "Denied by user" };
}

/**
 * Reason for a `cwd-only` denial. Wording lives here, apart from the policy
 * decision, so every denial path reports the same evidence.
 */
function describeScopeDenial(
    scope: CommandScope,
    match: DangerMatch,
    options: GuardPromptOptions,
): string {
    const prefix = `Command blocked by ${options.toolName}: ${match.groupId}`;
    const offending = scope.offendingTarget;
    switch (scope.verdict) {
        case "inside":
            // Unreachable: the caller returns before denying an inside scope.
            throw new Error(
                "describeScopeDenial called for an allowed scope verdict",
            );
        case "catastrophic-mode":
            return `${prefix} mode ${scope.mode} is not permitted`;
        case "protected":
            return offending
                ? `${prefix} target is protected: ${offending}`
                : match.message;
        case "symlink":
            return offending
                ? `${prefix} target is a symlink it would follow: ${offending}`
                : match.message;
        case "outside":
            return offending
                ? `${prefix} target outside working dir: ${offending}`
                : match.message;
        case "unresolvable":
            return offending
                ? `${prefix} operand could not be resolved statically: ${offending}`
                : `${prefix} invocation has no resolvable target: ${match.normalizedCommand}`;
        case "no-invocation":
            return `${prefix} matched a form with no resolvable invocation (indirect or quoted): ${match.normalizedCommand}`;
        case "unknown":
            return `${prefix} target or mode could not be resolved statically (variable, glob, or --reference): ${match.normalizedCommand}`;
        default: {
            // Compile-time exhaustiveness: a new verdict breaks the build here
            // instead of silently reusing another reason.
            const unhandled: never = scope.verdict;
            return `${prefix} unhandled scope verdict ${String(unhandled)}`;
        }
    }
}
