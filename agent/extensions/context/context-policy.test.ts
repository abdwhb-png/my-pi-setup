import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createTestSession } from '@abdwhb-png/pi-test-harness';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { useIsolatedAgentDir } from '../_shared/testing/config-fixture.ts';
import { mountPolicy } from '../_shared/testing/tool-policy-fixture.ts';

const agentDir = useIsolatedAgentDir();

for (const hasUI of [false, true]) {
    test('/context exposes the last policy resolution (TUI=' + hasUI + ')', async () => {
        const session = await createTestSession({
            cwd: agentDir(),
            extensions: [resolve(import.meta.dir, 'index.ts')],
        });
        try {
            const policy = mountPolicy({ registered: () => [], active: () => [], apply: () => {} });
            policy.setRole({ version: 1, roleName: 'fixture', mode: 'set', toolNames: ['mcp:docs'] });
            const diagnostic = policy.inspect()!.diagnostics[0]!;
            expect(diagnostic.code).toBe('unresolved-mcp-reference');
            const runner = session.session.extensionRunner;
            if (!runner) throw new Error('Missing Pi extension runner');
            const command = runner.getCommand('context');
            if (!command) throw new Error('Missing /context command');
            const context = runner.createCommandContext();
            let output = '';
            const custom: ExtensionCommandContext['ui']['custom'] = (factory) => new Promise((done, reject) => {
                Promise.resolve(factory(
                    { terminal: { rows: 80 }, requestRender: () => {} } as never,
                    context.ui.theme,
                    {} as never,
                    done,
                )).then((view) => {
                    for (const width of [48, 80, 180]) {
                        const rendered = view.render(width);
                        expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
                    }
                    output = view.render(180).join('\n');
                    if (!view.handleInput) throw new Error('Context view has no input handler');
                    view.handleInput('\r');
                }).catch(reject);
            });
            const ctx = { ...context, hasUI, ui: { ...context.ui, custom } };
            const showContext = async () => {
                await command.handler('', ctx);
                if (!hasUI) {
                    const message = session.session.agent.state.messages.findLast(
                        (entry) => entry.role === 'custom' && entry.customType === 'context',
                    );
                    if (message?.role !== 'custom' || typeof message.content !== 'string') {
                        throw new Error('Missing plain /context output');
                    }
                    output = message.content;
                }
            };
            const before = policy.inspect();
            await showContext();

            expect(output).toContain('Last policy resolution');
            expect(output).toContain(diagnostic.code);
            expect(output).toContain(diagnostic.group);
            expect(output).toContain(diagnostic.member);
            expect(output).toContain('/mcp');
            expect(policy.inspect()).toEqual(before);
            policy.setRole({ version: 1, roleName: 'fixture', mode: 'set', toolNames: [] });
            await showContext();
            expect(output).not.toContain(diagnostic.code);
        } finally {
            await session.close();
        }
    }, 20000);
}
