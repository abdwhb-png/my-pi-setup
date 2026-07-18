import { describe, expect, it, mock } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
    TOOL_SUMMARY_EVENT,
    TPS_SUMMARY_EVENT,
} from '../_shared/agent-run-summary.ts';

interface SummaryPayload {
    prefix: string;
    text: string;
}

const EXPECTED_COMBINED_SUMMARY =
    '<muted>[TPS]</muted> ✓ 97 tok/s  8516 tokens in 87.4s streaming  ·  <muted>[TOOLS]</muted> 🔧 write_plan(1)';

describe('agent-run-summary extension', () => {
    function createHarness() {
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        const eventListeners = new Map<
            string,
            Array<(payload: SummaryPayload) => void>
        >();
        const notify = mock(() => undefined);

        const pi = {
            events: {
                on: (
                    channel: string,
                    listener: (payload: SummaryPayload) => void,
                ) => {
                    const listeners = eventListeners.get(channel) ?? [];
                    listeners.push(listener);
                    eventListeners.set(channel, listeners);
                },
                emit: (channel: string, payload: SummaryPayload) => {
                    for (const listener of eventListeners.get(channel) ?? []) {
                        listener(payload);
                    }
                },
            },
            on: (event: string, handler: (...args: unknown[]) => unknown) => {
                handlers.set(event, handler);
            },
        } as unknown as ExtensionAPI;

        const ctx = {
            hasUI: true,
            ui: {
                notify,
                theme: {
                    fg: (color: string, text: string) =>
                        `<${color}>${text}</${color}>`,
                },
            },
        };

        return { pi, handlers, notify, ctx };
    }

    it('combines TPS and tool contributions into one final notification', async () => {
        const { default: extension } = await import('./index.ts');
        const { pi, handlers, notify, ctx } = createHarness();
        extension(pi);

        await handlers.get('agent_start')?.({ type: 'agent_start' }, ctx);
        pi.events.emit(TPS_SUMMARY_EVENT, {
            prefix: 'TPS',
            text: '✓ 97 tok/s  8516 tokens in 87.4s streaming',
        });
        pi.events.emit(TOOL_SUMMARY_EVENT, {
            prefix: 'TOOLS',
            text: '🔧 write_plan(1)',
        });
        await handlers.get('agent_settled')?.({ type: 'agent_settled' }, ctx);

        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith(EXPECTED_COMBINED_SUMMARY, 'info');
    });

    it('reports whichever contribution is available', async () => {
        const { default: extension } = await import('./index.ts');
        const { pi, handlers, notify, ctx } = createHarness();
        extension(pi);

        await handlers.get('agent_start')?.({ type: 'agent_start' }, ctx);
        pi.events.emit(TPS_SUMMARY_EVENT, {
            prefix: 'TPS',
            text: '✓ 80 tok/s',
        });
        await handlers.get('agent_settled')?.({ type: 'agent_settled' }, ctx);

        expect(notify).toHaveBeenCalledWith(
            '<muted>[TPS]</muted> ✓ 80 tok/s',
            'info',
        );
    });

    it('resets contributions at the next agent start', async () => {
        const { default: extension } = await import('./index.ts');
        const { pi, handlers, notify, ctx } = createHarness();
        extension(pi);

        pi.events.emit(TPS_SUMMARY_EVENT, {
            prefix: 'TPS',
            text: 'stale TPS',
        });
        pi.events.emit(TOOL_SUMMARY_EVENT, {
            prefix: 'TOOLS',
            text: 'stale tools',
        });
        await handlers.get('agent_start')?.({ type: 'agent_start' }, ctx);
        await handlers.get('agent_settled')?.({ type: 'agent_settled' }, ctx);

        expect(notify).not.toHaveBeenCalled();
    });
});
