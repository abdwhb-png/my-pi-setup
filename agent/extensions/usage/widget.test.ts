import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { UsageReportWidget } from "./widget";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  inverse: (text: string) => text,
  underline: (text: string) => text,
} as any;

describe("UsageReportWidget", () => {
  it("keeps tab rows and their separator inside the box width", () => {
    const widget = new UsageReportWidget({
      theme,
      report: {
        windows: [],
        generatedAt: new Date(),
        pricingNotes: [],
        pricing: new Map(),
      },
      done: () => undefined,
    });

    const lines = widget.render(80);

    expect(lines).toHaveLength(29);
    expect(lines.every((line) => visibleWidth(line) === 76)).toBe(true);
  });
});
