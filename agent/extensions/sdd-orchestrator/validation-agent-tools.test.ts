import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { getSddAgentEntry } from './sdd-agents.ts';

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
        // sdd-qa-tester now lives in the runtime definition set (the static .md
        // was removed); browser-tester stays a static file.
        const entry =
            name === 'sdd-qa-tester' ? getSddAgentEntry(name) : undefined;
        const agent = entry
            ? entry.definition.systemPrompt ?? ''
            : readAgent(name);
        const tools = entry
            ? (entry.definition.tools ?? []).join(', ')
            : (agent.match(/^tools:\s*(.+)$/m)?.[1] ?? '');

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
