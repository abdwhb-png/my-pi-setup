import type { Theme } from '@earendil-works/pi-coding-agent';
export function renderCwd(
    theme: Theme,
    innerWidth: number,
    cwd: string,
): string[] {
    const contentWidth = Math.max(1, innerWidth - 2);
    const text = `CWD: ${cwd}`;
    const lines: string[] = [];

    for (let offset = 0; offset < text.length; offset += contentWidth) {
        const chunk = text.slice(offset, offset + contentWidth);
        lines.push(
            theme.fg('border', '│') +
                ' ' +
                theme.fg('accent', theme.bold(chunk)),
        );
    }

    return lines.length > 0 ? lines : [theme.fg('border', '│')];
}
