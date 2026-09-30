import { DANGER_GROUP_IDS } from "../../_shared/command-execution/guard.ts";
import type { SafeBashConfig } from "./config.ts";

export interface SafeBashDescriptionInput {
    config: Pick<
        SafeBashConfig,
        "mode" | "guardPolicy" | "guardPolicyNotes" | "allowedShellCommands"
    >;
    enforceNativeTools: boolean;
}

/**
 * Summarize current command checks for the ephemeral shell context and status command.
 * Keep tool availability distinct from sandbox/host execution mode.
 */
export function buildSafeBashContext(input: SafeBashDescriptionInput): string {
    const { config, enforceNativeTools } = input;

    const allow: string[] = [];
    const ask: string[] = [];
    const explicitDeny: string[] = [];
    const cwdOnly: string[] = [];
    const sandboxOnly: string[] = [];
    const anyOfScopes: string[] = [];

    for (const [groupId, policy] of Object.entries(config.guardPolicy)) {
        if (policy === "allow") allow.push(groupId);
        else if (policy === "ask") ask.push(groupId);
        else if (policy === "deny") explicitDeny.push(groupId);
        else if (policy === "cwd-only") cwdOnly.push(groupId);
        else if (policy === "sandbox-only") sandboxOnly.push(groupId);
        else anyOfScopes.push(`${groupId}:${policy.anyOf.join("|")}`);
    }
    for (const list of [
        allow,
        ask,
        explicitDeny,
        cwdOnly,
        sandboxOnly,
        anyOfScopes,
    ]) {
        list.sort((a, b) => a.localeCompare(b));
    }

    const configuredCount =
        allow.length +
        ask.length +
        explicitDeny.length +
        cwdOnly.length +
        sandboxOnly.length +
        anyOfScopes.length;
    const defaultDenyCount = DANGER_GROUP_IDS.length - configuredCount;

    const guardParts: string[] = [];
    if (allow.length > 0) guardParts.push(`allow=[${allow.join(",")}]`);
    if (ask.length > 0) guardParts.push(`ask=[${ask.join(",")}]`);
    if (explicitDeny.length > 0)
        guardParts.push(`deny=[${explicitDeny.join(",")}]`);
    if (cwdOnly.length > 0) guardParts.push(`cwd-only=[${cwdOnly.join(",")}]`);
    if (sandboxOnly.length > 0)
        guardParts.push(`sandbox-only=[${sandboxOnly.join(",")}]`);
    if (anyOfScopes.length > 0)
        guardParts.push(`scope-anyOf=[${anyOfScopes.join(",")}]`);
    if (defaultDenyCount > 0)
        guardParts.push(`deny(default)=${defaultDenyCount}`);
    else if (guardParts.length === 0) guardParts.push("deny(default)=0");

    const guardSummary = guardParts.join(" ");

    const modePart = `Tool availability=${config.mode}`;

    const bypass =
        config.allowedShellCommands.length > 0
            ? `bypass=[${config.allowedShellCommands.join(",")}]`
            : "bypass=none";

    const nativePart = enforceNativeTools
        ? "native-redirect: grep/find/ls→native"
        : "native-redirect: relaxed";

    // Guidance for agent to avoid wasted attempts
    const guidance =
        "Denied groups stay blocked; ask groups require approval unless already approved for the session.";

    // Rejected settings ride the same string the prompt block uses, so a
    // policy that was dropped shows up in `/safe-bash status` instead of
    // silently denying every command for that group.
    const notes = config.guardPolicyNotes ?? [];
    const notesPart =
        notes.length > 0 ? ` Ignored guardPolicy: ${notes.join(" | ")}.` : "";

    return `safe_bash: ${modePart}. Guard: ${guardSummary}. AllowedShell (native-redirect exceptions): ${bypass}. ${nativePart}. ${guidance}${notesPart}`;
}
