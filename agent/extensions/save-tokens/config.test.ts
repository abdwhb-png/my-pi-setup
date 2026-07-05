import { describe, expect, it } from "bun:test";
import {
  loadSaveTokensConfig,
  loadCompressorConfig,
  loadCavemanConfig,
  normalizeConfig,
} from "./config";

describe("config loader", () => {
  it("returns fallback shape when SettingsManager unavailable", () => {
    // In test env, SettingsManager.create() throws, so we get fallback
    // from mergeConfig({}, {}).  The caveman config may have a defaultLevel
    // set in the user's real settings.json, so we only check compressor.
    const cfg = loadSaveTokensConfig();
    expect(cfg).toHaveProperty("compressor");
    expect(typeof cfg.compressor).toBe("object");
  });

  it("loadCompressorConfig returns non-null object", () => {
    const cfg = loadCompressorConfig();
    expect(typeof cfg).toBe("object");
    expect(cfg).not.toBeNull();
  });

  it("loadCavemanConfig returns non-null object", () => {
    const cfg = loadCavemanConfig();
    expect(typeof cfg).toBe("object");
    expect(cfg).not.toBeNull();
  });

  it("normalizes archive, cap, and summary granularity settings", () => {
    expect(normalizeConfig({
      compressor: {
        archiveOriginal: true,
        capFallbackBytes: 12000,
        routingStrategy: "benchmark",
        summaryGranularity: "agent",
        ignored: "nope",
      },
    })).toEqual({
      compressor: {
        archiveOriginal: true,
        capFallbackBytes: 12000,
        routingStrategy: "benchmark",
        summaryGranularity: "agent",
      },
    });
  });

  it("drops invalid compressor notification settings", () => {
    expect(normalizeConfig({
      compressor: {
        archiveOriginal: "yes",
        capFallbackBytes: "12000",
        routingStrategy: "headroom",
        summaryGranularity: "session",
      },
    })).toEqual({});
  });
});
