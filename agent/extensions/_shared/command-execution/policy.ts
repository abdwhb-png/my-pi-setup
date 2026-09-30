import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
    inspectGroupScope,
    isScopableGroup,
    type CommandScope,
    type CommandScopeVerdict,
    type DangerMatch,
} from "./guard.ts";

export type CommandGuardPolicy = "ask" | "deny" | "allow";

/**
 * Policies that decide from resolved filesystem targets rather than from the
 * matched pattern alone. `cwd-only` authorizes `[ctx.cwd]`; `sandbox-only`
 * authorizes the sandbox write grants, and only while the shell is in sandbox
 * mode.
 */
export type ScopeGuardPolicy = "cwd-only" | "sandbox-only";

/** Everything a group can be configured with in `safeBash.guardPolicy`. */
export type GuardPolicyValue =
    | CommandGuardPolicy
    | ScopeGuardPolicy
    | { anyOf: ScopeGuardPolicy[] };

/** Sandbox facts the `sandbox-only` policy authorizes against. */
export interface SandboxScope {
    mode: "sandbox" | "host";
    writableRoots: readonly string[];
}

/** Membership check for the simple string policies. */
export function isCommandGuardPolicy(
    value: unknown,
): value is CommandGuardPolicy {
    return value === "ask" || value === "deny" || value === "allow";
}

/**
 * Membership check for a scope policy. Single source of truth for the accepted
 * set, so a consumer's config loader cannot silently drop a policy the shared
 * type allows.
 */
export function isScopeGuardPolicy(value: unknown): value is ScopeGuardPolicy {
    return value === "cwd-only" || value === "sandbox-only";
}

/**
 * Membership check for any accepted `guardPolicy` value, including the
 * `{ anyOf: [...] }` object form.
 */
export function isGuardPolicyValue(value: unknown): value is GuardPolicyValue {
    if (isCommandGuardPolicy(value) || isScopeGuardPolicy(value)) return true;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const anyOf = (value as { anyOf?: unknown }).anyOf;
    if (!Array.isArray(anyOf) || anyOf.length === 0) return false;
    if (!anyOf.every((member) => isScopeGuardPolicy(member))) return false;
    // D3: duplicate-free. A repeated member adds no permission and would only
    // make the denial reason print the same branch twice.
    return new Set(anyOf).size === anyOf.length;
}

/**
 * The scope members a policy value asks to be evaluated, or null when the
 * policy is not scope-decided. A single scope policy is normalized to a
 * one-member list so both forms share one evaluation path.
 */
export function scopeMembersOf(
    policy: GuardPolicyValue,
): ScopeGuardPolicy[] | null {
    if (isScopeGuardPolicy(policy)) return [policy];
    if (typeof policy === "object" && policy !== null && "anyOf" in policy) {
        return policy.anyOf;
    }
    return null;
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
    Record<string, GuardPolicyValue>
> = Object.freeze({ chmod: "cwd-only" });

/** Inputs for one guard evaluation. */
export interface GuardEvaluationOptions {
    toolName: string;
    /**
     * Current sandbox facts, read at decision time rather than at module load.
     * Absent or undefined means the sandbox boundary is unknown, and every
     * `sandbox-only` member then fails closed.
     */
    resolveSandboxScope?: () => SandboxScope | undefined;
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
    policies: Readonly<Record<string, GuardPolicyValue>>,
    groupId: string,
): GuardPolicyValue {
    return policies[groupId] ?? "deny";
}

export interface GuardAuthorization {
    allowed: boolean;
    reason?: string;
    /**
     * Scope evidence, attached when a scope policy denied the command, so
     * telemetry can record what the scope decided and which targets it resolved.
     */
    scopeVerdict?: CommandScopeVerdict;
    scopeTargets?: readonly string[];
    /**
     * Which scope member decided. Recorded so audit evidence distinguishes a
     * `cwd-only` denial from a `sandbox-only` denial of the same command.
     */
    scopeMember?: ScopeGuardPolicy;
}

export interface GuardMatchesAuthorization extends GuardAuthorization {
    match?: DangerMatch;
    /** Effective policy for the denying match, recorded as guard evidence. */
    policy?: GuardPolicyValue;
}

export async function authorizeDangerousMatches(
    matches: readonly DangerMatch[],
    policies: Readonly<Record<string, GuardPolicyValue>>,
    ctx: ExtensionContext,
    approvals: GuardSessionApprovals,
    options: GuardEvaluationOptions,
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
    policy: GuardPolicyValue,
    ctx: ExtensionContext,
    approvals: GuardSessionApprovals,
    options: GuardEvaluationOptions,
): Promise<GuardAuthorization> {
    if (policy === "allow") return { allowed: true };
    if (policy === "deny") return { allowed: false, reason: match.message };
    const members = scopeMembersOf(policy);
    if (members) {
        return evaluateScopePolicies(match, members, ctx, options);
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
 * Evaluate every scope member in order and allow on the first that admits the
 * command. When no member admits it, the denial names what each one decided, so
 * an `anyOf` failure explains both branches instead of reporting one.
 */
function evaluateScopePolicies(
    match: DangerMatch,
    members: readonly ScopeGuardPolicy[],
    ctx: ExtensionContext,
    options: GuardEvaluationOptions,
): GuardAuthorization {
    const prefix = `Command blocked by ${options.toolName}: ${match.groupId}`;

    // A scope permission has nothing to decide for a group with no path
    // operand, so it cannot authorize. Report it as the config error it is
    // rather than as a silent denial.
    if (!isScopableGroup(match.groupId)) {
        return {
            allowed: false,
            reason: `${prefix} the ${match.groupId} group has no path targets, so a scope permission (${members.join(", ")}) cannot apply. Use allow, ask, or deny for this group.`,
        };
    }

    const evidence: string[] = [];
    let lastScope:
        | { member: ScopeGuardPolicy; scope: CommandScope }
        | undefined;
    // A single-member policy already names its member in the policy value, so
    // `scopeMember` is only recorded when it disambiguates an `anyOf`.
    const disambiguating = members.length > 1;
    for (const member of members) {
        const sandbox =
            member === "sandbox-only"
                ? options.resolveSandboxScope?.()
                : undefined;
        if (
            member === "sandbox-only" &&
            (!sandbox || sandbox.mode !== "sandbox")
        ) {
            evidence.push(
                sandbox
                    ? "sandbox-only → not in sandbox mode"
                    : "sandbox-only → sandbox mode unavailable",
            );
            continue;
        }
        const roots =
            member === "cwd-only" ? [ctx.cwd] : (sandbox?.writableRoots ?? []);
        const scope = inspectGroupScope(
            match.normalizedCommand,
            ctx.cwd,
            match.groupId,
            roots,
        );
        if (scope.verdict === "inside") {
            return disambiguating
                ? { allowed: true, scopeMember: member }
                : { allowed: true };
        }
        evidence.push(
            describeScopeEvidence(member, scope, match, rootLabelFor(member)),
        );
        lastScope ??= { member, scope };
    }

    return {
        allowed: false,
        reason: `${prefix} ${evidence.join("; ")}`,
        ...(lastScope
            ? {
                  scopeVerdict: lastScope.scope.verdict,
                  scopeTargets: lastScope.scope.targets,
                  ...(disambiguating ? { scopeMember: lastScope.member } : {}),
              }
            : {}),
    };
}

/**
 * Compact `member → reason` clause for one member of a multi-member scope
 * policy, so an `anyOf` denial explains every branch that was tried.
 */
function describeScopeEvidence(
    member: ScopeGuardPolicy,
    scope: CommandScope,
    match: DangerMatch,
    rootLabel: string,
): string {
    return `${member} → ${scopeDenialClause(scope, match, rootLabel)}`;
}

/** Name the authorized root set a scope policy decides against. */
function rootLabelFor(member: ScopeGuardPolicy): string {
    return member === "cwd-only" ? "working dir" : "sandbox write grants";
}

/**
 * The reason clause alone, without the tool/group prefix, so the same wording
 * serves both a single-member denial and a per-member clause in an `anyOf`.
 */
function scopeDenialClause(
    scope: CommandScope,
    match: DangerMatch,
    rootLabel: string,
): string {
    const offending = scope.offendingTarget;
    switch (scope.verdict) {
        case "inside":
            // Unreachable: the caller returns before denying an inside scope.
            throw new Error(
                "scopeDenialClause called for an allowed scope verdict",
            );
        case "catastrophic-mode":
            return `mode ${scope.mode} is not permitted`;
        case "protected":
            return offending
                ? `target is protected: ${offending}`
                : match.message;
        case "symlink":
            return offending
                ? `target path follows a symlink: ${offending}`
                : match.message;
        case "outside":
            return offending
                ? `target outside ${rootLabel}: ${offending}`
                : `target outside ${rootLabel}`;
        case "unresolvable":
            return offending
                ? `operand could not be resolved statically: ${offending}`
                : `invocation has no resolvable target: ${match.normalizedCommand}`;
        case "no-invocation":
            return `matched a form with no resolvable invocation (indirect or quoted): ${match.normalizedCommand}`;
        case "unknown":
            return `target or mode could not be resolved statically (variable, glob, or --reference): ${match.normalizedCommand}`;
        default: {
            // Compile-time exhaustiveness: a new verdict breaks the build here
            // instead of silently reusing another reason.
            const unhandled: never = scope.verdict;
            return `unhandled scope verdict ${String(unhandled)}`;
        }
    }
}
