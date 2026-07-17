const LEADING_SKILL_BLOCK = /^<skill name="([^"]+)"[^>]*>[\s\S]*?<\/skill>\s*/;

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

    const command = `/skill:${names.join(',')}`;
    return remaining ? `${command} ${remaining}` : command;
}
