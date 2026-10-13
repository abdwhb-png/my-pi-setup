import { expect, test } from 'bun:test';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    createTestSession,
    when,
    calls,
    says,
} from '@abdwhb-png/pi-test-harness';
import { createCodemodeExtension } from '@earendil-works/pi-coding-agent';
import { publicExtensionEntrypoints } from './public-extension-session.ts';

test('native codemode cannot bypass the shell admission gate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-codemode-sandbox-')),
        marker = join(root, 'must-not-exist');
    const previous = process.env.PI_CODING_AGENT_DIR;
    let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
    try {
        process.env.PI_CODING_AGENT_DIR = root;
        session = await createTestSession({
            cwd: root,
            extensions: publicExtensionEntrypoints(
                'bash-execution',
                'tool-groups',
            ),
            extensionFactories: [
                createCodemodeExtension(),
                (pi) => {
                    pi.on('before_agent_start', () =>
                        pi.events.emit('pi-roles:tool-policy', {
                            version: 1,
                            roleName: 'fixture',
                            mode: 'set',
                            toolNames: ['codemode', 'bash'],
                        }),
                    );
                },
            ],
        });
        await session.run(
            when('Nested blocked shell', [
                calls('codemode', {
                    code: `return await tools.bash({command:${JSON.stringify('touch ' + marker)}});`,
                }),
                says('done'),
            ]),
        );
        const parents = session.events.toolCallsFor('codemode');
        expect(parents).toHaveLength(1);
        const parent = parents[0];
        const children = session.events.toolCallsFor('bash');
        expect(children).toHaveLength(1);
        const child = children[0];
        expect(child.parentToolCallId).toBe(parent.toolCallId);
        expect(child.input).toEqual({ command: 'touch ' + marker });
        // Shell admission fails inside the real tool, after tool_call hooks.
        expect(child.blocked).toBe(false);
        const childResult = session.events
            .toolResultsFor('bash')
            .find((record) => record.toolCallId === child.toolCallId);
        expect(childResult).toMatchObject({
            parentToolCallId: parent.toolCallId,
            isError: true,
            mocked: false,
        });
        expect(childResult?.text).toContain('authorization-required');
        expect(childResult?.text).toContain('Shell policy is not initialized');
        const result = session.events
            .toolResultsFor('codemode')
            .find((record) => record.toolCallId === parent.toolCallId);
        expect(result?.isError).toBe(true);
        expect(result?.text).toContain('authorization-required');
        expect(existsSync(marker)).toBe(false);
    } finally {
        try {
            await session?.close();
        } finally {
            if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previous;
            rmSync(root, { recursive: true, force: true });
        }
    }
}, 30000);
