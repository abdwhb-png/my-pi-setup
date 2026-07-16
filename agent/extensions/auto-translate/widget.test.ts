import { describe, expect, it, mock } from 'bun:test';
import { buildStatusRenderText, offText } from './state.ts';

const contributeMock = mock((_pi: unknown, def: unknown) => {
    (widgetContributions as unknown[]).push(def);
});
const discoverMock = mock(() => undefined);
const refreshMock = mock(() => undefined);
const widgetContributions: unknown[] = [];

mock.module('pi-fancy-footer/api', () => ({
    contributeFancyFooterWidgets: contributeMock,
    requestFancyFooterWidgetDiscovery: discoverMock,
    requestFancyFooterRefresh: refreshMock,
    publishExtensionStatusesSnapshot: mock(() => undefined),
    getExtensionStatusesSnapshot: mock(() => []),
    subscribeExtensionStatusesSnapshot: mock(() => () => undefined),
    FANCY_FOOTER_EXTENSION_STATUSES_SNAPSHOT_EVENT: 'fancy-footer:statuses',
}));

const { createTranslateWidget, WIDGET_ID } = await import('./widget.ts');

function mockPi() {
    return { on: mock(), registerCommand: mock() } as unknown as Parameters<
        typeof createTranslateWidget
    >[0];
}

function mockCtx(hasUI = true) {
    return {
        hasUI: hasUI,
        ui: { setWidget: mock(), notify: mock() },
    } as unknown as Parameters<
        ReturnType<typeof createTranslateWidget>['update']
    >[0];
}

describe('createTranslateWidget', () => {
    it('contributes a widget and requests discovery', () => {
        createTranslateWidget(mockPi(), () => offText);
        expect(contributeMock).toHaveBeenCalledTimes(1);
        expect(discoverMock).toHaveBeenCalled();
    });

    it('registers with the correct widget id + label', () => {
        widgetContributions.length = 0;
        createTranslateWidget(mockPi(), () => offText);
        const def = widgetContributions[widgetContributions.length - 1] as {
            id: string;
            label: string;
        };
        expect(def.id).toBe(WIDGET_ID);
        expect(def.label).toBe('Auto-Translate');
    });

    it('render closure reflects live status text', () => {
        widgetContributions.length = 0;
        let status = offText;
        createTranslateWidget(mockPi(), () => status);
        const def = widgetContributions[widgetContributions.length - 1] as {
            render: () => string;
        };
        expect(def.render()).toBe(offText);
        status = buildStatusRenderText('French', 'send');
        expect(def.render()).toBe(buildStatusRenderText('French', 'send'));
    });

    it('update triggers fancy-footer refresh', () => {
        const handle = createTranslateWidget(mockPi(), () => offText);
        refreshMock.mockClear();
        handle.update(mockCtx(), offText);
        expect(refreshMock).toHaveBeenCalledTimes(1);
    });

    it('update falls back to setWidget when fancy-footer inactive', () => {
        // Make contribute throw so isActive=false
        contributeMock.mockImplementationOnce(() => {
            throw new Error('fancy-footer not installed');
        });
        const handle = createTranslateWidget(mockPi(), () => offText);
        const ctx = mockCtx();
        handle.update(ctx, buildStatusRenderText('English', 'send'));
        expect(
            (ctx as { ui: { setWidget: (id: unknown, v: unknown) => void } }).ui
                .setWidget,
        ).toHaveBeenCalledWith(WIDGET_ID, [
            buildStatusRenderText('English', 'send'),
        ]);
    });
});
