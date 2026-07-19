import { loadCompressorConfig } from "./config";
import type { LocalCompressorConfig } from "./tool-results/types";

const DEFAULT_COMPRESSOR_BASE_URL = "http://127.0.0.1:8320";
const DEFAULT_AGENT = "claude";
const DEFAULT_TIMEOUT_MS = 800;

export function getLocalCompressorConfig(cwd = process.cwd()): LocalCompressorConfig {
  const cfg = loadCompressorConfig(cwd);

  const baseUrl = process.env.EDGEE_COMPRESSOR_BASE_URL?.trim() || cfg.baseUrl || DEFAULT_COMPRESSOR_BASE_URL;
  const agent = process.env.EDGEE_COMPRESSOR_AGENT?.trim() || cfg.agent || DEFAULT_AGENT;
  const timeoutRaw = process.env.EDGEE_COMPRESSOR_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : (cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  return {
    baseUrl,
    agent,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS,
    showStatus: cfg.showStatus ?? false,
    showWidget: cfg.showWidget ?? true,
    archiveOriginal: cfg.archiveOriginal ?? false,
    ...(typeof cfg.capFallbackBytes === "number" && cfg.capFallbackBytes > 0 ? { capFallbackBytes: cfg.capFallbackBytes } : {}),
    routingStrategy: cfg.routingStrategy ?? "edgee",
    summaryGranularity: cfg.summaryGranularity ?? "all",
    enabled: cfg.enabled ?? true,
    excludeTools: cfg.excludeTools ?? [],
    minBytes: cfg.minBytes ?? 0,
  };
}