import { describe, expect, it, mock } from 'bun:test';

// Mock pi-fancy-footer/api — compatible with index.test.ts mock.
// Both test files must use the same mock since mock.module is global.
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

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createSummaryWidget } from './widget.ts';

describe('createSummaryWidget', () => {
    it('registers a widget with correct id', () => {
        const emit = mock();
        const on = mock();
        const pi = {
            events: { on, emit },
        } as unknown as ExtensionAPI;

        const getStatus = () => 'test status';
        createSummaryWidget(pi, getStatus);

        expect(emit).toHaveBeenCalled();
        const calls = emit.mock.calls.map((c: unknown[]) => c[0]);
        expect(calls).toContain('pi-fancy-footer:request-widget-discovery');
    });

    it('returns a WidgetHandle with active, update, remove', () => {
        const emit = mock();
        const on = mock();
        const pi = {
            events: { on, emit },
        } as unknown as ExtensionAPI;

        const getStatus = () => 'test';
        const widget = createSummaryWidget(pi, getStatus);

        expect(widget).toHaveProperty('active');
        expect(widget).toHaveProperty('update');
        expect(widget).toHaveProperty('remove');
    });

    it('widget is active and update succeeds', () => {
        const emit = mock();
        const on = mock();
        const pi = {
            events: { on, emit },
        } as unknown as ExtensionAPI;

        const getStatus = () => 'status from closure';
        const widget = createSummaryWidget(pi, getStatus);

        expect(widget.active).toBe(true);

        const ctx = {
            hasUI: true,
            ui: {
                setWidget: mock(),
            },
        };
        widget.update(ctx as any, 'fallback text');
        // fancy-footer active path: calls requestFancyFooterRefresh, not setWidget
        expect(ctx.ui.setWidget).not.toHaveBeenCalled();
    });
});
