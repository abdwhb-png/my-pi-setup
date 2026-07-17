import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type {
    ExtensionAPI,
    SlashCommandInfo,
} from '@earendil-works/pi-coding-agent';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { isThinkingLevel } from '../_shared/thinking.ts';

/**
 * Detect if the input starts with a slash command.
 * Returns [commandName, rest] or null.
 */
function parseSlashCommand(
    text: string,
): { name: string; rest: string } | null {
    const match = text.match(/^\/(\S+)(?:\s+(.*))?$/s);
    if (!match) return null;
    return { name: match[1], rest: match[2] ?? '' };
}

/**
 * Find a prompt command by name from the registered commands list.
 */
function findPromptCommand(
    commands: SlashCommandInfo[],
    name: string,
): SlashCommandInfo | undefined {
    return commands.find((cmd) => cmd.source === 'prompt' && cmd.name === name);
}

/**
 * Read a prompt file, parse frontmatter, and apply the `thinking` level if present.
 */
function applyPromptThinking(
    pi: ExtensionAPI,
    command: SlashCommandInfo,
): void {
    try {
        const raw = readFileSync(command.sourceInfo.path, 'utf-8');
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
    pi.on('input', async (event) => {
        const parsed = parseSlashCommand(event.text);
        if (!parsed) return { action: 'continue' as const };

        const commands = pi.getCommands();
        const promptCommand = findPromptCommand(commands, parsed.name);
        if (!promptCommand) return { action: 'continue' as const };

        applyPromptThinking(pi, promptCommand);
        return { action: 'continue' as const };
    });
}
