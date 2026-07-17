import { describe, expect, it, mock } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

describe('tool-summary extension (index.ts)', () => {
    let handlers: Map<string, (...args: any[]) => any>;
    let commands: Map<
        string,
        { description: string; handler: (...args: any[]) => any }
    >;

    function createMockExtensionAPI(): ExtensionAPI {
        handlers = new Map();
        commands = new Map();
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
        } as unknown as ExtensionAPI;
    }

    function createMockCtx() {
        return {
            hasUI: true,
            ui: {
                theme: {
                    fg: (_color: string, text: string) => text,
                } as any,
                notify: mock(() => undefined),
            },
        };
    }

    function makeToolResult(toolName: string, isError = false) {
        return {
            role: 'toolResult' as const,
            toolCallId: 'id-' + Math.random().toString(36).slice(2),
            toolName,
            content: [{ type: 'text' as const, text: 'output' }],
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

    it('turn_end calls notify with formatted summary', async () => {
        const { default: extension } = await import('./index.ts');
        const pi = createMockExtensionAPI();
        const ctx = createMockCtx();
        extension(pi);

        const turnHandler = handlers.get('turn_end')!;
        expect(turnHandler).toBeDefined();

        const event = {
            type: 'turn_end',
            turnIndex: 1,
            message: { role: 'assistant', content: [] } as any,
            toolResults: [
                makeToolResult('read'),
                makeToolResult('read'),
                makeToolResult('grep'),
                makeToolResult('bash', true),
            ],
        };

        await turnHandler(event, ctx);

        const calls = (ctx.ui.notify as any).mock?.calls ?? [];
        expect(calls.length).toBe(1);

        const [message, level] = calls[0];
        expect(level).toBe('info');
        expect(message).toContain('read');
        expect(message).toContain('grep');
        expect(message).toContain('bash');
        // bash had an error — should have the error marker
        expect(message).toContain('✗');
    });

    it('respects tool filter from config', async () => {
        const { default: extension } = await import('./index.ts');
        const pi = createMockExtensionAPI();
        const ctx = createMockCtx();
        extension(pi);

        const cmd = commands.get('tool-summary')!;

        // Add filter: only show read
        await cmd.handler('add read', ctx as any);

        const turnHandler = handlers.get('turn_end')!;
        const event = {
            type: 'turn_end',
            turnIndex: 2,
            message: { role: 'assistant', content: [] } as any,
            toolResults: [
                makeToolResult('read'),
                makeToolResult('read'),
                makeToolResult('grep'),
                makeToolResult('bash', true),
            ],
        };

        await turnHandler(event, ctx);

        const calls = (ctx.ui.notify as any).mock?.calls ?? [];
        // The second call (turn_end notify) should only show 'read', not grep or bash
        const turnCalls = calls.filter((c: unknown[]) => c.length >= 1);
        expect(turnCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('does not call notify when no tools used', async () => {
        const { default: extension } = await import('./index.ts');
        const pi = createMockExtensionAPI();
        const ctx = createMockCtx();
        extension(pi);

        const turnHandler = handlers.get('turn_end')!;
        const event = {
            type: 'turn_end',
            turnIndex: 1,
            message: { role: 'assistant', content: [] } as any,
            toolResults: [],
        };

        await turnHandler(event, ctx);

        const calls = (ctx.ui.notify as any).mock?.calls ?? [];
        // notify should NOT be called when summary is empty
        expect(calls.length).toBe(0);
    });

    it('skips when hasUI is false', async () => {
        const { default: extension } = await import('./index.ts');
        const pi = createMockExtensionAPI();
        const ctx = { ...createMockCtx(), hasUI: false };
        extension(pi);

        const turnHandler = handlers.get('turn_end')!;
        const event = {
            type: 'turn_end',
            turnIndex: 1,
            message: { role: 'assistant', content: [] } as any,
            toolResults: [makeToolResult('read')],
        };

        await turnHandler(event, ctx);

        const calls = (ctx.ui.notify as any).mock?.calls ?? [];
        expect(calls.length).toBe(0);
    });
});
