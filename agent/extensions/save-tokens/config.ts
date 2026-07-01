/**
 * save-tokens config loader
 *
 * Reads config from settings.json under the "saveTokens" key.
 * Merges global (~/.pi/agent/settings.json) and project-local (<cwd>/.pi/settings.json).
 *
 * Example settings.json:
 * {
 *   "saveTokens": {
 *     "compressor": {
 *       "showStatus": false
 *     },
 *     "caveman": {
 *       "defaultLevel": "full",
 *       "showStatus": true
 *     }
 *   }
 * }
 */

import { SettingsManager } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface CompressorConfig {
  baseUrl?: string;
  agent?: string;
  timeoutMs?: number;
  showStatus?: boolean;
  showWidget?: boolean;
}

export interface CavemanConfig {
  defaultLevel?: string;
  showStatus?: boolean;
}

export interface SaveTokensConfig {
  compressor?: CompressorConfig;
  caveman?: CavemanConfig;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: SaveTokensConfig = {};

// ---------------------------------------------------------------------------
// Normalization (from raw settings.json values)
// ---------------------------------------------------------------------------

/** Non-recursive loose dict for safe property reads (avoids `any`/`unknown`). */
interface LooseDict {
  [key: string]: string | number | boolean | null | object;
}

function normalizeCompressor(raw: object): CompressorConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const r = raw as LooseDict;
  const out: CompressorConfig = {};
  if (typeof r.baseUrl === "string") out.baseUrl = r.baseUrl;
  if (typeof r.agent === "string") out.agent = r.agent;
  if (typeof r.timeoutMs === "number") out.timeoutMs = r.timeoutMs;
  if (typeof r.showStatus === "boolean") out.showStatus = r.showStatus;
  if (typeof r.showWidget === "boolean") out.showWidget = r.showWidget;
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeCaveman(raw: object): CavemanConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const r = raw as LooseDict;
  const out: CavemanConfig = {};
  if (typeof r.defaultLevel === "string") out.defaultLevel = r.defaultLevel;
  if (typeof r.showStatus === "boolean") out.showStatus = r.showStatus;
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeConfig(raw: object): Partial<SaveTokensConfig> {
  if (!raw || typeof raw !== "object") return {};
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const r = raw as LooseDict;
  const cv = r.compressor;
  const ca = r.caveman;
  const compressor = typeof cv === "object" && cv !== null
    ? normalizeCompressor(cv)
    : undefined;
  const caveman = typeof ca === "object" && ca !== null
    ? normalizeCaveman(ca)
    : undefined;
  return { ...(compressor ? { compressor } : {}), ...(caveman ? { caveman } : {}) };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function mergeConfig(
  base: SaveTokensConfig,
  overrides: Partial<SaveTokensConfig>,
): SaveTokensConfig {
  return {
    compressor: { ...base.compressor, ...overrides.compressor },
    caveman: { ...base.caveman, ...overrides.caveman },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function loadSaveTokensConfig(cwd = process.cwd()): SaveTokensConfig {
  let globalConfig: Partial<SaveTokensConfig> = {};
  let projectConfig: Partial<SaveTokensConfig> = {};

  try {
    const manager = SettingsManager.create(cwd);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const globalSettings = manager.getGlobalSettings() as LooseDict;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const projectSettings = manager.getProjectSettings() as LooseDict;
    const st = globalSettings.saveTokens;
    const sp = projectSettings.saveTokens;
    globalConfig = typeof st === "object" && st !== null ? normalizeConfig(st) : {};
    projectConfig = typeof sp === "object" && sp !== null ? normalizeConfig(sp) : {};
  } catch {
    // not in pi runtime or settings inaccessible
  }

  return mergeConfig(mergeConfig(DEFAULT_CONFIG, globalConfig), projectConfig);
}

export function loadCompressorConfig(cwd = process.cwd()): CompressorConfig {
  return loadSaveTokensConfig(cwd).compressor ?? {};
}

export function loadCavemanConfig(cwd = process.cwd()): CavemanConfig {
  return loadSaveTokensConfig(cwd).caveman ?? {};
}
