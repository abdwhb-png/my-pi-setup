import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
} from '@earendil-works/pi-coding-agent';
import { echoTool } from './fixtures/local-mcp.ts';

test('installed permission extension blocks a nested native MCP call before the server', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-mcp-permission-'));
    const fixture = createMcpFixture({
        tools: [
            {
                tool: echoTool,
                response: {
                    content: [{ type: 'text', text: 'echo:forbidden' }],
                },
            },
        ],
    });
    const previous = process.env.PI_CODING_AGENT_DIR;
    const denialReason = 'Fixture MCP echo permission denied';
    let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
    try {
        process.env.PI_CODING_AGENT_DIR = root;
        const config = join(root, 'extensions/pi-permission-system');
        mkdirSync(config, { recursive: true });
        writeFileSync(
            join(config, 'config.json'),
            JSON.stringify({
                permission: {
                    '*': 'allow',
                    mcp__fixture__echo: {
                        '*': { action: 'deny', reason: denialReason },
                    },
                },
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
                createMcpExtension(fixture.extensionOptions),
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
        const parents = session.events.toolCallsFor('codemode');
        expect(parents).toHaveLength(1);
        const parent = parents[0];
        const children = session.events.toolCallsFor('mcp__fixture__echo');
        expect(children).toHaveLength(1);
        const child = children[0];
        expect(child.parentToolCallId).toBe(parent.toolCallId);
        expect(child.input).toEqual({ message: 'forbidden' });
        expect(child.blocked).toBe(true);
        expect(child.blockReason).toContain('Denied by policy:');
        expect(child.blockReason).toContain('mcp__fixture__echo');
        expect(child.blockReason).toContain(denialReason);
        const childResult = session.events
            .toolResultsFor(child.toolName)
            .find((record) => record.toolCallId === child.toolCallId);
        expect(childResult).toMatchObject({
            parentToolCallId: parent.toolCallId,
            isError: true,
        });
        expect(childResult?.text).toContain(child.blockReason);
        const result = session.events
            .toolResultsFor('codemode')
            .find((record) => record.toolCallId === parent.toolCallId);
        expect(result?.isError).toBe(true);
        expect(fixture.calls).toEqual([]);
        expect(fixture.closed).toBe(false);
    } finally {
        try {
            await session?.close();
            expect(fixture.closed).toBe(true);
        } finally {
            if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previous;
            rmSync(root, { recursive: true, force: true });
        }
    }
}, 30000);
