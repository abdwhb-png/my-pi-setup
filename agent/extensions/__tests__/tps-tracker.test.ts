import { describe, expect, it, mock } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
    type AgentRunSummaryPayload,
    TPS_SUMMARY_EVENT,
} from '../_shared/agent-run-summary.ts';
import tpsTracker from '../tps-tracker.ts';

describe('tps-tracker summary contribution', () => {
    it('publishes TPS summary without issuing a competing notification', async () => {
        const handlers = new Map<string, (...args: any[]) => any>();
        const emit = mock(
            (_channel: string, _payload: AgentRunSummaryPayload) => undefined,
        );
        const notify = mock(() => undefined);
        const setStatus = mock(() => undefined);
        const pi = {
            events: { on: () => () => undefined, emit },
            on: (event: string, handler: (...args: any[]) => any) => {
                handlers.set(event, handler);
            },
        } as unknown as ExtensionAPI;
        const ctx = {
            ui: {
                theme: { fg: (_color: string, text: string) => text },
                notify,
                setStatus,
            },
        };

        tpsTracker(pi);
        await handlers.get('agent_start')?.({ type: 'agent_start' }, ctx);
        await handlers.get('message_start')?.(
            { message: { role: 'assistant' } },
            ctx,
        );
        await Bun.sleep(2);
        await handlers.get('message_end')?.(
            {
                message: {
                    role: 'assistant',
                    usage: { output: 100 },
                },
            },
            ctx,
        );
        await handlers.get('agent_end')?.(
            { type: 'agent_end', messages: [] },
            ctx,
        );

        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit.mock.calls[0][0]).toBe(TPS_SUMMARY_EVENT);
        expect(emit.mock.calls[0][1]).toEqual({
            prefix: 'TPS',
            text: expect.stringContaining('100 tokens'),
        });
        expect(notify).not.toHaveBeenCalled();
        expect(setStatus).toHaveBeenCalledWith(
            'tps',
            expect.stringContaining('done'),
        );
    });
});
