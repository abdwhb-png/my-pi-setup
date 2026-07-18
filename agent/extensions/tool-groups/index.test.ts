import { describe, expect, it, mock } from 'bun:test';

// No module mock needed: createToolGroupsExtension accepts injected loadConfig,
// and importing index.ts involves no config I/O until the returned factory
// executes.  The transitive import chain (config.ts → config-loader.ts →
// @earendil-works/pi-coding-agent) resolves statically.
const { createToolGroupsExtension: createRuntimeToolGroupsExtension } =
    await import('./index.ts');

function createToolGroupsExtension(
    loadConfig: Parameters<typeof createRuntimeToolGroupsExtension>[0],
    loadRequestedTools: Parameters<
        typeof createRuntimeToolGroupsExtension
    >[1] = () => undefined,
): ReturnType<typeof createRuntimeToolGroupsExtension> {
    return createRuntimeToolGroupsExtension(loadConfig, loadRequestedTools);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MockHandler = (event: unknown, ctx: unknown) => unknown;

interface MockPi {
    on(event: string, handler: MockHandler): void;
    registerTool(tool: Record<string, unknown>): void;
    getActiveTools(): string[];
    getAllTools(): { name: string }[];
    setActiveTools(names: string[]): void;
    _handlers: Map<string, MockHandler>;
    _registeredTools: Record<string, unknown>[];
}

interface MockCtx {
    hasUI: boolean;
    ui: { notify: (...args: any[]) => void };
    mode: string;
    cwd: string;
    sessionManager: undefined;
    modelRegistry: undefined;
    model: undefined;
    isIdle: () => boolean;
    isProjectTrusted: () => boolean;
    signal: undefined;
    abort: () => void;
    hasPendingMessages: () => boolean;
    shutdown: () => void;
    getContextUsage: () => undefined;
    compact: () => void;
    getSystemPrompt: () => string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockPi(
    initialTools: string[] = ['read', 'edit', 'write'],
): MockPi {
    const handlers = new Map<string, MockHandler>();
    const registeredTools: Record<string, unknown>[] = [
        { name: 'read', description: '', parameters: {} },
        { name: 'edit', description: '', parameters: {} },
        { name: 'write', description: '', parameters: {} },
        { name: 'ls', description: '', parameters: {} },
        { name: 'bash', description: '', parameters: {} },
    ];
    let activeTools = [...initialTools];

    return {
        on(event: string, handler: MockHandler) {
            handlers.set(event, handler);
        },
        registerTool(tool: Record<string, unknown>) {
            registeredTools.push(tool);
        },
        getActiveTools: () => [...activeTools],
        getAllTools: () =>
            registeredTools.map((t) => ({ name: t.name as string })),
        setActiveTools: (names: string[]) => {
            activeTools = [...names];
        },

        _handlers: handlers,
        _registeredTools: registeredTools,
    };
}

function makeMockCtx(hasUI = false): MockCtx {
    const notify = mock<(msg: string, type?: string) => void>();
    return {
        hasUI,
        ui: { notify },
        mode: 'test',
        cwd: '/tmp',
        sessionManager: undefined,
        modelRegistry: undefined,
        model: undefined,
        isIdle: () => true,
        isProjectTrusted: () => true,
        signal: undefined,
        abort: () => {},
        hasPendingMessages: () => false,
        shutdown: () => {},
        getContextUsage: () => undefined,
        compact: () => {},
        getSystemPrompt: () => '',
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tool-groups extension', () => {
    it('registers one placeholder tool per group', () => {
        const pi = makeMockPi();
        const factory = createToolGroupsExtension(() => ({
            groups: { read: ['read', 'ls'], write: ['edit'] },
        }));
        factory(pi as never);

        const placeholders = pi._registeredTools.filter((t) =>
            (t.name as string).startsWith('@'),
        );
        expect(placeholders).toHaveLength(2);
        const names = placeholders.map((t) => t.name as string);
        expect(names).toContain('@read');
        expect(names).toContain('@write');
    });

    it('registers session_start, input, before_agent_start handlers', () => {
        const pi = makeMockPi();
        const factory = createToolGroupsExtension(() => ({
            groups: { read: ['read'] },
        }));
        factory(pi as never);

        expect(pi._handlers.has('session_start')).toBe(true);
        expect(pi._handlers.has('input')).toBe(true);
        expect(pi._handlers.has('before_agent_start')).toBe(true);
    });

    it('does nothing when groups config is empty', () => {
        const pi = makeMockPi();
        const factory = createToolGroupsExtension(
            () => ({ groups: {} }),
            () => undefined,
        );
        factory(pi as never);

        const placeholders = pi._registeredTools.filter((t) =>
            (t.name as string).startsWith('@'),
        );
        expect(placeholders).toHaveLength(0);
        expect(pi._handlers.has('session_start')).toBe(false);
    });

    it('fails closed when a deferred alias has no configured group', () => {
        const pi = makeMockPi(['read', 'edit', 'write']);
        const factory = createToolGroupsExtension(
            () => ({ groups: {} }),
            () => ['@missing'],
        );
        factory(pi as never);

        const handler = pi._handlers.get('session_start')!;
        handler({ type: 'session_start', reason: 'startup' }, makeMockCtx());

        expect(pi.getActiveTools()).toEqual([]);
    });

    it('expands @read alias on session_start', () => {
        const pi = makeMockPi(['@read', 'edit']);
        const factory = createToolGroupsExtension(() => ({
            groups: { read: ['read', 'ls'] },
        }));
        factory(pi as never);

        const handler = pi._handlers.get('session_start')!;
        handler({ type: 'session_start', reason: 'startup' }, makeMockCtx());

        const active = pi.getActiveTools();
        expect(active).toContain('read');
        expect(active).toContain('ls');
        expect(active).toContain('edit');
        expect(active).not.toContain('@read');
    });

    it('intersects deferred CLI aliases with earlier session_start restrictions', () => {
        const pi = makeMockPi(['read']);
        const factory = createToolGroupsExtension(
            () => ({ groups: { inspect: ['read', 'write'] } }),
            () => ['@inspect'],
        );
        factory(pi as never);

        const handler = pi._handlers.get('session_start')!;
        handler({ type: 'session_start', reason: 'startup' }, makeMockCtx());

        expect(pi.getActiveTools()).toEqual(['read']);
    });

    it("input handler expands and returns {action:'continue'}", () => {
        const pi = makeMockPi(['@read']);
        const factory = createToolGroupsExtension(() => ({
            groups: { read: ['read', 'ls'] },
        }));
        factory(pi as never);

        const handler = pi._handlers.get('input')!;
        const result = handler(
            { type: 'input', text: 'hello', source: 'interactive' },
            makeMockCtx(),
        );

        expect(result).toEqual({ action: 'continue' });

        const active = pi.getActiveTools();
        expect(active).toContain('read');
        expect(active).toContain('ls');
    });

    it('before_agent_start handler expands aliases', () => {
        const pi = makeMockPi(['@read']);
        const factory = createToolGroupsExtension(() => ({
            groups: { read: ['read', 'ls'] },
        }));
        factory(pi as never);

        const handler = pi._handlers.get('before_agent_start')!;
        handler({ type: 'before_agent_start', prompt: 'test' }, makeMockCtx());

        const active = pi.getActiveTools();
        expect(active).toContain('read');
        expect(active).toContain('ls');
    });

    it('no-op when active tools have no @ alias', () => {
        const pi = makeMockPi(['read', 'edit']);
        const factory = createToolGroupsExtension(() => ({
            groups: { read: ['read', 'ls'] },
        }));
        factory(pi as never);

        const before = pi.getActiveTools();
        const handler = pi._handlers.get('session_start')!;
        handler({ type: 'session_start', reason: 'startup' }, makeMockCtx());

        expect(pi.getActiveTools()).toEqual(before);
    });

    it('placeholder tool execute throws unexpanded error synchronously', () => {
        const pi = makeMockPi();
        const factory = createToolGroupsExtension(() => ({
            groups: { read: ['read'] },
        }));
        factory(pi as never);

        const readTool = pi._registeredTools.find(
            (t) => (t.name as string) === '@read',
        );
        expect(readTool).toBeDefined();

        expect(() =>
            (readTool as Record<string, (...args: unknown[]) => void>).execute(
                'call-1',
                {},
                undefined,
                undefined,
                makeMockCtx(),
            ),
        ).toThrow(/group alias/);
    });

    it('deduplicates and re-emits diagnostics', () => {
        const pi = makeMockPi(['@missing-a']);
        const notify = mock<(msg: string, type?: string) => void>();
        const factory = createToolGroupsExtension(() => ({
            groups: { read: ['read'] },
        }));
        factory(pi as never);

        const handler = pi._handlers.get('session_start')!;
        const ctx = { ...makeMockCtx(true), ui: { notify } };

        // 1. First call → missing-group for @missing-a
        handler({ type: 'session_start', reason: 'startup' }, ctx);
        expect(notify).toHaveBeenCalledTimes(1);

        // 2. Reset alias, call again with same diag → dedup (no new notification)
        pi.setActiveTools(['@missing-a']);
        handler({ type: 'session_start', reason: 'startup' }, ctx);
        expect(notify).toHaveBeenCalledTimes(1);

        // 3. Reset to different alias → different diagnostic → re-emit
        pi.setActiveTools(['@missing-b']);
        handler({ type: 'session_start', reason: 'startup' }, ctx);
        expect(notify).toHaveBeenCalledTimes(2);
        expect(
            (notify as unknown as { mock: { calls: Array<[string]> } }).mock
                .calls[1][0],
        ).toContain('missing-b');
    });

    it('placeholder tools have empty schema and no promptSnippet', () => {
        const pi = makeMockPi();
        const factory = createToolGroupsExtension(() => ({
            groups: { read: ['read'] },
        }));
        factory(pi as never);

        const tool = pi._registeredTools.find(
            (t) => (t.name as string) === '@read',
        );
        expect(tool).toBeDefined();
        expect(tool!.promptSnippet).toBeUndefined();
        expect(tool!.promptGuidelines).toBeUndefined();
        expect((tool!.parameters as { type: string }).type).toBe('object');
    });

    it('session_start handler runs drift check without throwing', () => {
        const pi = makeMockPi(['@read']);
        const warn = mock<(msg: string) => void>();
        const origWarn = console.warn;
        console.warn = warn;
        try {
            const factory = createToolGroupsExtension(() => ({
                groups: { read: ['read'] },
            }));
            factory(pi as never);

            const handler = pi._handlers.get('session_start')!;
            // Should not throw even if settings are incomplete or drift is absent.
            expect(() =>
                handler(
                    { type: 'session_start', reason: 'startup' },
                    makeMockCtx(),
                ),
            ).not.toThrow();
        } finally {
            console.warn = origWarn;
        }
    });
});
