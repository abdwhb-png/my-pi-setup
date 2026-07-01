import { describe, expect, it } from "bun:test";
import {
  loadSaveTokensConfig,
  loadCompressorConfig,
  loadCavemanConfig,
} from "./config";

describe("config loader", () => {
  it("returns empty sub-objects when SettingsManager unavailable", () => {
    // In test env, SettingsManager.create() throws, so we get fallback shape.
    // mergeConfig({}, {}) produces { compressor: {}, caveman: {} }.
    expect(loadSaveTokensConfig()).toEqual({ compressor: {}, caveman: {} });
  });

  it("loadCompressorConfig returns empty object", () => {
    const cfg = loadCompressorConfig();
    expect(typeof cfg).toBe("object");
    expect(Object.keys(cfg).length).toBe(0);
  });

  it("loadCavemanConfig returns empty object", () => {
    const cfg = loadCavemanConfig();
    expect(typeof cfg).toBe("object");
    expect(Object.keys(cfg).length).toBe(0);
  });
});
