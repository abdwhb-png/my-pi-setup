import { describe, expect, it } from "bun:test";
import { buildTpsStatus, buildTpsSummary } from "./tps-status.ts";

/** Colour stub: returns the text unchanged so assertions read the composed string. */
const colors = {
  separator: (t: string) => t,
  subtle: (t: string) => t,
  muted: (t: string) => t,
  meta: (t: string) => t,
  primary: (t: string) => t,
  success: (t: string) => t,
  warning: (t: string) => t,
  danger: (t: string) => t,
  text: (t: string) => t,
  model: (t: string) => t,
  toolOutput: (t: string) => t,
  apply: (t: string, _color: string) => t,
  pressure: (t: string, _p: number, _w?: number, _e?: number) => t,
};

describe("tps-status renderers", () => {
  describe("buildTpsStatus", () => {
    it("renders in/out tokens, tps and elapsed", () => {
      const out = buildTpsStatus({ input: 1500, output: 3200, tps: 42, elapsedMs: 76_000 }, colors);
      expect(out).toContain("in↓ 1.5k · out↑ 3.2k");
      expect(out).toContain("1.5k");
      expect(out).toContain("3.2k");
      expect(out).toContain("42 tok/s");
      expect(out).toContain("76.0s");
    });
  });

  describe("buildTpsSummary", () => {
    it("renders the final summary with in, out, tps and duration", () => {
      const out = buildTpsSummary({ input: 900, output: 512, tps: 12, elapsedMs: 42_000 }, colors);
      expect(out).toContain("in↓ 900 · out↑ 512");
      expect(out).toContain("12 tok/s");
      expect(out).toContain("42.0s");
    });
  });
});