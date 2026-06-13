import { describe, it, expect } from "bun:test";
import { renderBoxHeader, renderBoxFooter, renderBoxSides } from "./box";

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
