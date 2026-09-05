import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { DangerMatch } from "./guard.ts";

export type CommandGuardPolicy = "ask" | "deny" | "allow";

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
}

export interface GuardMatchesAuthorization extends GuardAuthorization {
    match?: DangerMatch;
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
        if (!authorization.allowed) return { ...authorization, match };
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
