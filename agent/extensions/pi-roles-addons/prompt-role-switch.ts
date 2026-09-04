import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    readFrontmatter,
    writeRoleSwitchRequest,
} from "../_shared/pi-roles.ts";
import { findInvokedSlashCommand } from "../_shared/slash-command-source.ts";

/**
 * Switch roles from the authoritative prompt command registered by Pi.
 *
 * Pi owns prompt discovery and collision precedence. Reading `getCommands()`
 * avoids maintaining a second, divergent prompt-path resolver here.
 */
export default function promptRoleSwitch(pi: ExtensionAPI): void {
    pi.on("input", (event) => {
        const command = findInvokedSlashCommand(pi.getCommands(), event.text, [
            "prompt",
        ]);
        if (!command?.sourceInfo) return;

        const frontmatter = readFrontmatter(command.sourceInfo.path);
        const role = frontmatter?.role;
        if (typeof role !== "string" || !role.trim()) return;

        writeRoleSwitchRequest(pi, {
            targetRole: role.trim(),
            reason: `prompt:${command.name}`,
        });
    });
}
