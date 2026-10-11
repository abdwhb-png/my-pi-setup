import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
    createTestSession,
    when,
    calls,
    says,
} from '@abdwhb-png/pi-test-harness';
import {
    createCodemodeExtension,
    createMcpExtension,
} from '@earendil-works/pi-coding-agent';
import { startFixtureMcp } from './fixtures/local-mcp.ts';

test('installed permission extension blocks a nested native MCP call before the server', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-mcp-permission-')),
        seen: string[] = [],
        server = startFixtureMcp(seen);
    const previous = process.env.PI_CODING_AGENT_DIR;
    let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
    try {
        process.env.PI_CODING_AGENT_DIR = root;
        const config = join(root, 'extensions/pi-permission-system');
        mkdirSync(config, { recursive: true });
        writeFileSync(
            join(config, 'config.json'),
            JSON.stringify({
                permission: { '*': 'allow', mcp__fixture__echo: 'deny' },
                permissionReviewLog: false,
            }),
        );
        session = await createTestSession({
            cwd: root,
            extensions: [
                resolve(
                    import.meta.dir,
                    '../../../npm/node_modules/@gotgenes/pi-permission-system/src/index.ts',
                ),
            ],
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
                                },
                            },
                        ],
                    }),
                }),
            ],
        });
        await session.run(
            when('Nested denied call', [
                calls('codemode', {
                    code: 'return await tools.mcp__fixture__echo({message:"forbidden"});',
                }),
                says('done'),
            ]),
        );
        expect(session.events.toolResultsFor('codemode')[0]?.isError).toBe(
            true,
        );
        expect(seen).toEqual([]);
    } finally {
        if (session) {
            await session.session.extensionRunner.emit({
                type: 'session_shutdown',
                reason: 'quit',
            });
            session.dispose();
        }
        await server.stop(true);
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(root, { recursive: true, force: true });
    }
}, 30000);
