import { describe, expect, it } from "bun:test";
import { buildTpsStatus, buildTpsSummary } from "./tps-status.ts";
import { buildTokenContent } from "./status-segments.ts";

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
      const state = {
        input: 1500,
        output: 3200,
        tps: 42,
        elapsedMs: 76_000,
      };
      const out = buildTpsStatus(state, colors);
      expect(out).toContain(buildTokenContent(state.input, state.output, colors));
      expect(out).toContain(String(state.tps));
      expect(out).toContain((state.elapsedMs / 1000).toFixed(1));
    });
  });

  describe("buildTpsSummary", () => {
    it("renders the final summary with in, out, tps and duration", () => {
      const state = {
        input: 900,
        output: 512,
        tps: 12,
        elapsedMs: 42_000,
      };
      const out = buildTpsSummary(state, colors);
      expect(out).toContain(buildTokenContent(state.input, state.output, colors));
      expect(out).toContain(String(state.tps));
      expect(out).toContain((state.elapsedMs / 1000).toFixed(1));
    });
  });
});
