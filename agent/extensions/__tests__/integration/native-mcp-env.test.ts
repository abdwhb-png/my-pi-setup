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
    createMcpExtension,
    createCodemodeExtension,
} from '@earendil-works/pi-coding-agent';
import { startFixtureMcp } from './fixtures/local-mcp.ts';

test('native stdio MCP resolves both environment forms and inherits the parent environment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-mcp-env-'));
    const previous = process.env.PI_MCP_FIXTURE_PARENT;
    let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
    try {
        process.env.PI_MCP_FIXTURE_PARENT = 'fixture-parent';
        session = await createTestSession({
            cwd: root,
            extensionFactories: [
                createCodemodeExtension(),
                createMcpExtension({
                    logPath: join(root, 'mcp.log'),
                    loadConfig: () => ({
                        errors: [],
                        servers: [
                            {
                                name: 'fixture',
                                source: join(root, 'mcp.json'),
                                config: {
                                    command: process.execPath,
                                    args: [
                                        join(
                                            import.meta.dir,
                                            'fixtures/native-mcp-stdio.mjs',
                                        ),
                                    ],
                                    env: {
                                        FIXTURE_BRACED:
                                            '${PI_MCP_FIXTURE_PARENT}',
                                        FIXTURE_BARE: '$PI_MCP_FIXTURE_PARENT',
                                    },
                                    exposure: 'codemode',
                                },
                            },
                        ],
                    }),
                }),
            ],
        });
        await session.run(
            when('Check the fixture environment', [
                calls('codemode', {
                    code: 'const result = await tools.mcp__fixture__environment({}); return JSON.parse(result.content[0].text);',
                }),
                says('done'),
            ]),
        );
        const result = session.events.toolResultsFor('codemode')[0];
        expect(result?.isError).toBe(false);
        expect(result?.text).toContain('"braced":true');
        expect(result?.text).toContain('"bare":true');
        expect(result?.text).toContain('"inherited":true');
    } finally {
        if (session) {
            await session.session.extensionRunner.emit({
                type: 'session_shutdown',
                reason: 'quit',
            });
            session.dispose();
        }
        if (previous === undefined) delete process.env.PI_MCP_FIXTURE_PARENT;
        else process.env.PI_MCP_FIXTURE_PARENT = previous;
        rmSync(root, { recursive: true, force: true });
    }
}, 20000);

test('native HTTP MCP expands environment variables in authentication headers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-mcp-http-env-'));
    const previous = process.env.PI_MCP_FIXTURE_PARENT;
    let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
    const observed: string[] = [];
    const authenticated: boolean[] = [];
    const server = startFixtureMcp(observed, (request) => {
        if (request.method === 'POST')
            authenticated.push(
                request.headers.get('authorization') ===
                    'Bearer fixture-parent' &&
                    request.headers.get('x-fixture-bare') === 'fixture-parent',
            );
    });
    try {
        process.env.PI_MCP_FIXTURE_PARENT = 'fixture-parent';
        session = await createTestSession({
            cwd: root,
            extensionFactories: [
                createCodemodeExtension(),
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
                                    headers: {
                                        Authorization:
                                            'Bearer ${PI_MCP_FIXTURE_PARENT}',
                                        'X-Fixture-Bare':
                                            '$PI_MCP_FIXTURE_PARENT',
                                    },
                                },
                            },
                        ],
                    }),
                }),
            ],
        });
        await session.run(
            when('Check HTTP environment', [
                calls('codemode', {
                    code: 'return await tools.mcp__fixture__echo({message:"authenticated"});',
                }),
                says('done'),
            ]),
        );
        expect(session.events.toolResultsFor('codemode')[0]?.isError).toBe(
            false,
        );
        expect(observed).toEqual(['authenticated']);
        expect(authenticated.length).toBeGreaterThan(0);
        expect(authenticated.every(Boolean)).toBe(true);
    } finally {
        if (session) {
            await session.session.extensionRunner.emit({
                type: 'session_shutdown',
                reason: 'quit',
            });
            session.dispose();
        }
        await server.stop(true);
        if (previous === undefined) delete process.env.PI_MCP_FIXTURE_PARENT;
        else process.env.PI_MCP_FIXTURE_PARENT = previous;
        rmSync(root, { recursive: true, force: true });
    }
}, 20000);
