/**
 * Tests for models-dev.ts — the shared models.dev lifecycle integration.
 *
 * Covers:
 *   - session_start awaits disk load + all cached provider projections, then
 *     starts the stale network check without awaiting it
 *   - only an `updated` automatic refresh result reprojects providers
 *   - input starts the same background freshness path and returns continue
 *     synchronously
 *   - concurrent freshness checks coalesce into one network request
 *   - failures preserve providers and warn once (deduplicated)
 *   - manual /models-dev-refresh forces, awaits all projections, reports a
 *     sanitized status, and resets the warning state after success
 */

import { describe, expect, it, mock } from 'bun:test';
import type {
    ModelsDevCatalog,
    ModelsDevCatalogStatus,
    ModelsDevRefreshResult,
} from '../_shared/models-dev/catalog';
import type { ProviderProjectionHandle } from './models-dev';
import { registerModelsDevIntegration } from './models-dev';

// ── Harness ──

type RefreshImpl = () => Promise<ModelsDevRefreshResult>;

function makeStatus(stale = true): ModelsDevCatalogStatus {
    return {
        provenance: 'cache',
        fetchedAt: 1_700_000_000_000,
        etag: null,
        stale,
        providerCount: 1,
        baseCount: 1,
    };
}

function makeCatalog(initialRefreshImpl: RefreshImpl) {
    const state = {
        status: makeStatus(true),
        loadCalls: 0,
        refreshCalls: 0,
        refreshOptions: [] as Array<{ force?: boolean } | undefined>,
        order: [] as string[],
        refreshImpl: initialRefreshImpl,
    };
    const catalog = {
        load: mock(async () => {
            state.loadCalls++;
            state.order.push('load');
            return state.status;
        }),
        refresh: mock(async (options?: { force?: boolean }) => {
            state.refreshCalls++;
            state.refreshOptions.push(options);
            state.order.push('refresh');
            return state.refreshImpl();
        }),
        getStatus: () => state.status,
        lookupFirst: () => undefined,
    } as unknown as ModelsDevCatalog;
    return { catalog, state };
}

function makeRefreshers(): Array<ProviderProjectionHandle & { name: string }> {
    return [
        {
            providerId: 'proj-a',
            name: 'proj-a',
            refreshProjection: mock(async () => {}),
        },
        {
            providerId: 'proj-b',
            name: 'proj-b',
            refreshProjection: mock(async () => {}),
        },
    ];
}

function makeHarness(refreshImpl: RefreshImpl) {
    const { catalog, state } = makeCatalog(refreshImpl);
    const refreshers = makeRefreshers();
    for (const r of refreshers) {
        (r.refreshProjection as ReturnType<typeof mock>).mockImplementation(
            async () => {
                state.order.push(r.name);
            },
        );
    }
    const getRefreshers = mock(() => refreshers);
    const handlers: Array<{
        event: string;
        handler: (...args: unknown[]) => unknown;
    }> = [];
    const commands: Array<{
        name: string;
        handler: (...args: unknown[]) => unknown;
    }> = [];
    const pi = {
        on: (event: string, handler: (...args: unknown[]) => unknown) => {
            handlers.push({ event, handler });
        },
        registerCommand: (
            name: string,
            options: { handler: (...args: unknown[]) => unknown },
        ) => {
            commands.push({ name, handler: options.handler });
        },
    } as never;

    registerModelsDevIntegration(pi, catalog, getRefreshers);

    return {
        catalog,
        state,
        refreshers,
        getRefreshers,
        handlers,
        commands,
        sessionStart: handlers.find((h) => h.event === 'session_start')!,
        input: handlers.find((h) => h.event === 'input')!,
        refreshCommand: commands.find((c) => c.name === 'models-dev-refresh')!,
    };
}

function uiCtx(notify: ReturnType<typeof mock> = mock(() => {})) {
    return {
        cwd: '/workspace',
        hasUI: true,
        ui: { notify },
        modelRegistry: {},
    };
}

function headlessCtx() {
    return { cwd: '/workspace', hasUI: false, ui: {}, modelRegistry: {} };
}

const pendingRefresh = (): {
    promise: Promise<ModelsDevRefreshResult>;
    resolve: (r: ModelsDevRefreshResult) => void;
} => {
    let resolve!: (r: ModelsDevRefreshResult) => void;
    const promise = new Promise<ModelsDevRefreshResult>((res) => {
        resolve = res;
    });
    return { promise, resolve };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── session_start ──

describe('registerModelsDevIntegration session_start', () => {
    it('awaits disk load and cached projections before returning, then starts stale network without awaiting it', async () => {
        const pending = pendingRefresh();
        const h = makeHarness(() => pending.promise);
        const ctx = uiCtx();

        await h.sessionStart.handler({}, ctx);

        // Load and projections completed before the handler returned…
        expect(h.state.loadCalls).toBe(1);
        expect(h.refreshers[0].refreshProjection).toHaveBeenCalledTimes(1);
        expect(h.refreshers[1].refreshProjection).toHaveBeenCalledTimes(1);
        // …while the stale network refresh was started but not awaited: the
        // handler resolved although the refresh promise is still pending.
        expect(h.state.refreshCalls).toBe(1);
        expect(h.state.order).toEqual([
            'load',
            'proj-a',
            'proj-b',
            'refresh',
        ]);

        // Settling the network check with `updated` reprojects all providers.
        pending.resolve({ status: 'updated', catalog: h.state.status });
        await flush();
        expect(h.refreshers[0].refreshProjection).toHaveBeenCalledTimes(2);
        expect(h.refreshers[1].refreshProjection).toHaveBeenCalledTimes(2);
    });

    it('does not reproject when the automatic refresh reports fresh, not-modified, or failed', async () => {
        for (const status of ['fresh', 'not-modified', 'failed'] as const) {
            const h = makeHarness(() =>
                Promise.resolve({
                    status,
                    catalog: h.state.status,
                    ...(status === 'failed' ? { error: 'HTTP 500' } : {}),
                }),
            );
            const notify = mock(() => {});
            await h.sessionStart.handler({}, uiCtx(notify));
            await flush();

            expect(h.refreshers[0].refreshProjection, status).toHaveBeenCalledTimes(
                1,
            );
            expect(h.refreshers[1].refreshProjection, status).toHaveBeenCalledTimes(
                1,
            );
        }
    });

    it('reports startup projection failures and resets after complete recovery', async () => {
        const h = makeHarness(() =>
            Promise.resolve({ status: 'fresh', catalog: h.state.status }),
        );
        const notify = mock(() => {});
        const ctx = uiCtx(notify);
        const second = h.refreshers[1].refreshProjection as ReturnType<typeof mock>;
        second.mockImplementation(async () => {
            throw new Error('private startup failure');
        });

        await h.sessionStart.handler({}, ctx);
        await flush();
        expect(h.refreshers[0].refreshProjection).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith(expect.stringContaining('proj-b'), 'warning');
        expect(String((notify.mock.calls as unknown[][])[0]?.[0])).not.toContain(
            'private',
        );

        second.mockImplementation(async () => {});
        await h.sessionStart.handler({}, ctx);
        await flush();

        second.mockImplementation(async () => {
            throw new Error('private startup failure');
        });
        await h.sessionStart.handler({}, ctx);
        await flush();
        expect(notify).toHaveBeenCalledTimes(2);
    });

    it('warns once when the automatic refresh fails', async () => {
        const h = makeHarness(() =>
            Promise.resolve({
                status: 'failed',
                catalog: h.state.status,
                error: 'HTTP 500',
            }),
        );
        const notify = mock(() => {});
        await h.sessionStart.handler({}, uiCtx(notify));
        await flush();

        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith(
            expect.stringContaining('indisponible'),
            'warning',
        );
    });
});

// ── input ──

describe('registerModelsDevIntegration input', () => {
    it('starts the background freshness path and returns continue immediately', async () => {
        const pending = pendingRefresh();
        const h = makeHarness(() => pending.promise);

        const result = await h.input.handler({ text: 'hi' }, uiCtx());

        expect(result).toEqual({ action: 'continue' });
        expect(h.state.refreshCalls).toBe(1);
        expect(h.refreshers[0].refreshProjection).not.toHaveBeenCalled();
    });

    it('does not hit the network when the catalog snapshot is not stale', async () => {
        const h = makeHarness(() => Promise.resolve({ status: 'fresh', catalog: h.state.status }));
        h.state.status = makeStatus(false);

        const result = await h.input.handler({ text: 'hi' }, uiCtx());

        expect(result).toEqual({ action: 'continue' });
        expect(h.state.refreshCalls).toBe(0);
    });

    it('coalesces concurrent freshness checks into one refresh', async () => {
        const pending = pendingRefresh();
        const h = makeHarness(() => pending.promise);
        const ctx = uiCtx();

        await h.input.handler({ text: 'one' }, ctx);
        await h.input.handler({ text: 'two' }, ctx);

        expect(h.state.refreshCalls).toBe(1);

        pending.resolve({ status: 'updated', catalog: h.state.status });
        await flush();
        // The coalesced check still reprojects exactly once.
        expect(h.refreshers[0].refreshProjection).toHaveBeenCalledTimes(1);
    });

    it('deduplicates partial projection warnings until every provider succeeds', async () => {
        const h = makeHarness(() =>
            Promise.resolve({ status: 'updated', catalog: h.state.status }),
        );
        const notify = mock(() => {});
        const ctx = uiCtx(notify);
        const second = h.refreshers[1].refreshProjection as ReturnType<typeof mock>;
        second.mockImplementation(async () => {
            throw new Error('private backend detail');
        });

        await h.input.handler({ text: 'one' }, ctx);
        await flush();
        await h.input.handler({ text: 'two' }, ctx);
        await flush();
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith(expect.stringContaining('proj-b'), 'warning');

        second.mockImplementation(async () => {});
        await h.input.handler({ text: 'recovered' }, ctx);
        await flush();

        second.mockImplementation(async () => {
            throw new Error('private backend detail');
        });
        await h.input.handler({ text: 'later failure' }, ctx);
        await flush();
        expect(notify).toHaveBeenCalledTimes(2);
    });

    it('preserves providers and warns once across repeated failures', async () => {
        let failures = 0;
        const h = makeHarness(() => {
            failures++;
            return Promise.reject(new Error('network down'));
        });
        const notify = mock(() => {});
        const ctx = uiCtx(notify);

        await h.input.handler({ text: 'one' }, ctx);
        await flush();
        await h.input.handler({ text: 'two' }, ctx);
        await flush();

        expect(failures).toBe(2); // each input retried
        expect(h.refreshers[0].refreshProjection).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith(
            expect.stringContaining('indisponible'),
            'warning',
        );
    });

    it('falls back to console.warn when the UI is unavailable', async () => {
        const h = makeHarness(() =>
            Promise.resolve({
                status: 'failed',
                catalog: h.state.status,
                error: 'boom',
            }),
        );
        const warn = mock(() => {});
        const originalWarn = console.warn;
        console.warn = warn;
        try {
            await h.input.handler({ text: 'hi' }, headlessCtx());
            await flush();
        } finally {
            console.warn = originalWarn;
        }

        expect(warn).toHaveBeenCalledTimes(1);
        expect(String((warn.mock.calls as unknown[][])[0]?.[0])).toContain(
            'indisponible',
        );
    });
});

// ── /models-dev-refresh ──

describe('registerModelsDevIntegration refresh command', () => {
    it('forces the refresh, awaits all projections, and reports a sanitized status', async () => {
        const h = makeHarness(() =>
            Promise.resolve({
                status: 'updated',
                catalog: h.state.status,
            }),
        );
        const notify = mock(() => {});
        const ctx = uiCtx(notify);

        await h.refreshCommand.handler('', ctx);

        expect(h.state.refreshOptions).toEqual([{ force: true }]);
        expect(h.refreshers[0].refreshProjection).toHaveBeenCalledTimes(1);
        expect(h.refreshers[1].refreshProjection).toHaveBeenCalledTimes(1);
        // Sanitized: only the status vocabulary, never raw error text.
        expect(notify).toHaveBeenCalledWith(
            expect.stringContaining('actualisé'),
            'info',
        );
        expect(String((notify.mock.calls as unknown[][])[0]?.[0])).not.toMatch(
            /HTTP|boom|error/i,
        );
    });

    it('reports partial success when one provider projection fails', async () => {
        const h = makeHarness(() =>
            Promise.resolve({
                status: 'updated',
                catalog: h.state.status,
            }),
        );
        h.refreshers[1].refreshProjection = mock(async () => {
            throw new Error('secret provider backend exploded');
        });
        const notify = mock(() => {});

        await h.refreshCommand.handler('', uiCtx(notify));

        expect(h.refreshers[0].refreshProjection).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith(
            expect.stringContaining('proj-b'),
            'warning',
        );
        const message = String((notify.mock.calls as unknown[][])[0]?.[0]);
        expect(message).not.toContain('secret');
        expect(message).not.toContain('exploded');
        expect(message).not.toContain('actualisé');
    });

    it('reports a sanitized failure status while still awaiting projections', async () => {
        const h = makeHarness(() =>
            Promise.resolve({
                status: 'failed',
                catalog: h.state.status,
                error: 'HTTP 500 backend exploded',
            }),
        );
        const notify = mock(() => {});
        const ctx = uiCtx(notify);

        await h.refreshCommand.handler('', ctx);

        expect(h.refreshers[0].refreshProjection).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith(
            expect.stringContaining('indisponible'),
            'warning',
        );
        const message = String((notify.mock.calls as unknown[][])[0]?.[0]);
        expect(message).not.toContain('HTTP 500');
        expect(message).not.toContain('exploded');
    });

    it('resets the warning state after a successful refresh', async () => {
        let fail = true;
        const h = makeHarness(() =>
            fail
                ? Promise.reject(new Error('down'))
                : Promise.resolve({ status: 'updated', catalog: h.state.status }),
        );
        const notify = mock(() => {});
        const ctx = uiCtx(notify);

        // Background failure warns once.
        await h.input.handler({ text: 'one' }, ctx);
        await flush();
        expect(notify).toHaveBeenCalledTimes(1);

        // Manual refresh succeeds and resets the warning state.
        fail = false;
        await h.refreshCommand.handler('', ctx);
        expect(notify).toHaveBeenCalledWith(
            expect.stringContaining('actualisé'),
            'info',
        );

        // A later background failure warns again (dedup state was reset).
        fail = true;
        await h.input.handler({ text: 'two' }, ctx);
        await flush();
        const warnings = (notify.mock.calls as unknown[][])
            .map((c) => c[1])
            .filter((level) => level === 'warning');
        expect(warnings.length).toBe(2);
    });
});
