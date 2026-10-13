import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    createMcpFixture,
    createTestSession,
    when,
    calls,
    says,
} from '@abdwhb-png/pi-test-harness';
import {
    createCodemodeExtension,
    createMcpExtension,
    createToolSearchExtension,
    type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { echoTool } from './fixtures/local-mcp.ts';
import { publicExtensionEntrypoint } from './public-extension-session.ts';

test.each([true, false])(
    'native MCP nested execution respects the role (allowed=%s)',
    async (allowed) => {
        const root = mkdtempSync(join(tmpdir(), 'native-mcp-policy-'));
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        const fixture = createMcpFixture({
            tools: [
                {
                    tool: echoTool,
                    response: {
                        content: [{ type: 'text', text: 'echo:nested' }],
                    },
                },
            ],
        });
        let host: ExtensionAPI | undefined;
        let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
        try {
            process.env.PI_CODING_AGENT_DIR = root;
            session = await createTestSession({
                cwd: root,
                extensions: [publicExtensionEntrypoint('tool-groups')],
                extensionFactories: [
                    createCodemodeExtension(),
                    createToolSearchExtension(),
                    createMcpExtension(fixture.extensionOptions),
                    (pi: ExtensionAPI) => {
                        host = pi;
                        pi.on('before_agent_start', () => {
                            pi.events.emit('pi-roles:tool-policy', {
                                version: 1,
                                roleName: 'fixture',
                                mode: 'set',
                                toolNames: allowed
                                    ? ['codemode', 'tool_search', 'mcp:fixture']
                                    : ['codemode', 'tool_search'],
                            });
                        });
                    },
                ],
            });
            // MCP initialization is asynchronous. The native codemode boundary waits for discovery.
            await session.run(
                when('Call the fixture', [
                    calls('codemode', {
                        code: 'return await tools.mcp__fixture__echo({message:"nested"});',
                    }),
                    says('done'),
                ]),
            );
            expect(
                host
                    ?.getAllTools()
                    .find((tool) => tool.name === 'mcp__fixture__echo')
                    ?.exposure,
            ).toBe('deferred');
            expect(session.session.getActiveToolNames()).not.toContain(
                'mcp__fixture__echo',
            );
            const parents = session.events.toolCallsFor('codemode');
            expect(parents).toHaveLength(1);
            const parent = parents[0];
            const result = session.events
                .toolResultsFor('codemode')
                .find((record) => record.toolCallId === parent.toolCallId);
            expect(result).toBeDefined();
            const children = session.events.toolCallsFor('mcp__fixture__echo');
            expect(children).toHaveLength(1);
            const child = children[0];
            expect(child.parentToolCallId).toBe(parent.toolCallId);
            expect(child.input).toEqual({ message: 'nested' });
            const childResult = session.events
                .toolResultsFor(child.toolName)
                .find((record) => record.toolCallId === child.toolCallId);
            expect(childResult).toMatchObject({
                parentToolCallId: parent.toolCallId,
                isError: !allowed,
            });
            expect(fixture.closed).toBe(false);
            if (allowed) {
                expect(result?.isError).toBe(false);
                expect(result?.text).toContain('echo:nested');
                expect(fixture.calls).toHaveLength(1);
                expect(fixture.calls[0]).toMatchObject({
                    toolName: 'echo',
                    arguments: { message: 'nested' },
                });
                expect(child.blocked).toBe(false);
            } else {
                expect(result?.isError).toBe(true);
                expect(fixture.calls).toEqual([]);
                expect(result?.text).toContain('mcp__fixture__echo');
                expect(result?.text).toContain('not allowed');
                expect(child.blocked).toBe(true);
                expect(child.blockReason).toContain(
                    'active role / workflow tool policy',
                );
            }
            await session.run(
                when('Find the echo tool', [
                    calls('tool_search', { query: 'fixture echo' }),
                    says('found'),
                ]),
            );
            expect(
                session.session
                    .getActiveToolNames()
                    .includes('mcp__fixture__echo'),
            ).toBe(allowed);
        } finally {
            try {
                await session?.close();
                expect(fixture.closed).toBe(true);
            } finally {
                if (previousAgentDir === undefined)
                    delete process.env.PI_CODING_AGENT_DIR;
                else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
                rmSync(root, { recursive: true, force: true });
            }
        }
    },
    20000,
);
