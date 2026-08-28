import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
    computePanelOverlayHeight,
    renderFramedPanelFallback,
    renderFramedPanels,
    renderPanelTitle,
    resolveResponsivePanelLayout,
    slicePanelViewport,
    wrapPanelLines,
} from "./framed-panels.ts";

const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    inverse: (text: string) => text,
    underline: (text: string) => text,
} as any;

describe("resolveResponsivePanelLayout", () => {
    const variants = [
        { mode: "compact", minWidth: 20, panels: [{ minWidth: 18 }] },
        {
            mode: "medium",
            minWidth: 40,
            panels: [{ minWidth: 16 }, { minWidth: 21 }],
        },
        {
            mode: "wide",
            minWidth: 60,
            panels: [
                { minWidth: 16 },
                { minWidth: 20 },
                { minWidth: 20 },
            ],
        },
    ] as const;

    it("resolves one, two, and three panels at declared thresholds", () => {
        expect(resolveResponsivePanelLayout(20, variants)?.mode).toBe("compact");
        expect(resolveResponsivePanelLayout(40, variants)?.mode).toBe("medium");
        expect(resolveResponsivePanelLayout(60, variants)?.mode).toBe("wide");
        expect(resolveResponsivePanelLayout(60, variants)?.layout.panelWidths).toHaveLength(3);
    });

    it("falls back to the next fitting declaration and fails closed", () => {
        const declarations = [
            { mode: "compact", minWidth: 10, panels: [{ minWidth: 8 }] },
            { mode: "wide", minWidth: 10, panels: [{ minWidth: 20 }] },
        ] as const;
        expect(resolveResponsivePanelLayout(12, declarations)?.mode).toBe("compact");
        expect(resolveResponsivePanelLayout(9, declarations)).toBeNull();
    });
});

describe("wrapPanelLines", () => {
    it("preserves ANSI, emoji, empty lines, and long words within exact visible width", () => {
        const wrapped = wrapPanelLines(
            ["\u001b[31mred\u001b[0m 😀", "", "supercalifragilistic"],
            10,
            { padding: 1 },
        );

        expect(wrapped.some((line) => line === " ")).toBe(true);
        expect(wrapped.join("\n")).toContain("\u001b[31m");
        expect(wrapped.every((line) => visibleWidth(line) <= 9)).toBe(true);
        expect(wrapped.length).toBeGreaterThan(3);
    });
});

describe("slicePanelViewport", () => {
    it("clamps negative and overflowing offsets and reports the maximum", () => {
        const lines = ["a", "b", "c", "d"];
        expect(slicePanelViewport(lines, -4, 2)).toEqual({
            lines: ["a", "b"],
            offset: 0,
            maxOffset: 2,
            totalLines: 4,
        });
        expect(slicePanelViewport(lines, 99, 2)).toEqual({
            lines: ["c", "d"],
            offset: 2,
            maxOffset: 2,
            totalLines: 4,
        });
    });

    it("handles short content and zero-height viewports", () => {
        expect(slicePanelViewport(["a"], 2, 3)).toEqual({
            lines: ["a", "", ""],
            offset: 0,
            maxOffset: 0,
            totalLines: 1,
        });
        expect(slicePanelViewport(["a"], 2, 0)).toEqual({
            lines: [],
            offset: 0,
            maxOffset: 1,
            totalLines: 1,
        });
    });
});

describe("shared framed panel chrome", () => {
    it("computes bounded heights at terminal extremes", () => {
        expect(computePanelOverlayHeight(0)).toBe(0);
        expect(computePanelOverlayHeight(2)).toBe(0);
        expect(computePanelOverlayHeight(20)).toBe(17);
    });

    it("marks active titles and dims inactive titles", () => {
        expect(renderPanelTitle(theme, "DETAILS", true)).toContain("▸ DETAILS");
        expect(renderPanelTitle(theme, "DETAILS", false)).toBe(" DETAILS");
    });

    it("assembles full-width prelude, panel titles, body, panel footers, and box footer", () => {
        const resolved = resolveResponsivePanelLayout(30, [
            {
                mode: "wide",
                minWidth: 30,
                panels: [{ minWidth: 10 }, { minWidth: 17 }],
            },
        ] as const)!;
        const lines = renderFramedPanels({
            theme,
            title: "Review",
            layout: resolved.layout,
            prelude: [" summary"],
            panelTitles: [" LEFT", " RIGHT"],
            panelRows: [[" one", " two"]],
            panelFooterRows: [["", " actions"]],
            footer: "close",
            maxHeight: 8,
        });

        expect(lines.join("\n")).toContain("summary");
        expect(lines.join("\n")).toContain("LEFT");
        expect(lines.join("\n")).toContain("actions");
        expect(lines.at(-1)).toContain("close");
        expect(lines.every((line) => visibleWidth(line) === 30)).toBe(true);
    });

    it("reserves the closing footer when a framed panel has a maximum height", () => {
        const resolved = resolveResponsivePanelLayout(30, [
            {
                mode: "compact",
                minWidth: 30,
                panels: [{ minWidth: 28 }],
            },
        ] as const)!;
        const lines = renderFramedPanels({
            theme,
            title: "Review",
            layout: resolved.layout,
            prelude: [" artifact.md"],
            panelRows: Array.from({ length: 10 }, (_, index) => [
                ` line ${index + 1}`,
            ]),
            footer: "Esc close",
            maxHeight: 6,
        });

        expect(lines).toHaveLength(6);
        expect(lines.at(-1)).toContain("Esc close");
        expect(lines.every((line) => visibleWidth(line) === 30)).toBe(true);
    });

    it("keeps panel and box footer rows as distinct composable regions", () => {
        const resolved = resolveResponsivePanelLayout(30, [
            {
                mode: "wide",
                minWidth: 30,
                panels: [{ minWidth: 10 }, { minWidth: 17 }],
            },
        ] as const)!;
        const lines = renderFramedPanels({
            theme,
            title: "Review",
            layout: resolved.layout,
            panelRows: [[" one", " two"]],
            panelFooterRows: [[" left help", " right help"]],
            boxFooterRows: [" full-width help"],
            maxHeight: 20,
        });

        const panelHelpLine = lines.find((line) => line.includes("left help"));
        const helpLine = lines.find((line) => line.includes("full-width help"));
        expect(panelHelpLine?.match(/│/g)).toHaveLength(3);
        expect(helpLine).toBeDefined();
        expect(helpLine?.match(/│/g)).toHaveLength(2);
        expect(visibleWidth(helpLine ?? "")).toBe(30);
    });

    it("returns a closed bounded fallback when width or height is insufficient", () => {
        const fallback = renderFramedPanelFallback({
            theme,
            width: 24,
            maxHeight: 3,
            title: "Review",
            message: "Too small",
            footer: "Esc closes",
        });
        expect(fallback).toHaveLength(3);
        expect(fallback[0]).toStartWith("╭");
        expect(fallback[1]).toStartWith("│");
        expect(fallback[2]).toStartWith("╰");
        expect(fallback.every((line) => visibleWidth(line) === 24)).toBe(true);
        const ultraNarrow = renderFramedPanelFallback({
            theme,
            width: 1,
            maxHeight: 1,
            title: "Review",
            message: "Too small",
        });
        expect(ultraNarrow).toHaveLength(1);
        expect(visibleWidth(ultraNarrow[0]!)).toBe(1);
    });
});
