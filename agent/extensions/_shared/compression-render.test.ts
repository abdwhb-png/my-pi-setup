import { describe, expect, it } from "bun:test";
import { Container } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  appendCompressionFooter,
  icon,
  readCompressionDetails,
} from "./compression-render";
import { formatCompressionFooter } from "../save-tokens/tool-renderers";

function createMockTheme() {
  return {
    fg: (_color: string, text: string) => text,
  };
}

describe("compression-render", () => {
  it("formats footer text", () => {
    const footer = formatCompressionFooter(
      { originalLength: 1200, compressedLength: 300, savedBytes: 900, savedPct: 75 },
      createMockTheme() as Theme,
    );
    expect(footer).toBe(` ${icon} • 1200 → 300 chars (-75%)`);
  });

  it("reads compression details when present", () => {
    expect(readCompressionDetails({ compression: { originalLength: 10, compressedLength: 4, savedBytes: 6, savedPct: 60 } })).toEqual({
      originalLength: 10,
      compressedLength: 4,
      savedBytes: 6,
      savedPct: 60,
    });
  });

  it("returns null when compression details absent", () => {
    expect(readCompressionDetails(undefined)).toBeNull();
    expect(readCompressionDetails({})).toBeNull();
  });

  it("appends a footer only for Container components with compression details", () => {
    const component = new Container();
    appendCompressionFooter(
      component,
      { compression: { originalLength: 10, compressedLength: 4, savedBytes: 6, savedPct: 60 } },
      createMockTheme() as Theme,
    );
    expect(component.children).toHaveLength(1);
  });
});