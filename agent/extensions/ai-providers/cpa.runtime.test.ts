import { expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const enabled = process.env.PI_CPA_AVAILABILITY_CONTRACT === '1';

test.skipIf(!enabled)(
    'public Pi catalog refresh withdraws and restores CPA without changing scoped preferences or generating',
    async () => {
        expect(process.env.GITHUB_ACTIONS).toBe('true');
        const previous = { ...process.env };
        const originalFetch = globalThis.fetch;
        const root = mkdtempSync(join(tmpdir(), 'pi-cpa-runtime-'));
        let session:
            | Awaited<
                  ReturnType<
                      (typeof import('@abdwhb-png/pi-test-harness'))['createTestSession']
                  >
              >
            | undefined;
        let status = 401;
        let entries = [{ id: 'gpt-fixture', owned_by: 'openai' }];
        let requests = 0;
        let stopServer = () => {};
        try {
            const server = Bun.serve({
                hostname: '127.0.0.1',
                port: 0,
                fetch(request) {
                    requests++;
                    if (new URL(request.url).pathname !== '/v1/models')
                        return new Response('Unexpected request', {
                            status: 404,
                        });
                    if (
                        request.headers.get('authorization') !==
                        'Bearer fixture-cpa-key'
                    )
                        return new Response('', { status: 401 });
                    return status === 200
                        ? Response.json({ data: entries })
                        : new Response('', { status });
                },
            });
            stopServer = () => {
                server.stop(true);
            };
            process.env.PI_CODING_AGENT_DIR = root;
            process.env.PI_OFFLINE = '1';
            process.env.CLIPROXY_API_KEY = 'fixture-cpa-key';
            process.env.CLIPROXY_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
            mkdirSync(join(root, 'config'));
            writeFileSync(
                join(root, 'config/ai-providers.json'),
                JSON.stringify({
                    providers: { cpa: true },
                    cpa: { refreshTtlMs: 0, silentCatalogDiff: true },
                }),
            );
            globalThis.fetch = Object.assign(
                async (
                    input: Parameters<typeof fetch>[0],
                    init?: Parameters<typeof fetch>[1],
                ) => {
                    const url =
                        input instanceof Request ? input.url : String(input);
                    if (
                        !url.startsWith(
                            `${process.env.CLIPROXY_BASE_URL}/models`,
                        )
                    )
                        throw new Error(
                            'Non-fixture network access is forbidden',
                        );
                    return await originalFetch(input, init);
                },
                { preconnect: originalFetch.preconnect },
            );
            const { createTestSession } =
                await import('@abdwhb-png/pi-test-harness');
            session = await createTestSession({
                cwd: root,
                extensions: [resolve(import.meta.dir, 'index.ts')],
            });
            const unexpectedGeneration = mock(() => {
                throw new Error(
                    'Provider generation is forbidden in this contract',
                );
            });
            session.session.agent.streamFunction = unexpectedGeneration;
            const available = () =>
                session!.session.modelRuntime
                    .getAvailableSnapshot()
                    .filter((model) => model.provider === 'cpa');
            const refresh = async () => {
                const result = await session!.session.modelRuntime.refresh({
                    providers: ['cpa'],
                    allowNetwork: true,
                    force: true,
                });
                expect(result.aborted).toBe(false);
                expect(result.errors.size).toBe(0);
            };
            expect(available()).toEqual([]);
            expect(session.session.modelRuntime.getModels('cpa')).toEqual([]);
            status = 200;
            await refresh();
            expect(available().map((model) => model.id)).toEqual([
                'gpt-fixture',
            ]);
            await session.session.setModel(available()[0]!);
            session.session.setScopedModels([{ model: available()[0]! }]);
            const scopedModels = session.session.scopedModels.map(
                ({ model }) => `${model.provider}/${model.id}`,
            );
            status = 401;
            await refresh();
            expect(available()).toEqual([]);
            expect(session.session.modelRuntime.getModels('cpa')).toEqual([]);
            expect(
                session.session.scopedModels.map(
                    ({ model }) => `${model.provider}/${model.id}`,
                ),
            ).toEqual(scopedModels);
            await session.session.prompt(
                'This request must be blocked before generation.',
            );
            expect(unexpectedGeneration).not.toHaveBeenCalled();
            status = 200;
            await refresh();
            expect(available().map((model) => model.id)).toEqual([
                'gpt-fixture',
            ]);
            entries = [];
            await refresh();
            expect(available()).toEqual([]);
            entries = [{ id: 'gpt-fixture', owned_by: 'openai' }];
            await session.session.prompt('/cpa-refresh');
            expect(available().map((model) => model.id)).toEqual([
                'gpt-fixture',
            ]);
            expect(
                session.session.scopedModels.map(
                    ({ model }) => `${model.provider}/${model.id}`,
                ),
            ).toEqual(scopedModels);
            expect(requests).toBeGreaterThanOrEqual(6);
            expect(unexpectedGeneration).not.toHaveBeenCalled();
        } finally {
            try {
                await session?.close();
            } finally {
                globalThis.fetch = originalFetch;
                process.env = previous;
                try {
                    stopServer();
                } finally {
                    rmSync(root, { recursive: true, force: true });
                }
            }
        }
    },
    30_000,
);
