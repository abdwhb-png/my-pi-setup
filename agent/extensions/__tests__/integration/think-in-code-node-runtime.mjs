import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const isolatedHome = process.env.THINK_NODE_TEST_HOME;

if (!isolatedHome) {
    void test('Think-in-Code loads under Node with an isolated home', () => {
        const home = mkdtempSync(join(tmpdir(), 'think-node-runtime-'));
        try {
            const env = { ...process.env };
            delete env.NODE_TEST_CONTEXT;
            const child = spawnSync(
                process.execPath,
                [fileURLToPath(import.meta.url)],
                {
                    env: {
                        ...env,
                        HOME: home,
                        PI_CODING_AGENT_DIR: join(home, 'agent'),
                        THINK_NODE_TEST_HOME: home,
                        PI_OFFLINE: '1',
                    },
                    encoding: 'utf8',
                    timeout: 90_000,
                },
            );
            if (child.error) throw child.error;
            assert.match(
                child.stdout,
                /Pi loads real Think-in-Code entrypoint under Node/,
                `child status=${child.status}, stderr=${child.stderr}`,
            );
            assert.equal(child.status, 0, child.stdout + child.stderr);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });
} else {
    const entry = join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'think-in-code',
        'index.ts',
    );
    void test('Pi loads real Think-in-Code entrypoint under Node', async () => {
        const cwd = join(isolatedHome, 'project');
        mkdirSync(cwd, { recursive: true });
        const { DefaultResourceLoader } =
            await import('@earendil-works/pi-coding-agent');
        const loader = new DefaultResourceLoader({
            cwd,
            agentDir: process.env.PI_CODING_AGENT_DIR,
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            additionalExtensionPaths: [entry],
        });
        await loader.reload();
        const result = loader.getExtensions();
        assert.deepEqual(result.errors, []);
        assert.ok(
            result.extensions.some((extension) => extension.path === entry),
        );
    });

    void test('pi-subagents child activates Think artifact search under Node', async () => {
        const cwd = join(isolatedHome, 'project');
        const piRoot = dirname(
            dirname(
                fileURLToPath(
                    import.meta.resolve('@earendil-works/pi-coding-agent'),
                ),
            ),
        );
        process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = piRoot;
        const sdk = await import('@earendil-works/pi-coding-agent');
        const subagentEntry = import.meta.resolve('pi-subagents');
        const { createDefaultChildSessionFactory } = await import(
            new URL('./src/runs/shared/child-session.js', subagentEntry)
        );
        const errors = [];
        let session;
        let child;
        const factory = createDefaultChildSessionFactory({
            loadPiCodingAgent: async () => ({
                ...sdk,
                createAgentSession: async (options) => {
                    const result = await sdk.createAgentSession(options);
                    session = result.session;
                    return result;
                },
            }),
        });
        try {
            child = await factory.create({
                cwd,
                storage: { kind: 'memory' },
                tools: ['think_artifact_search'],
                extensionPaths: [entry],
                ambientExtensions: false,
                hooks: [],
                noSkills: true,
                noContextFiles: true,
                runtime: {
                    fanoutChild: false,
                    depth: 1,
                    waitTool: { enabled: false },
                    fast: false,
                },
                onExtensionError: (error) => errors.push(error),
            });
            assert.deepEqual(errors, []);
            assert.ok(
                session
                    .getAllTools()
                    .some(({ name }) => name === 'think_artifact_search'),
            );
            assert.ok(
                session.getActiveToolNames().includes('think_artifact_search'),
            );
        } finally {
            await child?.dispose();
            await factory.dispose();
        }
    });
}
