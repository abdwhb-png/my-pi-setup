import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
    calls,
    createTestSession,
    says,
    when,
    type TestSession,
} from '@abdwhb-png/pi-test-harness';
import { registerSddExtension, type SddRuntime } from './extension-tools.ts';
import { SddStore } from './store.ts';

const directories: string[] = [];
const sessions: TestSession[] = [];

afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function createRuntime(agentDir: string): SddRuntime {
    return {
        agentDir,
        store: new SddStore(agentDir),
        delegation: {
            run: mock(() => {
                throw new Error('Unexpected delegation in status test.');
            }),
            dispose: mock(),
        },
        workflow: {
            run: mock(() => {
                throw new Error('Unexpected workflow run in status test.');
            }),
            cancel: mock(() => {
                throw new Error('Unexpected cancellation in status test.');
            }),
            completeDirect: mock(() => {
                throw new Error('Unexpected completion in status test.');
            }),
            reconcile: mock(() => {
                throw new Error('Unexpected reconciliation in status test.');
            }),
        },
    };
}

describe('sdd-orchestrator real Pi runtime boundary', () => {
    it('registers and executes sdd_status through a real Pi session', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'sdd-pi-runtime-cwd-'));
        const agentDir = mkdtempSync(
            join(tmpdir(), 'sdd-pi-runtime-agent-'),
        );
        directories.push(cwd, agentDir);

        const runtime = createRuntime(agentDir);
        const session = await createTestSession({
            cwd,
            extensionFactories: [
                (pi: ExtensionAPI) => registerSddExtension(pi, runtime),
            ],
        });
        sessions.push(session);

        await session.run(
            when('Inspect the SDD orchestrator.', [
                calls('sdd_status', {}),
                says('No active SDD runs.'),
            ]),
        );

        const results = session.events.toolResultsFor('sdd_status');
        expect(results).toHaveLength(1);
        expect(results[0]?.mocked).toBe(false);
        expect(results[0]?.isError).toBe(false);
        expect(results[0]?.text).toContain('No SDD runs.');
    });
});
