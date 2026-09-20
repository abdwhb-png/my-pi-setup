import { expect, mock, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
    BROWSER_TOOLS_WIDGET_ID,
    BROWSER_TOOLS_WIDGET_LABEL,
    renderBrowserToolsWidget,
} from "./widget.ts";

// This file exercises the real `_shared/fancy-footer.ts` helper, so the
// contribution below is what browser-tools actually hands to pi-fancy-footer.
const contributions: unknown[] = [];
const contribute = mock((_pi: unknown, widget: unknown) => {
    contributions.push(widget);
});
const discover = mock(() => undefined);
const refresh = mock(() => undefined);

mock.module("pi-fancy-footer/api", () => ({
    contributeFancyFooterWidgets: contribute,
    requestFancyFooterWidgetDiscovery: discover,
    requestFancyFooterRefresh: refresh,
    publishExtensionStatusesSnapshot: mock(() => undefined),
    getExtensionStatusesSnapshot: mock(() => []),
    subscribeExtensionStatusesSnapshot: mock(() => () => undefined),
    FANCY_FOOTER_EXTENSION_STATUSES_SNAPSHOT_EVENT: "fancy-footer:statuses",
}));

const { default: browserToolsExtension } = await import("./index.ts");

type CapturedWidget = {
    id: string;
    label?: string;
    row?: number;
    order?: number;
    align?: string;
    icon?: { emoji?: string };
    styled?: boolean;
    render: (ctx: { theme: Theme }) => unknown;
};
function fakeTheme(): Theme {
    return {
        fg: (color: string, text: string) => `fg:${color}:${text}`,
    } as unknown as Theme;
}

function registerExtension(): void {
    const pi = {
        registerCommand: () => undefined,
        on: () => undefined,
        getAllTools: () => [],
        getActiveTools: () => [],
        events: { on: () => () => undefined, emit: () => undefined },
    };
    browserToolsExtension(pi as never);
}

test("the real shared helper forwards the browser-tools contribution unchanged", () => {
    registerExtension();
    expect(discover).toHaveBeenCalled();

    const widget = contributions.at(-1) as CapturedWidget;
    expect(widget.id).toBe(BROWSER_TOOLS_WIDGET_ID);
    expect(widget.label).toBe(BROWSER_TOOLS_WIDGET_LABEL);
    expect(widget.row).toBe(2);
    expect(widget.order).toBe(3);
    expect(widget.align).toBe("left");
    // The globe is in the rendered label; a footer icon would duplicate it.
    expect(widget.icon).toBeUndefined();
    expect(widget.styled).toBe(true);
    const theme = fakeTheme();
    expect(String(widget.render({ theme }))).toBe(
        renderBrowserToolsWidget(theme, "unavailable"),
    );
});
