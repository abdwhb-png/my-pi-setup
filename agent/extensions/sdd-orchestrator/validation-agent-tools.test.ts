import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

function readAgent(name: string): string {
    return readFileSync(
        new URL(`../../agents/${name}.md`, import.meta.url),
        'utf8',
    );
}

test('validation agents can persist reports without general file-write authority', () => {
    for (const [name, reportPath] of [
        ['sdd-qa-tester', 'qa-result.json'],
        ['browser-tester', 'browser-result.json'],
    ] as const) {
        const agent = readAgent(name);
        const tools = agent.match(/^tools:\s*(.+)$/m)?.[1] ?? '';

        expect(tools).toContain('write_report');
        expect(tools).not.toMatch(/(^|,\s*)(write|edit|edit_report)(,|$)/);
        expect(agent).toContain(
            `Persist the final JSON payload with \`write_report\` at \`${reportPath}\`.`,
        );
        expect(agent).toContain(
            'Then return the same JSON payload as the terminal response.',
        );
        expect(agent).toContain(
            '`write_report` is the only permitted file mutation.',
        );
    }
});
