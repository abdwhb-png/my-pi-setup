import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestSession, when, calls, says } from '@abdwhb-png/pi-test-harness';
import { createEditTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import herdr from '../pi-herdr/index.ts';
import { applyRole } from '../pi-roles/core/apply.ts';
import type { ResolvedRole } from '../pi-roles/core/schemas.ts';
import { createToolGroupsExtension } from './index.ts';

test.each(['herdr-role-owner', 'owner-herdr-role', 'role-owner-herdr'] as const)('debug -> unrestricted pi-agent preserves edit: %s', async order => {
    const cwd = mkdtempSync(join(tmpdir(), 'role-policy-runtime-'));
    const previousEnv = process.env.HERDR_ENV;
    const previousPane = process.env.HERDR_PANE_ID;
    process.env.HERDR_ENV = '1';
    process.env.HERDR_PANE_ID = 'fixture';
    const snapshots: Array<{ role: string; edit: boolean; write: boolean }> = [];
    const driver = (pi: ExtensionAPI) => {
        pi.registerTool({
            ...createEditTool(cwd),
            execute: async () => ({ content: [{ type: 'text', text: 'edit executed' }], details: {} }),
        });
        pi.on('before_agent_start', async (event, ctx) => {
            const debug = event.prompt === 'debug';
            const role: ResolvedRole = {
                name: debug ? 'debug' : 'pi-agent', description: '', body: '',
                source: 'project', path: join(cwd, 'role.md'), extendsChain: [],
                tools: debug ? { kind: 'set', names: ['read'] } : { kind: 'inherit' },
            };
            await applyRole(role, { pi, ctx, warnOnMissingMcp: false, showStatus: false }, { silent: true });
            snapshots.push({ role: role.name, edit: pi.getActiveTools().includes('edit'), write: pi.getActiveTools().includes('write') });
        });
    };
    const owner = createToolGroupsExtension(() => ({ groups: { inspect: ['read'] } }), () => undefined, () => undefined);
    const factories = { 'herdr-role-owner': [herdr, driver, owner], 'owner-herdr-role': [owner, herdr, driver], 'role-owner-herdr': [driver, owner, herdr] };
    const session = await createTestSession({
        cwd, systemPrompt: 'Custom SYSTEM.md', propagateErrors: false,
        extensionFactories: factories[order],
    });
    try {
        await session.run(when('debug', [says('diagnosed')]), when('apply', [calls('edit', { path: 'fixture', oldText: 'a', newText: 'b' }), says('done')]));
        expect(session.events.toolResultsFor('edit').map(r => ({ error: r.isError, text: r.text }))).toEqual([{ error: false, text: 'edit executed' }]);
        expect(snapshots).toEqual([{ role: 'debug', edit: false, write: false }, { role: 'pi-agent', edit: true, write: true }]);
    } finally {
        await session.session.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
        rmSync(cwd, { recursive: true, force: true });
        if (previousEnv === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previousEnv;
        if (previousPane === undefined) delete process.env.HERDR_PANE_ID; else process.env.HERDR_PANE_ID = previousPane;
    }
});
