import { describe, expect, it, mock } from 'bun:test';

// Stub heavy deps so the factory loads cleanly outside the pi runtime.
// pi-ai is mocked globally via __tests__/setup.ts preload.
mock.module('pi-fancy-footer/api', () => ({
    contributeFancyFooterWidgets: mock(),
    requestFancyFooterWidgetDiscovery: mock(),
    requestFancyFooterRefresh: mock(),
    publishExtensionStatusesSnapshot: mock(),
    getExtensionStatusesSnapshot: mock(() => []),
    subscribeExtensionStatusesSnapshot: mock(() => () => undefined),
    FANCY_FOOTER_EXTENSION_STATUSES_SNAPSHOT_EVENT: 'fancy-footer:statuses',
}));

const { default: factory } = await import('./index.ts');

function mockPi() {
    const commands = new Map<
        string,
        { handler: (a: string, ctx: any) => Promise<void> }
    >();
    const handlers = new Map<string, Array<(e: any, ctx: any) => any>>();
    const pi: any = {
        on: mock((event: string, handler: any) => {
            handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        }),
        registerCommand: mock((name: string, def: any) =>
            commands.set(name, def),
        ),
    };
    return { pi, commands, handlers };
}

function mockCtx() {
    return {
        hasUI: true,
        ui: {
            notify: mock(),
            setWidget: mock(),
            setStatus: mock(),
            theme: { fg: mock((_scope: string, s: string) => s) },
        },
        model: undefined,
        modelRegistry: {
            find: mock().mockReturnValue({
                provider: 'openai',
                id: 'gpt-5-nano',
            }),
            getApiKeyAndHeaders: mock().mockResolvedValue({
                ok: false,
                error: 'no key',
            }),
        },
    } as any;
}

describe('auto-translate factory', () => {
    it('default export is a function', () => {
        expect(typeof factory).toBe('function');
    });

    it('registers all commands + binds input + session handlers', () => {
        const { pi, commands, handlers } = mockPi();
        factory(pi);
        expect(commands.has('translate-on')).toBe(true);
        expect(commands.has('translate-off')).toBe(true);
        expect(commands.has('translate-send')).toBe(true);
        expect(commands.has('translate-to-en')).toBe(true);
        expect(handlers.has('input')).toBe(true);
        expect(handlers.has('session_start')).toBe(true);
        expect(handlers.has('session_shutdown')).toBe(true);
    });

    it('input handler passes through when disabled', async () => {
        const { pi, handlers } = mockPi();
        factory(pi);
        const inputHandler = handlers.get('input')![0];
        const out = await inputHandler(
            { text: 'bonjour', source: 'user' },
            mockCtx(),
        );
        expect(out).toEqual({ action: 'continue' });
    });

    it('input handler skips extension-injected messages', async () => {
        const { pi, handlers } = mockPi();
        factory(pi);
        const inputHandler = handlers.get('input')![0];
        const out = await inputHandler(
            { text: 'x', source: 'extension' },
            mockCtx(),
        );
        expect(out).toEqual({ action: 'continue' });
    });

    it('input handler shows translating status then clears it', async () => {
        const { pi, commands, handlers } = mockPi();
        factory(pi);
        // Enable translation via the registered command so the input handler runs.
        await commands.get('translate-on')!.handler('', mockCtx());
        const inputHandler = handlers.get('input')![0];
        const ctx = mockCtx();
        // ctx.model set so effectiveModel resolves; modelRegistry.find returns a
        // model but auth fails -> translate() returns null -> pass-through.
        // Status lifecycle must run regardless.
        ctx.model = { provider: 'openai', id: 'gpt-5-nano' };
        const out = await inputHandler(
            { text: 'bonjour', source: 'user' },
            ctx,
        );
        // translate() returns null (auth failed) so pass-through,
        // but the status lifecycle must run regardless.
        expect(out).toEqual({ action: 'continue' });
        expect(ctx.ui.setStatus).toHaveBeenCalledWith(
            'auto-translate',
            expect.stringContaining('translating'),
        );
        expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
            'auto-translate',
            undefined,
        );
    });
});
