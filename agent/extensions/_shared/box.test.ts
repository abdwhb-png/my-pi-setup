import { describe, it, expect } from "bun:test";
import { renderBoxHeader, renderBoxFooter, renderBoxSides, BoxRenderer } from "./box";

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

// ── BoxRenderer ──────────────────────────────────────

describe("BoxRenderer", () => {
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

  it("respects minWidth and maxWidth", () => {
    // Narrow terminal
    const narrow = new BoxRenderer(theme, 30, { minWidth: 40, maxWidth: 120 });
    expect(narrow.getInnerWidth()).toBe(36); // clamped to min 40 -> 40-4=36

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
