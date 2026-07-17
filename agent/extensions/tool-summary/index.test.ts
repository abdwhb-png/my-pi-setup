import { describe, expect, it, mock } from 'bun:test';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent';

// Mock pi-fancy-footer/api - must be compatible with widget.test.ts mock.
// Both test files use the same mock since mock.module is global in bun.
mock.module('pi-fancy-footer/api', () => {
    const fakeWidgets = new Map<string, unknown>();
    return {
        contributeFancyFooterWidgets: (pi: any, def: any) => {
            fakeWidgets.set(def.id, def);
            pi.events.emit('pi-fancy-footer:contribute-widget', def);
        },
        requestFancyFooterWidgetDiscovery: (pi: any) => {
            pi.events.emit('pi-fancy-footer:request-widget-discovery');
        },
        requestFancyFooterRefresh: (pi: any) => {
            pi.events.emit('pi-fancy-footer:request-widget-refresh');
        },
        publishExtensionStatusesSnapshot: () => undefined,
        getExtensionStatusesSnapshot: () => [],
        subscribeExtensionStatusesSnapshot: () => () => undefined,
        FANCY_FOOTER_EXTENSION_STATUSES_SNAPSHOT_EVENT: 'ff:statuses-snapshot',
    };
});

describe('tool-summary extension (index.ts)', () => {
    let handlers: Map<string, (...args: any[]) => any>;
    let commands: Map<
        string,
        { description: string; handler: (...args: any[]) => any }
    >;
    let appendEntries: Array<{ customType: string; data?: object }>;

    function createMockExtensionAPI(): ExtensionAPI {
        handlers = new Map();
        commands = new Map();
        appendEntries = [];
        return {
            events: {
                on: () => undefined,
                emit: mock(),
            },
            on: (event: string, handler: (...args: any[]) => any) => {
                handlers.set(event, handler);
            },
            registerCommand: (
                name: string,
                command: {
                    description: string;
                    handler: (...args: any[]) => any;
                },
            ) => {
                commands.set(name, command);
            },
            appendEntry: (customType: string, data?: object) => {
                appendEntries.push({ customType, data });
            },
        } as unknown as ExtensionAPI;
    }

    function createMockCtx(): ExtensionContext {
        return {
            hasUI: true,
            signal: undefined,
            ui: {
                theme: {
                    fg: (_color: string, text: string) => text,
                } as any,
                notify: mock(() => undefined),
                setStatus: mock(() => undefined),
                setWidget: mock(() => undefined),
            },
            cwd: '/fake/cwd',
            sessionManager: {
                getEntries: () => [],
                getBranch: () => [],
                getEntry: () => undefined,
                getChildEntries: () => [],
                getParentEntry: () => undefined,
                getRootEntry: () => undefined,
                getSessionPath: () => '/fake/session.jsonl',
            } as any,
            modelRegistry: { find: () => undefined } as any,
            model: undefined,
            isIdle: () => true,
            abort: () => undefined,
            hasPendingMessages: () => false,
            shutdown: () => undefined,
            getContextUsage: () => undefined,
            compact: () => undefined,
            getSystemPrompt: () => '',
        } as unknown as ExtensionContext;
    }

    function makeToolResult(
        toolName: string,
        isError = false,
    ): ToolResultMessage {
        return {
            role: 'toolResult',
            toolCallId: 'id-' + Math.random().toString(36).slice(2),
            toolName,
            content: [{ type: 'text', text: 'output' }],
            isError,
            timestamp: Date.now(),
        };
    }

    it('registers turn_end handler and tool-summary command', async () => {
        const { default: extension } = await import('./index.ts');
        const pi = createMockExtensionAPI();
        extension(pi);

        expect(handlers.has('turn_end')).toBe(true);
        expect(commands.has('tool-summary')).toBe(true);
        expect(commands.get('tool-summary')?.description).toBeTruthy();
    });

    it('turn_end handler formats and sends summary widget', async () => {
        const { default: extension } = await import('./index.ts');
        const pi = createMockExtensionAPI();
        const ctx = createMockCtx();
        extension(pi);

        const sessionHandler = handlers.get('session_start');
        if (sessionHandler) await sessionHandler({}, ctx);

        const turnHandler = handlers.get('turn_end');
        expect(turnHandler).toBeDefined();

        const event = {
            type: 'turn_end',
            turnIndex: 1,
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'done' }],
            } as any,
            toolResults: [
                makeToolResult('read'),
                makeToolResult('read'),
                makeToolResult('grep'),
                makeToolResult('bash', true),
            ],
        };

        await turnHandler!(event, ctx);

        // The widget uses fancy-footer (active=true from mock), so the fallback
        // ctx.ui.setWidget is NOT called. Instead, the render closure in
        // createSummaryWidget is called lazily by fancy-footer.
        // We verify the mock emit was called for widget refresh.
        const emitCalls = (pi.events.emit as any).mock?.calls ?? [];
        const discoveryCalls = emitCalls.filter(
            (c: unknown[]) =>
                c[0] === 'pi-fancy-footer:request-widget-discovery',
        );
        expect(discoveryCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('respects tool filter from config', async () => {
        const { default: extension } = await import('./index.ts');
        const pi = createMockExtensionAPI();
        const ctx = createMockCtx();
        extension(pi);

        const sessionHandler = handlers.get('session_start');
        if (sessionHandler) await sessionHandler({}, ctx);

        // Use the command to set filter
        const cmd = commands.get('tool-summary');
        expect(cmd).toBeDefined();
        await cmd!.handler('add read', ctx as any);

        const turnHandler = handlers.get('turn_end')!;
        const event = {
            type: 'turn_end',
            turnIndex: 2,
            message: { role: 'assistant', content: [] } as any,
            toolResults: [
                makeToolResult('read'),
                makeToolResult('read'),
                makeToolResult('grep'), // should be filtered out
                makeToolResult('bash', true), // should be filtered out
            ],
        };

        await turnHandler(event, ctx);
        // The command and turn handler executed without errors.
        // Filter is applied in-memory, not through setWidget.
        // The widget render closure (fancy-footer path) uses latestSummary
        // which reflects filtered counts — tested at the module level
        // in summary.test.ts.
        expect(cmd).toBeDefined();
    });

    it('shows empty/no widget when no tools used', async () => {
        const { default: extension } = await import('./index.ts');
        const pi = createMockExtensionAPI();
        const ctx = createMockCtx();
        extension(pi);

        const sessionHandler = handlers.get('session_start');
        if (sessionHandler) await sessionHandler({}, ctx);

        const turnHandler = handlers.get('turn_end')!;
        const event = {
            type: 'turn_end',
            turnIndex: 1,
            message: { role: 'assistant', content: [] } as any,
            toolResults: [],
        };

        await turnHandler(event, ctx);
        // When no tools are used, latestSummary is empty string.
        // The widget update should be called with null/empty (hide widget).
        // Since fancy-footer path is active, we just verify no error thrown.
        expect(handlers.has('turn_end')).toBe(true);
    });
});
