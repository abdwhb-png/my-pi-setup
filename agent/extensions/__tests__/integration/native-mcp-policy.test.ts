import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
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
import { startFixtureMcp } from './fixtures/local-mcp.ts';
import { publicExtensionEntrypoint } from './public-extension-session.ts';

test.each([true, false])(
    'native MCP nested execution respects the role (allowed=%s)',
    async (allowed) => {
        const root = mkdtempSync(join(tmpdir(), 'native-mcp-policy-'));
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        const observed: string[] = [];
        const server = startFixtureMcp(observed);
        let host: ExtensionAPI | undefined;
        let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
        const nested: Array<{ name: string; parent?: string }> = [];
        try {
            process.env.PI_CODING_AGENT_DIR = root;
            session = await createTestSession({
                cwd: root,
                extensions: [publicExtensionEntrypoint('tool-groups')],
                extensionFactories: [
                    createCodemodeExtension(),
                    createToolSearchExtension(),
                    createMcpExtension({
                        logPath: join(root, 'mcp.log'),
                        loadConfig: () => ({
                            errors: [],
                            servers: [
                                {
                                    name: 'fixture',
                                    source: join(root, 'mcp.json'),
                                    config: {
                                        url: `${server.url}mcp`,
                                        exposure: 'codemode',
                                    },
                                },
                            ],
                        }),
                    }),
                    (pi: ExtensionAPI) => {
                        host = pi;
                        pi.on('tool_call', (event) => {
                            nested.push({
                                name: event.toolName,
                                parent: event.parentToolCallId,
                            });
                        });
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
            const result = session.events.toolResultsFor('codemode')[0];
            expect(result).toBeDefined();
            if (allowed) {
                expect(result?.isError).toBe(false);
                expect(result?.text).toContain('echo:nested');
                expect(observed).toEqual(['nested']);
            } else {
                expect(result?.isError).toBe(true);
                expect(observed).toEqual([]);
                expect(result?.text).toContain('mcp__fixture__echo');
                expect(result?.text).toContain('not allowed');
            }
            expect(
                nested.some(
                    (call) => call.name === 'mcp__fixture__echo' && call.parent,
                ),
            ).toBe(allowed);
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
            if (session) {
                await session.session.extensionRunner.emit({
                    type: 'session_shutdown',
                    reason: 'quit',
                });
                session.dispose();
            }
            await server.stop(true);
            if (previousAgentDir === undefined)
                delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            rmSync(root, { recursive: true, force: true });
        }
    },
    20000,
);
