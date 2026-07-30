import { describe, expect, it } from 'bun:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { renderCwd } from './cwd-display';

const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
};

describe('renderCwd', () => {
    it('keeps the complete CWD visible when the terminal is narrow', () => {
        const cwd = '/home/user/projects/very-long-repository';
        const lines = renderCwd(theme as never, 24, cwd);
        const rendered = lines
            .map((line) => line.slice(2, -1).trimEnd())
            .join('');

        expect(rendered).toContain('CWD:');
        expect(rendered.replace(/\s/g, '')).toBe(`CWD:${cwd}`);
        expect(lines.every((line) => visibleWidth(line) === 24)).toBe(true);
    });
});
