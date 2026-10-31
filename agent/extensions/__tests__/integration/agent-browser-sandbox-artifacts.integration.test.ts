import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
    calls,
    createTestSession,
    says,
    when,
    type TestSession,
} from '@abdwhb-png/pi-test-harness';
import { localMachineId } from '../../_shared/sandbox-runtime/machine-identity.ts';

const enabled =
    process.platform === 'linux' &&
    process.env.PI_AGENT_BROWSER_SANDBOX_CONTRACT === '1';

test.skipIf(!enabled)(
    'Agent Browser automatic spills are readable through the project-only sandbox',
    async () => {
        const source = process.env.PI_AGENT_BROWSER_SANDBOX_SOURCE;
        if (!source)
            throw new Error(
                'PI_AGENT_BROWSER_SANDBOX_SOURCE must identify the candidate extension entrypoint',
            );
        const names = [
            ...new Set([
                'PI_CODING_AGENT_DIR',
                'PI_AGENT_BROWSER_CONFIG',
                'AGENT_BROWSER_CONFIG',
                'AGENT_BROWSER_SOCKET_DIR',
                'AGENT_BROWSER_HEADED',
                ...Object.keys(process.env).filter((name) =>
                    name.startsWith('AGENT_BROWSER_'),
                ),
            ]),
        ];
        const previous = new Map(
            names.map((name) => [name, process.env[name]]),
        );
        let root: string | undefined;
        let sockets: string | undefined;
        let session: TestSession | undefined;
        let server: ReturnType<typeof Bun.serve> | undefined;
        try {
            root = await mkdtemp('/var/tmp/pi-browser-sandbox-');
            sockets = await mkdtemp('/tmp/pbas-');
            const project = join(root, 'project');
            const agentDir = join(root, 'agent');
            const marker = join(root, 'host-only.txt');
            await mkdir(project, { mode: 0o700 });
            await mkdir(join(agentDir, 'config'), {
                recursive: true,
                mode: 0o700,
            });
            await writeFile(marker, 'outside-project');
            await writeFile(
                join(agentDir, 'config/sandbox.json'),
                JSON.stringify({
                    version: 2,
                    machineId: localMachineId(),
                    filesystem: { allowRead: ['.'], allowWrite: ['.'] },
                    docker: { allowed: false },
                }),
                { mode: 0o600 },
            );
            const wrapperConfig = join(root, 'wrapper.json');
            const nativeConfig = join(root, 'native.json');
            await writeFile(
                wrapperConfig,
                JSON.stringify({
                    webSearch: { enabled: false },
                    browser: {
                        defaultProfile: {
                            name: 'fixture-unused',
                            policy: 'explicit-only',
                        },
                    },
                }),
            );
            await writeFile(nativeConfig, '{}');
            for (const name of names) delete process.env[name];
            Object.assign(process.env, {
                PI_CODING_AGENT_DIR: agentDir,
                PI_AGENT_BROWSER_CONFIG: wrapperConfig,
                AGENT_BROWSER_CONFIG: nativeConfig,
                AGENT_BROWSER_SOCKET_DIR: sockets,
                AGENT_BROWSER_HEADED: 'false',
            });
            server = Bun.serve({
                hostname: '127.0.0.1',
                port: 0,
                fetch: () =>
                    new Response(
                        `<html><head><title>Artifact fixture</title></head><body><main>${Array.from({ length: 180 }, (_, index) => `<button>Artifact fixture action ${index}</button>`).join('')}</main></body></html>`,
                        { headers: { 'Content-Type': 'text/html' } },
                    ),
            });
            const entrypoint = await realpath(source);
            session = await createTestSession({
                cwd: project,
                extensions: [
                    resolve(import.meta.dir, '../../sandbox/index.ts'),
                    resolve(import.meta.dir, '../../bash-execution/index.ts'),
                    entrypoint,
                ],
                propagateErrors: false,
            });
            await session.run(
                when('Initialize the sandbox before the artifact exists', [
                    calls('safe_bash', {
                        command: 'printf sandbox-ready',
                        timeout: 20,
                    }),
                    says('Ready'),
                ]),
            );
            expect(
                session.events.toolResultsFor('safe_bash').at(-1)?.isError,
            ).toBe(false);
            await session.run(
                when('Capture dense page', [
                    calls('agent_browser', {
                        args: [
                            '--session',
                            'artifact-fixture',
                            'open',
                            `http://127.0.0.1:${server.port}`,
                        ],
                    }),
                    calls('agent_browser', {
                        args: [
                            '--session',
                            'artifact-fixture',
                            'snapshot',
                            '-i',
                        ],
                    }),
                    says('Captured'),
                ]),
            );
            const capture = session.events
                .toolResultsFor('agent_browser')
                .at(-1);
            expect(capture, capture?.text).toMatchObject({
                mocked: false,
                isError: false,
            });
            const details = capture?.details;
            const path = details && typeof details === 'object' && 'fullOutputPath' in details
                ? details.fullOutputPath : undefined;
            expect(typeof path).toBe('string');
            if (typeof path !== 'string')
                throw new Error(
                    'Dense snapshot did not produce a full output path',
                );
            const bytes = await readFile(path);
            expect(bytes.toString()).toContain('Artifact fixture action 179');
            const digest = createHash('sha256').update(bytes).digest('hex');
            await session.run(
                when('Read the exact returned artifact in the sandbox', [
                    calls('safe_bash', {
                        command: `sha256sum '${path}' && test ! -e '${marker}'`,
                        timeout: 20,
                    }),
                    says('Read'),
                ]),
            );
            const read = session.events.toolResultsFor('safe_bash').at(-1);
            expect(read, read?.text).toMatchObject({
                mocked: false,
                isError: false,
                details: {
                    execution: {
                        status: 'sandboxed',
                        backend: 'zerobox',
                        outcome: 'succeeded',
                        exitCode: 0,
                    },
                },
            });
            expect(read?.text).toContain(digest);
            expect(path).toStartWith(
                join(project, '.pi/artifacts/agent-browser/'),
            );
        } finally {
            try {
                if (session)
                    await session.run(
                        when('Close the fixture browser', [
                            calls('agent_browser', {
                                args: [
                                    '--session',
                                    'artifact-fixture',
                                    'close',
                                ],
                            }),
                            says('Closed'),
                        ]),
                    );
            } finally {
                try {
                    await session?.close();
                } finally {
                    for (const [name, value] of previous) {
                        if (value === undefined) delete process.env[name];
                        else process.env[name] = value;
                    }
                    server?.stop(true);
                    await Promise.all([
                        root
                            ? rm(root, { recursive: true, force: true })
                            : undefined,
                        sockets
                            ? rm(sockets, { recursive: true, force: true })
                            : undefined,
                    ]);
                }
            }
        }
    },
    120_000,
);
