import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
    BROWSER_TOOLS_WIDGET_ID,
    renderBrowserToolsWidget,
} from "./widget.ts";

function fakeTheme(calls: Array<[string, string]> = []): Theme {
    return {
        fg: (color: string, text: string) => {
            calls.push([color, text]);
            return `fg:${color}:${text}`;
        },
    } as unknown as Theme;
}

describe("renderBrowserToolsWidget", () => {
    test("colors each availability state", () => {
        for (const [status, color] of [
            ["hidden", "dim"],
            ["manual", "success"],
            ["manual (restricted)", "warning"],
            ["unavailable", "error"],
        ] as const) {
            const calls: Array<[string, string]> = [];
            const rendered = renderBrowserToolsWidget(fakeTheme(calls), status);
            expect(rendered).toContain(status);
            expect(calls).toContainEqual([color, status]);
        }
    });

    test("renders unstyled text without a theme", () => {
        expect(renderBrowserToolsWidget(undefined, "unavailable")).toContain(
            "unavailable",
        );
        expect(renderBrowserToolsWidget(null, "manual")).toContain("manual");
    });

    test("keeps the stable widget id", () => {
        expect(BROWSER_TOOLS_WIDGET_ID).toBe("browser-tools");
    });
});
