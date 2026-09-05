import { DANGER_GROUP_IDS } from "../../_shared/command-execution/guard.ts";
import type { SafeBashConfig } from "./config.ts";

export const SAFE_BASH_BASE_DESCRIPTION =
    "Execute a bash command through shared sandbox execution.";

export interface SafeBashDescriptionInput {
    config: Pick<
        SafeBashConfig,
        "mode" | "guardPolicy" | "allowedShellCommands"
    >;
    enforceNativeTools: boolean;
}

/**
 * Build compacted tool description that encodes current safe-bash state.
 * Pure function, no PI dependencies. Keep output compact (< ~500 chars)
 * so it fits in tool definition without bloating context.
 */
export function buildSafeBashDescription(
    input: SafeBashDescriptionInput,
): string {
    const { config, enforceNativeTools } = input;

    const allow: string[] = [];
    const ask: string[] = [];
    const explicitDeny: string[] = [];

    for (const [groupId, policy] of Object.entries(config.guardPolicy)) {
        if (policy === "allow") allow.push(groupId);
        else if (policy === "ask") ask.push(groupId);
        else if (policy === "deny") explicitDeny.push(groupId);
    }
    allow.sort((a, b) => a.localeCompare(b));
    ask.sort((a, b) => a.localeCompare(b));
    explicitDeny.sort((a, b) => a.localeCompare(b));

    const defaultDenyCount =
        DANGER_GROUP_IDS.length -
        allow.length -
        ask.length -
        explicitDeny.length;

    const guardParts: string[] = [];
    if (allow.length > 0) guardParts.push(`allow=[${allow.join(",")}]`);
    if (ask.length > 0) guardParts.push(`ask=[${ask.join(",")}]`);
    if (explicitDeny.length > 0)
        guardParts.push(`deny=[${explicitDeny.join(",")}]`);
    if (defaultDenyCount > 0)
        guardParts.push(`deny(default)=${defaultDenyCount}`);
    else if (guardParts.length === 0) guardParts.push("deny(default)=0");

    const guardSummary = guardParts.join(" ");

    const modePart = `Mode=${config.mode}`;

    const bypass =
        config.allowedShellCommands.length > 0
            ? `bypass=[${config.allowedShellCommands.join(",")}]`
            : "bypass=none";

    const nativePart = enforceNativeTools
        ? "native-redirect: grep/find/ls→native"
        : "native-redirect: relaxed";

    // Guidance for agent to avoid wasted attempts
    const guidance =
        "Denied groups are blocked; ask groups require user confirm; use write/edit not rm.";

    return `${SAFE_BASH_BASE_DESCRIPTION} ${modePart}. Guard: ${guardSummary}. AllowedShell: ${bypass}. ${nativePart}. ${guidance}`;
}

export function buildSafeBashPromptSnippet(
    input: SafeBashDescriptionInput,
): string {
    // One-liner for Available tools section, even more compact
    const allow: string[] = [];
    const ask: string[] = [];
    for (const [k, v] of Object.entries(input.config.guardPolicy)) {
        if (v === "allow") allow.push(k);
        else if (v === "ask") ask.push(k);
    }
    allow.sort((a, b) => a.localeCompare(b));
    ask.sort((a, b) => a.localeCompare(b));
    const bypass = input.config.allowedShellCommands.join(",") || "none";
    const parts: string[] = [`mode=${input.config.mode}`];
    if (allow.length > 0) parts.push(`allow:${allow.join(",")}`);
    if (ask.length > 0) parts.push(`ask:${ask.join(",")}`);
    parts.push(`bypass:${bypass}`);
    parts.push(input.enforceNativeTools ? "native=enforced" : "native=relaxed");
    return `🔒bash sandbox — ${parts.join(" ")}`;
}
