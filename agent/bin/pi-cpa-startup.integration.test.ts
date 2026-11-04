import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePiLaunchCommand } from './pi-runtime-store.ts';

const enabled = process.env.PI_CPA_AVAILABILITY_CONTRACT === '1';

test.skipIf(!enabled)(
    'a fresh subagent CLI resolves CPA before session_start, with and without a thinking suffix',
    async () => {
        expect(process.env.GITHUB_ACTIONS).toBe('true');
        const root = mkdtempSync(join(tmpdir(), 'pi-cpa-cold-start-'));
        const modelId = 'ocg/go-glm-5.3-flash';
        const requests: string[] = [];
        let stopServer = () => {};
        try {
            const server = Bun.serve({
                hostname: '127.0.0.1',
                port: 0,
                fetch(request) {
                    requests.push(
                        `${request.method} ${new URL(request.url).pathname}`,
                    );
                    if (
                        request.method !== 'GET' ||
                        new URL(request.url).pathname !== '/v1/models'
                    )
                        return new Response('Generation is forbidden', {
                            status: 405,
                        });
                    if (
                        request.headers.get('authorization') !==
                        'Bearer fixture-cpa-key'
                    )
                        return new Response('', { status: 401 });
                    return Response.json({
                        data: [{ id: modelId, owned_by: 'ocode-go (fixture)' }],
                    });
                },
            });
            stopServer = () => {
                server.stop(true);
            };
            const packageRoot = resolve(
                dirname(
                    fileURLToPath(
                        import.meta.resolve('@earendil-works/pi-coding-agent'),
                    ),
                ),
                '..',
            );
            const manifest: { bin: { pi: string } } = await Bun.file(
                join(packageRoot, 'package.json'),
            ).json();
            const launch = resolvePiLaunchCommand(
                resolve(packageRoot, manifest.bin.pi),
                packageRoot,
            );
            expect(launch.command).toBe(process.execPath);
            const endpoint = `http://127.0.0.1:${server.port}/v1`;
            const networkPolicy = join(root, 'network-policy.ts');
            writeFileSync(
                networkPolicy,
                [
                    'const originalFetch = globalThis.fetch;',
                    `const allowed = ${JSON.stringify(`${endpoint}/models`)};`,
                    'globalThis.fetch = Object.assign(async (input, init) => {',
                    '  const request = new Request(input, init);',
                    '  if (request.url !== allowed || request.method !== "GET") throw new Error("Only fixture catalog requests are permitted");',
                    '  return originalFetch(input, init);',
                    '}, { preconnect: originalFetch.preconnect });',
                ].join('\n'),
            );

            for (const suffix of ['', ':xhigh']) {
                const cwd = join(root, suffix ? 'xhigh' : 'plain');
                const agentDir = join(cwd, 'agent');
                mkdirSync(join(agentDir, 'config'), { recursive: true });
                writeFileSync(
                    join(agentDir, 'config/ai-providers.json'),
                    JSON.stringify({
                        providers: { cpa: true },
                        cpa: { refreshTtlMs: 30_000, silentCatalogDiff: true },
                        modelRules: [
                            {
                                match: { id: modelId },
                                metadata: {
                                    reasoning: true,
                                    contextWindow: 4096,
                                    maxTokens: 1024,
                                    thinkingLevelMap: { xhigh: 'xhigh' },
                                },
                            },
                        ],
                    }),
                );
                const child = Bun.spawn(
                    [
                        launch.command,
                        '--preload',
                        networkPolicy,
                        ...launch.prefixArgs,
                        '--mode',
                        'rpc',
                        '--provider',
                        'cpa',
                        '--model',
                        `${modelId}${suffix}`,
                        '--no-extensions',
                        '--extension',
                        resolve(
                            import.meta.dir,
                            '../extensions/ai-providers/index.ts',
                        ),
                        '--no-skills',
                        '--no-prompt-templates',
                        '--no-themes',
                        '--no-context-files',
                        '--no-session',
                        '--no-tools',
                        '--no-mcp',
                    ],
                    {
                        cwd,
                        env: {
                            PATH: process.env.PATH,
                            HOME: cwd,
                            TMPDIR: cwd,
                            XDG_CACHE_HOME: join(cwd, 'cache'),
                            XDG_CONFIG_HOME: join(cwd, 'config'),
                            PI_CODING_AGENT_DIR: agentDir,
                            PI_OFFLINE: '1',
                            PI_SUBAGENT_CHILD_AGENT: 'cpa-cold-start-fixture',
                            CLIPROXY_BASE_URL: endpoint,
                            CLIPROXY_API_KEY: 'fixture-cpa-key',
                        },
                        stdin: 'pipe',
                        stdout: 'pipe',
                        stderr: 'pipe',
                    },
                );
                const stderr = new Response(child.stderr).text();
                const timeout = setTimeout(() => child.kill(), 15_000);
                const reader = child.stdout.getReader();
                try {
                    child.stdin.write(
                        `${JSON.stringify({ id: 'initial-state', type: 'get_state' })}\n`,
                    );
                    const decoder = new TextDecoder();
                    let pending = '';
                    let receivedState = false;
                    while (!receivedState) {
                        const { done, value } = await reader.read();
                        if (done)
                            throw new Error(
                                `Pi exited before reporting its initial state: ${await stderr}`,
                            );
                        pending += decoder.decode(value, { stream: true });
                        let newline: number;
                        while ((newline = pending.indexOf('\n')) !== -1) {
                            const line = pending.slice(0, newline);
                            pending = pending.slice(newline + 1);
                            if (!line.trim()) continue;
                            const response: unknown = JSON.parse(line);
                            if (
                                typeof response !== 'object' ||
                                response === null ||
                                !('id' in response) ||
                                response.id !== 'initial-state'
                            )
                                continue;
                            expect(response).toMatchObject({
                                type: 'response',
                                command: 'get_state',
                                success: true,
                                data: {
                                    model: { provider: 'cpa', id: modelId },
                                    messageCount: 0,
                                },
                            });
                            if (suffix)
                                expect(response).toMatchObject({
                                    data: { thinkingLevel: 'xhigh' },
                                });
                            receivedState = true;
                        }
                    }
                    child.stdin.end();
                    expect(await child.exited).toBe(0);
                    expect(await stderr).not.toContain('No model found');
                } finally {
                    clearTimeout(timeout);
                    reader.releaseLock();
                    if (child.exitCode === null) child.kill();
                    await child.exited;
                    await stderr;
                }
            }
            expect(requests).toEqual(['GET /v1/models', 'GET /v1/models']);
        } finally {
            stopServer();
            rmSync(root, { recursive: true, force: true });
        }
    },
    45_000,
);
