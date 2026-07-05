/**
 * Shared audit policy contract.
 *
 * Defines profile names, the settings schema, built-in defaults per profile,
 * normalization helpers, merge helpers, and the main resolver.
 *
 * No pi dependencies — pure data/logic only.
 */

// ─── Profile names ───────────────────────────────────────────────────────────

export const PROFILE_NAMES = ["standard", "audit", "advanced"] as const;
export type AuditProfileName = (typeof PROFILE_NAMES)[number];

// ─── Policy fields ───────────────────────────────────────────────────────────

export interface AuditProfilePolicy {
  /** When true, redirectable shell commands are strictly redirected to native built-ins (standard mode).
   *  When false, the caller only receives a soft "prefer-native" hint (audit/advanced mode). */
  enforceNativeTools: boolean;
  /** Whether to show hidden files in listing results. */
  "listing.showHidden": boolean;
  /** When true, find ignores .gitignore filters (shows gitignored files). */
  "find.ignoreGitignore": boolean;
  /** When true, grep ignores .gitignore filters (searches gitignored files). */
  "grep.ignoreGitignore": boolean;
  /** When true, read tool returns unchanged/verbatim content. */
  "read.unchanged": boolean;
  /** When true, compression is disabled for search tool results. */
  "compression.disableForSearch": boolean;
  /** When true, compression is disabled for read tool results. */
  "compression.disableForRead": boolean;
  /** When true, compression is disabled for shell tool results. */
  "compression.disableForShellResults": boolean;
}

/** A resolved policy includes the profile name it was resolved from. */
export interface ResolvedAuditPolicy extends AuditProfilePolicy {
  name: AuditProfileName;
}

// ─── Per-profile overrides shape in settings ────────────────────────────────

export type ProfileOverrides = Partial<AuditProfilePolicy>;
export type ProfileOverridesMap = Partial<Record<AuditProfileName, ProfileOverrides>>;

// ─── Settings shape (lives under auditMode key in settings.json) ─────────────

export interface AuditSettings {
  /** Which profile is active by default when the session starts. */
  defaultProfile?: AuditProfileName;
  /** Per-profile field overrides applied on top of built-in defaults. */
  profiles?: ProfileOverridesMap;
}

// ─── Built-in defaults ───────────────────────────────────────────────────────

export const DEFAULT_PROFILES: Record<AuditProfileName, AuditProfilePolicy> = {
  standard: {
    enforceNativeTools: true,
    "listing.showHidden": false,
    "find.ignoreGitignore": false,
    "grep.ignoreGitignore": false,
    "read.unchanged": true,
    "compression.disableForSearch": false,
    "compression.disableForRead": false,
    "compression.disableForShellResults": false,
  },
  audit: {
    enforceNativeTools: false,
    "listing.showHidden": true,
    "find.ignoreGitignore": true,
    "grep.ignoreGitignore": true,
    "read.unchanged": true,
    "compression.disableForSearch": false,
    "compression.disableForRead": false,
    "compression.disableForShellResults": false,
  },
  advanced: {
    enforceNativeTools: false,
    "listing.showHidden": true,
    "find.ignoreGitignore": true,
    "grep.ignoreGitignore": true,
    "read.unchanged": true,
    "compression.disableForSearch": true,
    "compression.disableForRead": false,
    "compression.disableForShellResults": true,
  },
};

// ─── Normalization ───────────────────────────────────────────────────────────

function isValidProfileName(value: string | undefined): value is AuditProfileName {
  return typeof value === "string" && (PROFILE_NAMES as readonly string[]).includes(value);
}

/**
 * Normalize raw settings input. Drops invalid values while preserving valid ones.
 * Safe to call with untrusted/partially-valid input (e.g., from JSON parse output).
 * Accepts null to handle results from JSON.parse gracefully.
 */
export function normalizeAuditSettings(input: AuditSettings | null | undefined): AuditSettings {
  if (!input || typeof input !== "object") return {};

  const result: AuditSettings = {};

  if (isValidProfileName(input.defaultProfile)) {
    result.defaultProfile = input.defaultProfile;
  }

  if (input.profiles && typeof input.profiles === "object" && !Array.isArray(input.profiles)) {
    const normalized: ProfileOverridesMap = {};
    for (const name of PROFILE_NAMES) {
      const override = input.profiles[name];
      if (override && typeof override === "object" && !Array.isArray(override)) {
        normalized[name] = override;
      }
    }
    if (Object.keys(normalized).length > 0) {
      result.profiles = normalized;
    }
  }

  return result;
}

// ─── Merge ───────────────────────────────────────────────────────────────────

/**
 * Merge global and project settings. Project settings take precedence.
 * Deep-merges per-profile overrides.
 */
export function mergeAuditSettings(
  global: AuditSettings | undefined,
  project: AuditSettings | undefined,
): AuditSettings {
  const g = global ?? {};
  const p = project ?? {};

  const result: AuditSettings = {
    defaultProfile: p.defaultProfile ?? g.defaultProfile,
  };

  if (!result.defaultProfile) {
    delete result.defaultProfile;
  }

  const gProfiles = g.profiles ?? {};
  const pProfiles = p.profiles ?? {};

  const allProfileNames = new Set<string>([
    ...Object.keys(gProfiles),
    ...Object.keys(pProfiles),
  ]);

  if (allProfileNames.size > 0) {
    const merged: ProfileOverridesMap = {};
    for (const name of allProfileNames) {
      if (!isValidProfileName(name)) continue;
      merged[name] = {
        ...gProfiles[name],
        ...pProfiles[name],
      };
    }
    result.profiles = merged;
  }

  return result;
}

// ─── Status rendering helper ──────────────────────────────────────────────────

/**
 * Format a resolved policy as a list of human-readable flag lines.
 * Derived from the actual keys in DEFAULT_PROFILES so no hardcoded key list is
 * needed in the owner extension.
 *
 * @returns Array of strings like `"enforceNativeTools: true"`.
 */
const STANDARD_PROFILE_KEYS = [
  "enforceNativeTools",
  "listing.showHidden",
  "find.ignoreGitignore",
  "grep.ignoreGitignore",
  "read.unchanged",
  "compression.disableForSearch",
  "compression.disableForRead",
  "compression.disableForShellResults",
] as const satisfies readonly (keyof AuditProfilePolicy)[];

export function formatPolicySummary(policy: ResolvedAuditPolicy): string[] {
  return STANDARD_PROFILE_KEYS.map((key) => `${key}: ${String(policy[key])}`);
}

// ─── Resolver ────────────────────────────────────────────────────────────────

/**
 * Resolve a fully-merged audit policy for the given profile name.
 *
 * Resolution order (last wins):
 *   built-in defaults → settings profile overrides → explicit profile name
 */
export function resolveAuditPolicy(
  settings?: AuditSettings,
  explicitProfile?: string,
): ResolvedAuditPolicy {
  const settingsDefault = settings?.defaultProfile;
  const profileName: AuditProfileName = isValidProfileName(explicitProfile)
    ? explicitProfile
    : isValidProfileName(settingsDefault)
      ? settingsDefault
      : "standard";

  const base: AuditProfilePolicy = { ...DEFAULT_PROFILES[profileName] };
  const overrides = settings?.profiles?.[profileName];

  if (overrides) {
    Object.assign(base, overrides);
  }

  return { name: profileName, ...base };
}
