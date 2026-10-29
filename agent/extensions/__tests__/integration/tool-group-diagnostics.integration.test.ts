import { expect, test } from 'bun:test';
import { join } from 'node:path';
import {
    calls,
    createMcpFixture,
    createTestSession,
    says,
    when,
} from '@abdwhb-png/pi-test-harness';
import {
    createCodemodeExtension,
    createMcpExtension,
    createToolSearchExtension,
} from '@earendil-works/pi-coding-agent';
import { useIsolatedAgentDir, writeFixtureFile } from '../../_shared/testing/config-fixture.ts';
import { TOOL_GROUPS_REQUESTED_TOOLS_ENV } from '../../_shared/tool-groups/types.ts';
import { getToolPolicy } from '../../_shared/tool-policy/index.ts';
import { echoTool } from './fixtures/local-mcp.ts';
import { publicExtensionEntrypoint } from './public-extension-session.ts';

const agentDir = useIsolatedAgentDir();

test.each([false, true])('unresolved MCP references resolve without repeating warnings (other warnings=%s)', async (otherWarnings) => {
    const root = agentDir();
    const key = Symbol.for('pi.tool-policy.cli-requested.v1');
    const previousRegistry = Object.getOwnPropertyDescriptor(globalThis, key);
    const previousRequested = process.env[TOOL_GROUPS_REQUESTED_TOOLS_ENV];
    const fixture = createMcpFixture({
        tools: [{ tool: echoTool, response: { content: [{ type: 'text', text: 'echo:registered' }] } }],
    });
    let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
    try {
        writeFixtureFile(join(root, 'config/tool-groups.json'), JSON.stringify({ groups: { docs: ['mcp:fixture'] } }));
        process.env[TOOL_GROUPS_REQUESTED_TOOLS_ENV] = JSON.stringify([
            '@docs', 'codemode', 'tool_search',
            ...(otherWarnings ? ['not_installed', 'mcp:'] : []),
        ]);
        session = await createTestSession({
            cwd: root,
            extensions: [publicExtensionEntrypoint('context'), publicExtensionEntrypoint('tool-groups')],
            extensionFactories: [
                createCodemodeExtension(),
                createToolSearchExtension(),
                createMcpExtension(fixture.extensionOptions),
            ],
        });
        const initial = getToolPolicy().inspect();
        expect(initial?.diagnostics).toContainEqual(expect.objectContaining({ code: 'unresolved-mcp-reference', member: 'mcp:fixture' }));
        expect(initial?.names).not.toContain('mcp__fixture__echo');
        const startupNotifications = [...session.events.uiCallsFor('notify')];
        expect(startupNotifications).toHaveLength(otherWarnings ? 1 : 0);
        if (otherWarnings) {
            const text = JSON.stringify(startupNotifications);
            expect(text).toContain('[unknown-tool]');
            expect(text).toContain('[invalid-mcp-reference]');
            expect(text).not.toContain('[unresolved-mcp-reference]');
        }
        const currentSession = session;
        const inspectContext = async () => {
            const runner = currentSession.session.extensionRunner;
            if (!runner) throw new Error('Missing Pi extension runner');
            const command = runner.getCommand('context');
            if (!command) throw new Error('Missing /context command');
            await command.handler('', { ...runner.createCommandContext(), hasUI: false });
            const message = currentSession.session.agent.state.messages.findLast(
                (entry) => entry.role === 'custom' && entry.customType === 'context',
            );
            if (message?.role !== 'custom') throw new Error('Missing /context output');
            return message.content;
        };
        const initialContext = await inspectContext();
        if (typeof initialContext !== 'string') throw new Error('Expected plain /context output');
        expect(initialContext.split('[unresolved-mcp-reference]').length - 1).toBe(1);

        getToolPolicy().setRole({
            version: 1,
            roleName: 'fixture',
            mode: 'set',
            toolNames: ['codemode', 'tool_search', '@docs'],
        });
        await session.run(when('Call the native fixture', [
            calls('codemode', { code: 'return await tools.mcp__fixture__echo({message:"registered"});' }),
            says('done'),
        ]));
        expect(session.events.toolResultsFor('codemode')).toContainEqual(expect.objectContaining({ isError: false }));
        expect(fixture.calls).toHaveLength(1);
        expect(getToolPolicy().inspect()?.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('unresolved-mcp-reference');
        expect(getToolPolicy().inspect()?.names).toContain('mcp__fixture__echo');
        expect(session.session.getActiveToolNames()).not.toContain('mcp__fixture__echo');
        await session.run(when('Refresh after discovery', [says('done')]));
        expect(session.events.uiCallsFor('notify')).toEqual(startupNotifications);
        expect(await inspectContext()).not.toContain('unresolved-mcp-reference');
    } finally {
        try {
            await session?.close();
            expect(fixture.closed).toBe(true);
        } finally {
            if (previousRequested === undefined) delete process.env[TOOL_GROUPS_REQUESTED_TOOLS_ENV];
            else process.env[TOOL_GROUPS_REQUESTED_TOOLS_ENV] = previousRequested;
            if (previousRegistry) Object.defineProperty(globalThis, key, previousRegistry);
            else Reflect.deleteProperty(globalThis, key);
        }
    }
}, 20000);
