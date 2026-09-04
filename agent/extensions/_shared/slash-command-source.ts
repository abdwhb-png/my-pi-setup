import type {
    SlashCommandInfo,
    SlashCommandSource,
} from "@earendil-works/pi-coding-agent";

export interface SlashCommandInvocation {
    name: string;
    args: string;
}

export function parseSlashCommandInvocation(
    text: string,
): SlashCommandInvocation | null {
    const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
    if (!match) return null;

    return {
        name: match[1],
        args: match[2] ?? "",
    };
}

export function findInvokedSlashCommand(
    commands: readonly SlashCommandInfo[],
    text: string,
    sources?: readonly SlashCommandSource[],
): SlashCommandInfo | undefined {
    const invocation = parseSlashCommandInvocation(text);
    if (!invocation) return undefined;

    return commands.find(
        (command) =>
            command.name === invocation.name &&
            (!sources || sources.includes(command.source)),
    );
}
