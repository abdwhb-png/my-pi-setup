import { describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
    type AgentRunSummaryPayload,
    TOOL_SUMMARY_EVENT,
} from '../_shared/agent-run-summary.ts';

describe('tool-summary extension (index.ts)', () => {
    let handlers: Map<string, (...args: any[]) => any>;
    let commands: Map<
        string,
        { description: string; handler: (...args: any[]) => any }
    >;
    let emittedEvents: Array<{ channel: string; payload: unknown }>;

    function createMockExtensionAPI(): ExtensionAPI {
        handlers = new Map();
        commands = new Map();
        emittedEvents = [];
        return {
            events: {
                on: () => () => undefined,
                emit: (channel: string, payload: unknown) => {
                    emittedEvents.push({ channel, payload });
                },
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

    function createMockCtx(cwd = '/fake/cwd') {
        return {
            cwd,
            hasUI: true,
            ui: {
                theme: {
                    fg: (_color: string, text: string) => text,
                } as any,
                notify: mock(() => undefined),
            },
        };
    }

    function makeToolResultEvent(toolName: string, isError = false) {
        return {
            type: 'tool_result',
            toolCallId: 'id-' + Math.random().toString(36).slice(2),
            toolName,
            input: {},
            content: [{ type: 'text', text: 'output' }],
            details: undefined,
            isError,
        };
    }

    async function runAgent(
        toolResults: ReturnType<typeof makeToolResultEvent>[],
        ctx = createMockCtx(),
    ): Promise<void> {
        await handlers.get('agent_start')!({ type: 'agent_start' }, ctx);
        for (const result of toolResults) {
            await handlers.get('tool_result')!(result, ctx);
        }
        await handlers.get('agent_end')!(
            { type: 'agent_end', messages: [] },
            ctx,
        );
    }

    function getPublishedPayload(): AgentRunSummaryPayload | undefined {
        const event = emittedEvents.find(
            (candidate) => candidate.channel === TOOL_SUMMARY_EVENT,
        );
        return event?.payload as AgentRunSummaryPayload | undefined;
    }

    function getPublishedSummary(): string | undefined {
        return getPublishedPayload()?.text;
    }

    it('collects tool results and publishes them at agent_end', async () => {
        const { default: extension } = await import('./index.ts');
        const pi = createMockExtensionAPI();
        extension(pi);

        expect(handlers.has('agent_start')).toBe(true);
        expect(handlers.has('tool_result')).toBe(true);
        expect(handlers.has('agent_end')).toBe(true);
        expect(handlers.has('agent_settled')).toBe(false);
        expect(commands.has('tool-summary')).toBe(true);
    });

    it('loads toolSummary allowlist from project settings at session_start', async () => {
        const projectDir = mkdtempSync(join(tmpdir(), 'tool-summary-'));
        const configDir = join(projectDir, '.pi');
        mkdirSync(configDir);
        writeFileSync(
            join(configDir, 'settings.json'),
            JSON.stringify({ toolSummary: { tools: ['read'] } }),
        );

        try {
            const { default: extension } = await import('./index.ts');
            const pi = createMockExtensionAPI();
            const ctx = createMockCtx(projectDir);
            extension(pi);

            await handlers.get('session_start')!(
                { type: 'session_start' },
                ctx,
            );
            await runAgent(
                [makeToolResultEvent('read'), makeToolResultEvent('grep')],
                ctx,
            );

            expect(getPublishedSummary()).toContain('read');
            expect(getPublishedSummary()).not.toContain('grep');
        } finally {
            rmSync(projectDir, { recursive: true, force: true });
        }
    });

    it('publishes accumulated usage without notifying directly', async () => {
        const { default: extension } = await import('./index.ts');
        const pi = createMockExtensionAPI();
        const ctx = createMockCtx();
        extension(pi);

        await runAgent(
            [
                makeToolResultEvent('read'),
                makeToolResultEvent('read'),
                makeToolResultEvent('grep'),
                makeToolResultEvent('bash', true),
            ],
            ctx,
        );

        expect(getPublishedPayload()?.prefix).toBe('TOOLS');
        expect(getPublishedSummary()).toContain('🔧');
        expect(getPublishedSummary()).toContain('read(2)');
        expect(getPublishedSummary()).toContain('grep(1)');
        expect(getPublishedSummary()).toContain('bash✗(1)');
        expect(ctx.ui.notify).not.toHaveBeenCalled();
    });

    it('respects runtime tool filter', async () => {
        const { default: extension } = await import('./index.ts');
        const pi = createMockExtensionAPI();
        const ctx = createMockCtx();
        extension(pi);

        await commands.get('tool-summary')!.handler('add read', ctx as any);
        await runAgent(
            [
                makeToolResultEvent('read'),
                makeToolResultEvent('grep'),
                makeToolResultEvent('bash', true),
            ],
            ctx,
        );

        expect(getPublishedSummary()).toContain('read');
        expect(getPublishedSummary()).not.toContain('grep');
        expect(getPublishedSummary()).not.toContain('bash');
    });

    it('publishes nothing when no tools were used', async () => {
        const { default: extension } = await import('./index.ts');
        const pi = createMockExtensionAPI();
        extension(pi);

        await runAgent([]);

        expect(getPublishedSummary()).toBeUndefined();
    });

    it('resets accumulated usage on each agent_start', async () => {
        const { default: extension } = await import('./index.ts');
        const pi = createMockExtensionAPI();
        const ctx = createMockCtx();
        extension(pi);

        await handlers.get('agent_start')!({ type: 'agent_start' }, ctx);
        await handlers.get('tool_result')!(makeToolResultEvent('read'), ctx);
        await handlers.get('agent_start')!({ type: 'agent_start' }, ctx);
        await handlers.get('tool_result')!(makeToolResultEvent('write'), ctx);
        await handlers.get('agent_end')!(
            { type: 'agent_end', messages: [] },
            ctx,
        );

        expect(getPublishedSummary()).toContain('write');
        expect(getPublishedSummary()).not.toContain('read');
    });

    it('publishes nothing when UI is unavailable', async () => {
        const { default: extension } = await import('./index.ts');
        const pi = createMockExtensionAPI();
        const ctx = { ...createMockCtx(), hasUI: false };
        extension(pi);

        await runAgent([makeToolResultEvent('read')], ctx);

        expect(getPublishedSummary()).toBeUndefined();
    });
});
