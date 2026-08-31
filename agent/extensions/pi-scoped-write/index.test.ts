import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

mock.module('@plannotator/pi-extension/config.js', () => ({
    loadPlannotatorConfig: () => ({ config: {} }),
    resolvePlanFileDir: () => 'docs/plans',
}));

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('the scoped-write extension owns debug, report, and purge tools', async () => {
    const registered = new Map<string, { execute: Function }>();
    const { default: registerScopedWrite } = await import('./index.ts');
    registerScopedWrite({
        registerTool(tool: { name: string; execute: Function }) {
            registered.set(tool.name, tool);
        },
    } as unknown as ExtensionAPI);

    expect([...registered.keys()]).toEqual([
        'write_debug_probe',
        'edit_debug_probe',
        'write_report',
        'edit_report',
        'artifacts_purge',
    ]);

    const cwd = mkdtempSync(join(tmpdir(), 'pi-scoped-write-extension-'));
    temporaryDirectories.push(cwd);
    const write = registered.get('write_report');
    if (!write) throw new Error('write_report was not registered');
    const result = await write.execute(
        'call-1',
        { path: 'summary.md', content: '# QA passed\n' },
        undefined,
        undefined,
        {
            cwd,
            hasUI: false,
            sessionManager: {
                getSessionId: () => 'session-1',
                getEntries: () => [
                    {
                        type: 'custom',
                        customType: 'pi-roles:active-role',
                        data: {
                            name: 'sdd-qa-tester',
                            source: 'user',
                            path: 'sdd-qa-tester.md',
                            appliedAt: 1,
                        },
                    },
                ],
            },
        },
    );

    expect(result.details.kind).toBe('success');
    expect(
        readFileSync(
            join(
                cwd,
                '.pi/artifacts/reports/sdd-qa-tester/session-1/summary.md',
            ),
            'utf8',
        ),
    ).toBe('# QA passed\n');

    const auditEvents = readFileSync(
        join(cwd, '.pi/artifacts/.audit/session-1.jsonl'),
        'utf8',
    )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    expect(auditEvents.map((event) => event.tool)).toEqual([
        'write_report',
    ]);
});

test('report tools attribute a subagent write to its declared child agent', async () => {
    const registered = new Map<string, { execute: Function }>();
    const { default: registerScopedWrite } = await import('./index.ts');
    registerScopedWrite({
        registerTool(tool: { name: string; execute: Function }) {
            registered.set(tool.name, tool);
        },
    } as unknown as ExtensionAPI);
    const cwd = mkdtempSync(join(tmpdir(), 'pi-scoped-write-subagent-'));
    temporaryDirectories.push(cwd);
    const previousChild = process.env.PI_SUBAGENT_CHILD;
    const previousAgent = process.env.PI_SUBAGENT_CHILD_AGENT;
    process.env.PI_SUBAGENT_CHILD = '1';
    process.env.PI_SUBAGENT_CHILD_AGENT = 'sdd-qa-tester';

    try {
        const write = registered.get('write_report');
        if (!write) throw new Error('write_report was not registered');
        await write.execute(
            'call-1',
            { path: 'qa-result.json', content: '{"version":1}\n' },
            undefined,
            undefined,
            {
                cwd,
                hasUI: false,
                sessionManager: {
                    getSessionId: () => 'child-session-1',
                    getEntries: () => [],
                },
            },
        );
    } finally {
        if (previousChild === undefined) {
            delete process.env.PI_SUBAGENT_CHILD;
        } else {
            process.env.PI_SUBAGENT_CHILD = previousChild;
        }
        if (previousAgent === undefined) {
            delete process.env.PI_SUBAGENT_CHILD_AGENT;
        } else {
            process.env.PI_SUBAGENT_CHILD_AGENT = previousAgent;
        }
    }

    expect(
        readFileSync(
            join(
                cwd,
                '.pi/artifacts/reports/sdd-qa-tester/child-session-1/qa-result.json',
            ),
            'utf8',
        ),
    ).toBe('{"version":1}\n');
    const audit = JSON.parse(
        readFileSync(
            join(cwd, '.pi/artifacts/.audit/child-session-1.jsonl'),
            'utf8',
        ),
    );
    expect(audit).toMatchObject({
        agent: 'sdd-qa-tester',
        role: 'sdd-qa-tester',
        tool: 'write_report',
    });
});
