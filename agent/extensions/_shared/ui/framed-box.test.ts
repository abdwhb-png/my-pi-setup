import { describe, it, expect } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  allocateBoxPanelLayout,
  renderBoxHeader,
  renderBoxFooter,
  renderBoxPanelRow,
  renderBoxPanelSeparator,
  renderBoxSides,
  BoxRenderer,
} from "./framed-box";

function createMockTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    inverse: (text: string) => text,
    underline: (text: string) => text,
  };
}

const theme = createMockTheme() as any;

describe("renderBoxHeader", () => {
  it("keeps the decorative title padding inside the requested width", () => {
    const result = renderBoxHeader(theme, 40, "Test");

    expect(visibleWidth(result)).toBe(40);
  });

  it("renders a centered header with rounded borders by default", () => {
    const result = renderBoxHeader(theme, 40, "Test");
    expect(result).toContain("Test");
    // rounded: ╭ + ─ + text + ─ + ╮
    expect(result).toMatch(/^[╭][─]+.*/);
    expect(result).toMatch(/.*[─]+[╮]$/);
    // total visible width should equal innerWidth
    // (each char is regular ASCII or box drawing, visible width 1)
    const textIdx = result.indexOf("Test");
    expect(textIdx).toBeGreaterThan(0);
  });

  it("truncates long text that exceeds inner width", () => {
    const longText = "This is a very long text that will not fit";
    const result = renderBoxHeader(theme, 20, longText);
    // should still produce valid box without overflow
    expect(result).toContain("..."); // truncated (by truncateToWidth)
    // should start with border character
    expect(result).toMatch(/^[╭]/);
    expect(result).toMatch(/[╮]$/);
  });

  it("handles very narrow width gracefully", () => {
    const result = renderBoxHeader(theme, 4, "Hi");
    // Even at tiny width, should not crash
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });

  it("supports single border style", () => {
    const result = renderBoxHeader(theme, 40, "Test", {
      borderStyle: "single",
    });
    expect(result).toMatch(/^[┌]/);
    expect(result).toMatch(/[┐]$/);
  });

  it("supports double border style", () => {
    const result = renderBoxHeader(theme, 40, "Test", {
      borderStyle: "double",
    });
    expect(result).toMatch(/^[╔]/);
    expect(result).toMatch(/[╗]$/);
  });

  it("supports left title position", () => {
    const centered = renderBoxHeader(theme, 40, "A", { titlePosition: "center" });
    const left = renderBoxHeader(theme, 40, "A", { titlePosition: "left" });
    // Left should have the text earlier than center
    const centeredIdx = centered.indexOf("A");
    const leftIdx = left.indexOf("A");
    expect(leftIdx).toBeLessThan(centeredIdx);
  });

  it("supports right title position", () => {
    const centered = renderBoxHeader(theme, 40, "A", { titlePosition: "center" });
    const right = renderBoxHeader(theme, 40, "A", { titlePosition: "right" });
    const centeredIdx = centered.indexOf("A");
    const rightIdx = right.indexOf("A");
    expect(rightIdx).toBeGreaterThan(centeredIdx);
  });

  it("renders without options (backward compatible)", () => {
    const result = renderBoxHeader(theme, 40, "Hello");
    expect(result).toContain("Hello");
    expect(result.length).toBeGreaterThan(10);
  });
});

describe("renderBoxFooter", () => {
  it("keeps the decorative footer padding inside the requested width", () => {
    const result = renderBoxFooter(theme, 40, "Footer");

    expect(visibleWidth(result)).toBe(40);
  });

  it("renders a centered footer with rounded borders by default", () => {
    const result = renderBoxFooter(theme, 40, "Footer");
    expect(result).toContain("Footer");
    expect(result).toMatch(/^[╰][─]+.*/);
    expect(result).toMatch(/.*[─]+[╯]$/);
  });

  it("truncates long text that exceeds inner width", () => {
    const longText = "This is a very long footer that will not fit in the box";
    const result = renderBoxFooter(theme, 20, longText);
    expect(result).toContain("...");
    expect(result).toMatch(/^[╰]/);
    expect(result).toMatch(/[╯]$/);
  });

  it("handles very narrow width gracefully", () => {
    const result = renderBoxFooter(theme, 4, "OK");
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });

  it("supports single border style", () => {
    const result = renderBoxFooter(theme, 40, "Footer", {
      borderStyle: "single",
    });
    expect(result).toMatch(/^[└]/);
    expect(result).toMatch(/[┘]$/);
  });

  it("supports double border style", () => {
    const result = renderBoxFooter(theme, 40, "Footer", {
      borderStyle: "double",
    });
    expect(result).toMatch(/^[╚]/);
    expect(result).toMatch(/[╝]$/);
  });
});

describe("renderBoxSides", () => {
  it("returns array of border strings", () => {
    const result = renderBoxSides(theme, 5);
    expect(result).toHaveLength(5);
    for (const line of result) {
      expect(line).toContain("│");
    }
  });

  it("returns empty array for zero height", () => {
    const result = renderBoxSides(theme, 0);
    expect(result).toHaveLength(0);
  });
});

describe("allocateBoxPanelLayout", () => {
  it("allocates widths for one panel", () => {
    const layout = allocateBoxPanelLayout(12, [{ minWidth: 3 }]);
    expect(layout).not.toBeNull();
    expect(layout).toEqual({
      frameWidth: 12,
      panelWidths: [10],
    });
  });

  it("allocates for two and three panels deterministically", () => {
    const two = allocateBoxPanelLayout(14, [{ minWidth: 2 }, { minWidth: 2 }]);
    expect(two).not.toBeNull();
    expect(two).toEqual({
      frameWidth: 14,
      panelWidths: [6, 5],
    });

    const three = allocateBoxPanelLayout(14, [{ minWidth: 2 }, { minWidth: 2 }, { minWidth: 2 }]);
    expect(three).not.toBeNull();
    expect(three).toEqual({
      frameWidth: 14,
      panelWidths: [4, 3, 3],
    });
  });

  it("distributes weighted capacity across panels using deterministic residuals", () => {
    const layout = allocateBoxPanelLayout(14, [
      { minWidth: 2, weight: 2 },
      { minWidth: 2, weight: 1 },
    ]);

    expect(layout).toEqual({
      frameWidth: 14,
      panelWidths: [7, 4],
    });
  });

  it("respects weights and max widths", () => {
    const layout = allocateBoxPanelLayout(14, [
      { minWidth: 2, maxWidth: 3, weight: 10 },
      { minWidth: 2, weight: 1 },
      { minWidth: 2, weight: 1 },
    ]);

    expect(layout).toEqual({
      frameWidth: 14,
      panelWidths: [3, 4, 3],
    });
  });

  it("keeps maxWidth as a cap and sends leftover to the last panel only when all are saturated", () => {
    const layout = allocateBoxPanelLayout(20, [
      { minWidth: 2, maxWidth: 3 },
      { minWidth: 2, maxWidth: 3 },
    ]);

    expect(layout).toEqual({
      frameWidth: 20,
      panelWidths: [3, 14],
    });
  });

  it("puts remaining space on the last panel when all panels reached max", () => {
    const layout = allocateBoxPanelLayout(20, [
      { minWidth: 4, maxWidth: 4 },
      { minWidth: 4, maxWidth: 4 },
      { minWidth: 4 },
    ]);

    expect(layout).toEqual({
      frameWidth: 20,
      panelWidths: [4, 4, 8],
    });
  });

  it("rejects invalid weights", () => {
    expect(allocateBoxPanelLayout(20, [{ minWidth: 2, weight: 0 }])).toBeNull();
    expect(allocateBoxPanelLayout(20, [{ minWidth: 2, weight: 1.5 }])).toBeNull();
    expect(allocateBoxPanelLayout(20, [{ minWidth: 2, weight: Infinity }])).toBeNull();
  });

  it("rejects unsafe integer inputs", () => {
    const unsafeWidth = Number.MAX_SAFE_INTEGER + 1;
    expect(Number.isSafeInteger(unsafeWidth)).toBe(false);
    expect(allocateBoxPanelLayout(unsafeWidth, [{ minWidth: 2 }])).toBeNull();
  });

  it("returns null when minima cannot fit", () => {
    expect(allocateBoxPanelLayout(5, [{ minWidth: 2 }, { minWidth: 2 }])).toBeNull();
    expect(allocateBoxPanelLayout(20, [])).toBeNull();
  });

  it("returns null for invalid integers", () => {
    expect(allocateBoxPanelLayout(3.5, [{ minWidth: 2 }])).toBeNull();
    expect(allocateBoxPanelLayout(10, [{ minWidth: 0 }])).toBeNull();
    expect(allocateBoxPanelLayout(10, [{ minWidth: 2, maxWidth: 1 }])).toBeNull();
  });
});

describe("renderBoxPanelRow", () => {
  const layout = allocateBoxPanelLayout(14, [{ minWidth: 4 }, { minWidth: 4 }, { minWidth: 2 }]);

  it("renders a single panel row with ansi, emoji and long words", () => {
    expect(layout).not.toBeNull();
    const row = renderBoxPanelRow(
      theme,
      layout!,
      [
        "\u001b[31m".concat("word".repeat(5), "\u001b[0m"),
        "🧬".repeat(8),
        "second-cell-with-a-very-long-word",
      ],
    );

    expect(visibleWidth(row)).toBe(layout!.frameWidth);
    expect(row).toContain("│");
    expect(row[row.length - 1]).toBe("│");
  });

  it("throws when cell count does not match panel count", () => {
    expect(() => renderBoxPanelRow(theme, layout!, ["only-one-cell"])).toThrow();
  });

  it("throws when layout is malformed", () => {
    expect(() =>
      renderBoxPanelRow(theme, { frameWidth: 9, panelWidths: [2, 2] }, ["a", "b"]),
    ).toThrow();
  });

  it.each([
    { cell: "line\nbreak", label: "newline" },
    { cell: "line\rreturn", label: "carriage-return" },
  ])("throws for $label inside a panel cell", ({ cell }) => {
    expect(() => renderBoxPanelRow(theme, layout!, ["a", cell, "c"])).toThrow(
      "renderBoxPanelRow cells must be single-line strings",
    );
  });
});

describe("renderBoxPanelSeparator", () => {
  const layout = { frameWidth: 9, panelWidths: [1, 2, 2] } as const;

  it("renders exact separators for rounded panels", () => {
    expect(renderBoxPanelSeparator(theme, layout, "top", { borderStyle: "rounded" })).toBe(
      "├─┬──┬──┤",
    );
    expect(renderBoxPanelSeparator(theme, layout, "middle", { borderStyle: "rounded" })).toBe(
      "├─┼──┼──┤",
    );
    expect(renderBoxPanelSeparator(theme, layout, "bottom", { borderStyle: "rounded" })).toBe(
      "├─┴──┴──┤",
    );
  });

  it("renders exact separators for single panels", () => {
    expect(renderBoxPanelSeparator(theme, layout, "top", { borderStyle: "single" })).toBe(
      "├─┬──┬──┤",
    );
    expect(renderBoxPanelSeparator(theme, layout, "middle", { borderStyle: "single" })).toBe(
      "├─┼──┼──┤",
    );
    expect(renderBoxPanelSeparator(theme, layout, "bottom", { borderStyle: "single" })).toBe(
      "├─┴──┴──┤",
    );
  });

  it("renders exact separators for double panels", () => {
    expect(renderBoxPanelSeparator(theme, layout, "top", { borderStyle: "double" })).toBe(
      "╠═╦══╦══╣",
    );
    expect(renderBoxPanelSeparator(theme, layout, "middle", { borderStyle: "double" })).toBe(
      "╠═╬══╬══╣",
    );
    expect(renderBoxPanelSeparator(theme, layout, "bottom", { borderStyle: "double" })).toBe(
      "╠═╩══╩══╣",
    );
  });

  it("applies theme.fg on each separator segment (junction + horizontals) with non-identity theme", () => {
    const ansiTheme = {
      ...theme,
      fg: (color: string, text: string) => `\u001b[31m${text}\u001b[0m`,
    };

    const result = renderBoxPanelSeparator(ansiTheme, layout, "middle", {
      borderStyle: "single",
    });

    expect(result).toBe("\u001b[31m├─\u001b[0m\u001b[31m┼──\u001b[0m\u001b[31m┼──\u001b[0m\u001b[31m┤\u001b[0m");
    expect(visibleWidth(result)).toBe(layout.frameWidth);
  });

  it("ensures separator lines match frame width", () => {
    const top = renderBoxPanelSeparator(theme, layout, "top", { borderStyle: "double" });
    expect(visibleWidth(top)).toBe(layout.frameWidth);
    expect(top[0]).toBe("╠");
    expect(top[top.length - 1]).toBe("╣");
  });

  it("throws when layout is malformed", () => {
    expect(() =>
      renderBoxPanelSeparator(theme, { frameWidth: 11, panelWidths: [] }, "top"),
    ).toThrow();
  });
});

// ── BoxRenderer ──────────────────────────────────────

describe("BoxRenderer", () => {
  it("wraps long fixed-header rows inside the box borders", () => {
    const box = new BoxRenderer(theme, 80, { viewportHeight: 1 });
    const subtitle = `docs/${"very-long-path-segment-".repeat(5)}artifact.md`;
    box.setFixedHeader([subtitle]);
    box.setContent(["body"]);

    const result = box.render();
    const fixedHeaderRows = result.slice(1, -1);

    expect(fixedHeaderRows).toHaveLength(2);
    expect(fixedHeaderRows[0]).toContain("docs/");
    expect(fixedHeaderRows[1]).toContain("artifact.md");
    expect(fixedHeaderRows.every((line) => visibleWidth(line) === box.getInnerWidth())).toBe(true);
  });

  it("scrolls wrapped content by visual rows", () => {
    const box = new BoxRenderer(theme, 80, { viewportHeight: 2 });
    box.setContent([
      `start ${"x".repeat(65)} middle ${"y".repeat(65)} end`,
    ]);
    box.setFooter("Close");

    expect(box.getScrollInfo()).toContain("[0/1↑↓]");
    expect(box.render().join("\n")).not.toContain("end");

    box.scrollDown();
    expect(box.render().join("\n")).toContain("end");
  });

  it("keeps ANSI, emoji, and long words within the frame width", () => {
    const box = new BoxRenderer(theme, 80, { viewportHeight: 2 });
    box.setTitle("📦 Wide title");
    box.setFixedHeader([`\u001b[38;5;39m${"🧬".repeat(40)}\u001b[0m`]);
    box.setContent([`\u001b[31m${"unbroken-content-".repeat(10)}\u001b[0m`]);
    box.setFooter("A deliberately long footer that must remain on one bounded line");

    expect(box.render().every((line) => visibleWidth(line) === box.getInnerWidth())).toBe(true);
  });

  it("renders header, content, and footer wrapped in borders", () => {
    const box = new BoxRenderer(theme, 80);
    box.setTitle("My Box");
    box.setContent(["line 1", "line 2"]);
    box.setFooter("[q] Close");
    const result = box.render();
    // Header with title
    expect(result[0]).toContain("My Box");
    expect(result[0]).toMatch(/^[╭]/);
    expect(result[0]).toMatch(/[╮]$/);
    // Content lines have borders and content
    expect(result.some((l) => l.includes("line 1"))).toBe(true);
    expect(result.some((l) => l.includes("line 2"))).toBe(true);
    // Footer
    const lastLine = result[result.length - 1];
    expect(lastLine).toContain("[q] Close");
    expect(lastLine).toMatch(/^[╰]/);
    expect(lastLine).toMatch(/[╯]$/);
  });

  it("calculates innerWidth from terminal width", () => {
    const box = new BoxRenderer(theme, 100);
    expect(box.getInnerWidth()).toBe(96); // width - 4
  });

  it("clamps content width to at least one column for tiny terminals", () => {
    const box = new BoxRenderer(theme, 3);
    expect(box.getContentWidth()).toBe(1);
  });

  it("respects minWidth and maxWidth", () => {
    // Narrow terminal
    const narrow = new BoxRenderer(theme, 30, { minWidth: 40, maxWidth: 120 });
    expect(narrow.getInnerWidth()).toBeLessThanOrEqual(26); // clamped to terminal - 4 => 26

    // Wide terminal
    const wide = new BoxRenderer(theme, 200, { minWidth: 40, maxWidth: 100 });
    expect(wide.getInnerWidth()).toBe(96); // clamped to max 100 -> 100-4=96
  });

  it("provides contentWidth (inner with border padding)", () => {
    const box = new BoxRenderer(theme, 100);
    expect(box.getContentWidth()).toBe(92); // innerWidth - 4 (for │ + 2 spaces)
  });

  it("handles scroll management with scrollTo/scroll/setMaxScroll", () => {
    const box = new BoxRenderer(theme, 80, { viewportHeight: 3 });
    box.setContent(["a", "b", "c", "d", "e", "f"]);
    box.setFooter("Foot");

    // 6 content lines, viewport 3 -> maxScroll = 3
    const result = box.render();
    // Should show a, b, c (first 3)
    expect(result.some((l) => l.includes("a"))).toBe(true);
    expect(result.some((l) => l.includes("d"))).toBe(false);

    // Scroll down
    box.scrollDown();
    const result2 = box.render();
    expect(result2.some((l) => l.includes("a"))).toBe(false);
    expect(result2.some((l) => l.includes("b"))).toBe(true);
    expect(result2.some((l) => l.includes("e"))).toBe(false);
  });

  it("scrollTo clamps to valid range", () => {
    const box = new BoxRenderer(theme, 80, { viewportHeight: 2 });
    box.setContent(["a", "b", "c", "d", "e"]);
    box.setFooter("Foot");
    // 5 content, viewport 2 -> maxScroll = 3
    box.scrollTo(10); // past end
    const result = box.render();
    expect(result.some((l) => l.includes("d"))).toBe(true);
    expect(result.some((l) => l.includes("e"))).toBe(true);
  });

  it("renders a compact single-line fallback for ultra-narrow frame", () => {
    const box = new BoxRenderer(theme, 3, { minWidth: 40 });
    box.setTitle("A very long title");
    box.setContent(["Body"]);
    box.setFooter("Footer");

    const result = box.render();
    expect(result).toHaveLength(1);
    expect(visibleWidth(result[0])).toBeLessThan(4);
    expect(result[0]).not.toMatch(/[╭╮╰╯┌┐└┘╔╗╚╝]/u);
  });

  it("scrollTo negative clamps to 0", () => {
    const box = new BoxRenderer(theme, 80, { viewportHeight: 2 });
    box.setContent(["a", "b", "c"]);
    box.setFooter("Foot");
    box.scrollTo(5);
    box.scrollTo(-5);
    const result = box.render();
    expect(result.some((l) => l.includes("a"))).toBe(true);
  });

  it("includes scroll info in footer", () => {
    const box = new BoxRenderer(theme, 80, { viewportHeight: 2 });
    box.setTitle("Scroll Test");
    box.setContent(["a", "b", "c", "d"]);
    box.setFooter("Close");
    const result = box.render();
    const lastLine = result[result.length - 1];
    expect(lastLine).toContain("[0/2"); // scroll indicator present
    expect(lastLine).toContain("Close");
  });

  it("handles empty content", () => {
    const box = new BoxRenderer(theme, 80);
    box.setTitle("Empty");
    box.setContent([]);
    box.setFooter("Done");
    const result = box.render();
    expect(result.length).toBeGreaterThan(2);
  });

  it("pads content with empty lines to fill viewport", () => {
    const box = new BoxRenderer(theme, 80, { viewportHeight: 5 });
    box.setTitle("Padded");
    box.setContent(["only one line"]);
    box.setFooter("Foot");
    const result = box.render();
    // header + 5 content lines + footer = 7 lines
    // content lines include 1 real + 4 padding
    expect(result.length).toBe(7);
  });

  it("allows null footer", () => {
    const box = new BoxRenderer(theme, 80);
    box.setTitle("No Footer");
    box.setContent(["content"]);
    const result = box.render();
    // Should not have footer line
    const lastLine = result[result.length - 1];
    expect(lastLine).not.toContain("╰");
  });

  it("allows null title", () => {
    const box = new BoxRenderer(theme, 80);
    box.setContent(["content"]);
    box.setFooter("Foot");
    const result = box.render();
    // Should still render with border
    expect(result[0]).toMatch(/^[╭]/);
  });

  it("borderChar survives method-detachment (this-binding)" , () => {
    const box = new BoxRenderer(theme, 80);
    // Simulates the bug pattern: const b = box.borderChar; b("vertical")
    const b = box.borderChar;
    // Must not throw TypeError: Cannot read properties of undefined
    expect(() => b("vertical")).not.toThrow();
    expect(b("vertical")).toBe("│");
  });

  it("getScrollInfo survives method-detachment (this-binding)" , () => {
    const box = new BoxRenderer(theme, 80, { viewportHeight: 2 });
    box.setContent(["a", "b", "c"]);
    box.setFooter("Close");
    const getScroll = box.getScrollInfo;
    // Must not throw
    expect(() => getScroll()).not.toThrow();
    expect(getScroll()).toContain("[0/1");
  });

  it("getInnerWidth survives method-detachment (this-binding)" , () => {
    const box = new BoxRenderer(theme, 100);
    const getInner = box.getInnerWidth;
    expect(() => getInner()).not.toThrow();
    expect(getInner()).toBe(96);
  });
});
