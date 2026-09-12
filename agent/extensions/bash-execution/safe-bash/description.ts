import { DANGER_GROUP_IDS } from "../../_shared/command-execution/guard.ts";
import type { SafeBashConfig } from "./config.ts";

export interface SafeBashDescriptionInput {
    config: Pick<
        SafeBashConfig,
        "mode" | "guardPolicy" | "allowedShellCommands"
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

    for (const [groupId, policy] of Object.entries(config.guardPolicy)) {
        if (policy === "allow") allow.push(groupId);
        else if (policy === "ask") ask.push(groupId);
        else if (policy === "deny") explicitDeny.push(groupId);
        else if (policy === "cwd-only") cwdOnly.push(groupId);
    }
    allow.sort((a, b) => a.localeCompare(b));
    ask.sort((a, b) => a.localeCompare(b));
    explicitDeny.sort((a, b) => a.localeCompare(b));
    cwdOnly.sort((a, b) => a.localeCompare(b));

    const defaultDenyCount =
        DANGER_GROUP_IDS.length -
        allow.length -
        ask.length -
        explicitDeny.length -
        cwdOnly.length;

    const guardParts: string[] = [];
    if (allow.length > 0) guardParts.push(`allow=[${allow.join(",")}]`);
    if (ask.length > 0) guardParts.push(`ask=[${ask.join(",")}]`);
    if (explicitDeny.length > 0)
        guardParts.push(`deny=[${explicitDeny.join(",")}]`);
    if (cwdOnly.length > 0) guardParts.push(`cwd-only=[${cwdOnly.join(",")}]`);
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

    return `safe_bash: ${modePart}. Guard: ${guardSummary}. AllowedShell (native-redirect exceptions): ${bypass}. ${nativePart}. ${guidance}`;
}
