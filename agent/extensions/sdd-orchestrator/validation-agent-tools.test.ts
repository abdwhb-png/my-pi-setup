import { expect, test } from 'bun:test';
import { getSddAgentEntry } from './sdd-agents.ts';

test('the runtime QA agent can persist reports without general file-write authority', () => {
    const entry = getSddAgentEntry('sdd-qa-tester');
    if (!entry) throw new Error('Runtime QA agent missing');
    const agent = entry.markdown;
    const tools = agent.match(/^tools:\s*(.+)$/m)?.[1] ?? '';
    expect(tools).toContain('write_report');
    expect(tools).not.toMatch(/(^|,\s*)(write|edit|edit_report)(,|$)/);
    expect(agent).toContain('Persist the final JSON payload with `write_report` at `qa-result.json`.');
    expect(agent).toContain('Then return the same JSON payload as the terminal response.');
    expect(agent).toContain('`write_report` is the only permitted file mutation.');
});
