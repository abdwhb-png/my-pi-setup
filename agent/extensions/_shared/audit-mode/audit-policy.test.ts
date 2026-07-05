import { describe, expect, it } from "bun:test";
import {
  DEFAULT_PROFILES,
  PROFILE_NAMES,
  normalizeAuditSettings,
  mergeAuditSettings,
  resolveAuditPolicy,
  type AuditProfileName,
  type AuditSettings,
} from "./audit-policy";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeSettings(overrides: Partial<AuditSettings>): AuditSettings {
  return { ...overrides };
}

// ─── profile names ──────────────────────────────────────────────────────────

describe("PROFILE_NAMES", () => {
  it("contains exactly standard, audit, advanced", () => {
    expect(PROFILE_NAMES).toEqual(["standard", "audit", "advanced"]);
  });
});

// ─── defaults ───────────────────────────────────────────────────────────────

describe("DEFAULT_PROFILES", () => {
  it("standard profile has all compression and restrictions on", () => {
    const p = DEFAULT_PROFILES.standard;
    expect(p.enforceNativeTools).toBe(true);
    expect(p["listing.showHidden"]).toBe(false);
    expect(p["find.ignoreGitignore"]).toBe(false);
    expect(p["grep.ignoreGitignore"]).toBe(false);
    expect(p["read.unchanged"]).toBe(true);
    expect(p["compression.disableForSearch"]).toBe(false);
    expect(p["compression.disableForRead"]).toBe(false);
    expect(p["compression.disableForShellResults"]).toBe(false);
  });

  it("audit profile relaxes native restrictions but keeps compression", () => {
    const p = DEFAULT_PROFILES.audit;
    expect(p.enforceNativeTools).toBe(false);
    expect(p["listing.showHidden"]).toBe(true);
    expect(p["find.ignoreGitignore"]).toBe(true);
    expect(p["grep.ignoreGitignore"]).toBe(true);
    expect(p["read.unchanged"]).toBe(true);
    expect(p["compression.disableForSearch"]).toBe(false);
    expect(p["compression.disableForRead"]).toBe(false);
    expect(p["compression.disableForShellResults"]).toBe(false);
  });

  it("advanced profile includes everything from audit plus compression relaxations", () => {
    const p = DEFAULT_PROFILES.advanced;
    expect(p.enforceNativeTools).toBe(false);
    expect(p["listing.showHidden"]).toBe(true);
    expect(p["find.ignoreGitignore"]).toBe(true);
    expect(p["grep.ignoreGitignore"]).toBe(true);
    expect(p["read.unchanged"]).toBe(true);
    expect(p["compression.disableForSearch"]).toBe(true);
    expect(p["compression.disableForRead"]).toBe(false);
    expect(p["compression.disableForShellResults"]).toBe(true);
  });
});

// ─── normalizeAuditSettings ─────────────────────────────────────────────────

describe("normalizeAuditSettings", () => {
  it("returns empty object for undefined input", () => {
    expect(normalizeAuditSettings(undefined)).toEqual({});
  });

  it("returns empty object for null input", () => {
    expect(normalizeAuditSettings(null)).toEqual({});
  });

  it("passes through valid fields unchanged", () => {
    const input: AuditSettings = {
      defaultProfile: "audit",
      profiles: { audit: { enforceNativeTools: false } },
    };
    const result = normalizeAuditSettings(input);
    expect(result.defaultProfile).toBe("audit");
    expect(result.profiles?.audit?.enforceNativeTools).toBe(false);
  });

  it("drops unknown defaultProfile value and falls back to undefined", () => {
    const result = normalizeAuditSettings({ defaultProfile: "unknown-profile" });
    expect(result.defaultProfile).toBeUndefined();
  });

  it("keeps valid defaultProfile", () => {
    for (const name of PROFILE_NAMES) {
      const result = normalizeAuditSettings({ defaultProfile: name });
      expect(result.defaultProfile).toBe(name);
    }
  });

  it("strips non-object profiles entry", () => {
    const result = normalizeAuditSettings({ profiles: "bad" });
    expect(result.profiles).toBeUndefined();
  });
});

// ─── mergeAuditSettings ─────────────────────────────────────────────────────

describe("mergeAuditSettings", () => {
  it("project settings override global settings for defaultProfile", () => {
    const global = makeSettings({ defaultProfile: "standard" });
    const project = makeSettings({ defaultProfile: "audit" });
    const merged = mergeAuditSettings(global, project);
    expect(merged.defaultProfile).toBe("audit");
  });

  it("global settings are used when project does not define defaultProfile", () => {
    const global = makeSettings({ defaultProfile: "advanced" });
    const project = makeSettings({});
    const merged = mergeAuditSettings(global, project);
    expect(merged.defaultProfile).toBe("advanced");
  });

  it("project profile overrides merge on top of global profile overrides", () => {
    const global = makeSettings({
      profiles: { audit: { enforceNativeTools: true, "listing.showHidden": true } },
    });
    const project = makeSettings({
      profiles: { audit: { enforceNativeTools: false } },
    });
    const merged = mergeAuditSettings(global, project);
    // project wins on enforceNativeTools
    expect(merged.profiles?.audit?.enforceNativeTools).toBe(false);
    // global survives for keys not overridden by project
    expect(merged.profiles?.audit?.["listing.showHidden"]).toBe(true);
  });

  it("undefined global produces result equal to project", () => {
    const project = makeSettings({ defaultProfile: "audit" });
    const merged = mergeAuditSettings(undefined, project);
    expect(merged.defaultProfile).toBe("audit");
  });

  it("undefined project produces result equal to global", () => {
    const global = makeSettings({ defaultProfile: "advanced" });
    const merged = mergeAuditSettings(global, undefined);
    expect(merged.defaultProfile).toBe("advanced");
  });
});

// ─── resolveAuditPolicy ─────────────────────────────────────────────────────

describe("resolveAuditPolicy", () => {
  it("resolves standard profile with no settings", () => {
    const policy = resolveAuditPolicy();
    expect(policy.name).toBe("standard");
    expect(policy.enforceNativeTools).toBe(DEFAULT_PROFILES.standard.enforceNativeTools);
  });

  it("uses defaultProfile from settings if valid", () => {
    const policy = resolveAuditPolicy(makeSettings({ defaultProfile: "audit" }));
    expect(policy.name).toBe("audit");
  });

  it("explicit profileName overrides defaultProfile in settings", () => {
    const policy = resolveAuditPolicy(makeSettings({ defaultProfile: "audit" }), "advanced");
    expect(policy.name).toBe("advanced");
  });

  it("profile overrides in settings are applied on top of defaults", () => {
    const settings = makeSettings({
      profiles: { audit: { "grep.ignoreGitignore": true } },
    });
    const policy = resolveAuditPolicy(settings, "audit");
    // custom override flips the default
    expect(policy["grep.ignoreGitignore"]).toBe(true);
    // other audit defaults still apply
    expect(policy.enforceNativeTools).toBe(false);
  });

  it("resolves all known profiles without throwing", () => {
    for (const name of PROFILE_NAMES) {
      expect(() => resolveAuditPolicy(undefined, name)).not.toThrow();
    }
  });

  it("unknown explicit profileName resolves to standard", () => {
    const policy = resolveAuditPolicy(undefined, "unknown");
    expect(policy.name).toBe("standard");
  });
});
