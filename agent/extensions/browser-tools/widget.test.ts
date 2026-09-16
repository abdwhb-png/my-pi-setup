import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
    BROWSER_TOOLS_EMOJI,
    BROWSER_TOOLS_WIDGET_ID,
    renderBrowserToolsWidget,
} from "./widget.ts";

function fakeTheme(): Theme {
    return {
        fg: (color: string, text: string) => `fg:${color}:${text}`,
    } as unknown as Theme;
}

describe("renderBrowserToolsWidget", () => {
    test("colors each availability state", () => {
        const theme = fakeTheme();
        expect(renderBrowserToolsWidget(theme, "hidden")).toBe(
            "fg:dim:🌐 browser: fg:dim:hidden",
        );
        expect(renderBrowserToolsWidget(theme, "manual")).toBe(
            "fg:dim:🌐 browser: fg:success:manual",
        );
        expect(renderBrowserToolsWidget(theme, "manual (restricted)")).toBe(
            "fg:dim:🌐 browser: fg:warning:manual (restricted)",
        );
        expect(renderBrowserToolsWidget(theme, "unavailable")).toBe(
            "fg:dim:🌐 browser: fg:error:unavailable",
        );
    });

    test("renders unstyled text without a theme", () => {
        expect(renderBrowserToolsWidget(undefined, "unavailable")).toBe(
            "🌐 browser: unavailable",
        );
        expect(renderBrowserToolsWidget(null, "manual")).toBe(
            "🌐 browser: manual",
        );
    });

    test("keeps a single glyph for the widget label", () => {
        expect(BROWSER_TOOLS_WIDGET_ID).toBe("browser-tools");
        expect(BROWSER_TOOLS_EMOJI).toBe("🌐");
    });
});
