import { readFileSync } from "node:fs";
import type {
    ExtensionAPI,
    SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { findInvokedSlashCommand } from "../_shared/slash-command-source.ts";
import { isThinkingLevel } from "../_shared/thinking.ts";

/**
 * Read a prompt file, parse frontmatter, and apply the `thinking` level if present.
 */
function applyPromptThinking(
    pi: ExtensionAPI,
    command: SlashCommandInfo,
): void {
    try {
        const raw = readFileSync(command.sourceInfo.path, "utf-8");
        // oxlint-disable-next-line typescript/no-restricted-types -- YAML frontmatter is untrusted until isThinkingLevel validates it.
        const { frontmatter } = parseFrontmatter<{ thinking?: unknown }>(raw);
        if (
            frontmatter.thinking !== undefined &&
            isThinkingLevel(frontmatter.thinking)
        ) {
            pi.setThinkingLevel(frontmatter.thinking);
        }
    } catch {
        // Prompt file missing or unreadable — silently ignore.
    }
}

/**
 * Register an input event handler that reads prompt file frontmatter
 * and auto-sets the thinking level when a prompt command is invoked.
 *
 * Import and call from `pi-overrides/index.ts`:
 *   registerPromptThinking(pi);
 */
export function registerPromptThinking(pi: ExtensionAPI): void {
    pi.on("input", (event) => {
        const promptCommand = findInvokedSlashCommand(
            pi.getCommands(),
            event.text,
            ["prompt"],
        );
        if (!promptCommand) return { action: "continue" as const };

        applyPromptThinking(pi, promptCommand);
        return { action: "continue" as const };
    });
}
