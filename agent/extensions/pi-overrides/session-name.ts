const LEADING_SKILL_BLOCK = /^<skill name="([^"]+)"[^>]*>[\s\S]*?<\/skill>\s*/;

export function compactPromptSessionName(
    input: string,
    promptNames: ReadonlySet<string>,
): string | undefined {
    if (!input.startsWith("/")) return undefined;
    if (input.length < 2) return undefined;

    const firstSpace = input.indexOf(" ", 1);
    const commandName =
        firstSpace === -1 ? input.slice(1) : input.slice(1, firstSpace);

    if (commandName.length === 0) return undefined;
    if (!promptNames.has(commandName)) return undefined;

    const remainder = firstSpace === -1 ? "" : input.slice(firstSpace);
    if (remainder.trim() === "") {
        return `/prompt:${commandName}`;
    }
    return `/prompt:${commandName}${remainder}`;
}

export function compactSkillSessionName(text: string): string | undefined {
    const names: string[] = [];
    let remaining = text;
    let match = LEADING_SKILL_BLOCK.exec(remaining);

    while (match) {
        names.push(match[1]);
        remaining = remaining.slice(match[0].length);
        match = LEADING_SKILL_BLOCK.exec(remaining);
    }

    if (names.length === 0) return undefined;

    const command = `/skill:${names.join(",")}`;
    return remaining ? `${command} ${remaining}` : command;
}
