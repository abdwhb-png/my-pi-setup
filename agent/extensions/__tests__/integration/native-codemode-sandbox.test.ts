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
        const result = session.events.toolResultsFor('codemode')[0];
        expect(result?.isError).toBe(true);
        expect(JSON.stringify(result)).toMatch(/shell|sandbox|authorization/i);
        expect(existsSync(marker)).toBe(false);
    } finally {
        if (session) {
            await session.session.extensionRunner.emit({
                type: 'session_shutdown',
                reason: 'quit',
            });
            session.dispose();
        }
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(root, { recursive: true, force: true });
    }
}, 30000);
