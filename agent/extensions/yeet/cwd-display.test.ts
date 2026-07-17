import { describe, expect, it } from 'bun:test';
import { renderCwd } from './cwd-display';

const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
};

describe('renderCwd', () => {
    it('keeps the complete CWD visible when the terminal is narrow', () => {
        const cwd = '/home/user/projects/very-long-repository';
        const rendered = renderCwd(theme as never, 24, cwd).join('\n');

        expect(rendered).toContain('CWD:');
        expect(rendered.replace(/\n│ /g, '')).toContain(`CWD: ${cwd}`);
    });
});
