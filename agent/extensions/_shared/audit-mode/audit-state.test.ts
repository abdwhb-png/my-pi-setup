import { describe, expect, it, beforeEach } from "bun:test";
import {
  getActiveProfile,
  setActiveProfile,
  resetActiveProfile,
  resetAuditState,
  getActivePolicy,
  initAuditState,
  type AuditStateSnapshot,
} from "./audit-state";
import { DEFAULT_PROFILES } from "./audit-policy";

// ─── helpers ────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetAuditState();
});

// ─── get/set/reset ──────────────────────────────────────────────────────────

describe("setActiveProfile / getActiveProfile", () => {
  it("defaults to standard before any set", () => {
    expect(getActiveProfile()).toBe("standard");
  });

  it("set to audit, get returns audit", () => {
    setActiveProfile("audit");
    expect(getActiveProfile()).toBe("audit");
  });

  it("set to advanced, get returns advanced", () => {
    setActiveProfile("advanced");
    expect(getActiveProfile()).toBe("advanced");
  });

  it("reset returns to standard", () => {
    setActiveProfile("advanced");
    resetActiveProfile();
    expect(getActiveProfile()).toBe("standard");
  });

  it("reset with explicit default returns that default", () => {
    setActiveProfile("advanced");
    resetActiveProfile("audit");
    expect(getActiveProfile()).toBe("audit");
  });
});

// ─── getActivePolicy ────────────────────────────────────────────────────────

describe("getActivePolicy", () => {
  it("returns standard policy when profile is standard", () => {
    const policy = getActivePolicy();
    expect(policy.name).toBe("standard");
    expect(policy.enforceNativeTools).toBe(DEFAULT_PROFILES.standard.enforceNativeTools);
  });

  it("returns audit policy after setActiveProfile audit", () => {
    setActiveProfile("audit");
    const policy = getActivePolicy();
    expect(policy.name).toBe("audit");
    expect(policy.enforceNativeTools).toBe(false);
  });

  it("returns advanced policy after setActiveProfile advanced", () => {
    setActiveProfile("advanced");
    const policy = getActivePolicy();
    expect(policy.name).toBe("advanced");
    expect(policy["compression.disableForSearch"]).toBe(true);
  });
});

// ─── initAuditState ─────────────────────────────────────────────────────────

describe("initAuditState", () => {
  it("sets profile to supplied defaultProfile from settings", () => {
    initAuditState({ defaultProfile: "audit" });
    expect(getActiveProfile()).toBe("audit");
  });

  it("sets profile to standard when no settings supplied", () => {
    initAuditState();
    expect(getActiveProfile()).toBe("standard");
  });

  it("does not throw with undefined settings", () => {
    expect(() => initAuditState(undefined)).not.toThrow();
  });
});

// ─── snapshot shape ─────────────────────────────────────────────────────────

describe("AuditStateSnapshot type", () => {
  it("getActivePolicy returns object matching snapshot shape", () => {
    const policy = getActivePolicy();
    const snap: AuditStateSnapshot = policy;
    expect(typeof snap.name).toBe("string");
    expect(typeof snap.enforceNativeTools).toBe("boolean");
  });
});

// ─── resetAuditState ────────────────────────────────────────────────────────

describe("resetAuditState", () => {
  it("clears settingsOverride so policy reverts to pure defaults", () => {
    // Apply settings with an override that flips a field
    initAuditState({
      defaultProfile: "audit",
      profiles: { audit: { "listing.showHidden": false } },
    });
    expect(getActiveProfile()).toBe("audit");
    // Now full-reset
    resetAuditState();
    expect(getActiveProfile()).toBe("standard");
    // Policy should use pure defaults again (no override remnant)
    const policy = getActivePolicy();
    expect(policy["listing.showHidden"]).toBe(false); // standard default
  });

  it("accepts explicit default profile", () => {
    resetAuditState("audit");
    expect(getActiveProfile()).toBe("audit");
  });
});

// ─── end-to-end: settings overrides flow through initAuditState → routing ───

describe("initAuditState settings overrides → routing helpers (end-to-end)", () => {
  it("settings override for audit profile flows into getActivePolicy", () => {
    initAuditState({
      defaultProfile: "audit",
      profiles: {
        audit: {
          "listing.showHidden": false,
          "compression.disableForSearch": true,
        },
      },
    });
    const policy = getActivePolicy();
    expect(policy.name).toBe("audit");
    // overridden fields
    expect(policy["listing.showHidden"]).toBe(false);
    expect(policy["compression.disableForSearch"]).toBe(true);
    // non-overridden audit defaults still intact
    expect(policy.enforceNativeTools).toBe(false);
    expect(policy["grep.ignoreGitignore"]).toBe(true);
  });

  it("settings override for standard profile enforceNativeTools flows through", () => {
    initAuditState({
      profiles: {
        standard: { enforceNativeTools: false },
      },
    });
    // activeProfile stays standard (defaultProfile not set)
    const policy = getActivePolicy();
    expect(policy.name).toBe("standard");
    expect(policy.enforceNativeTools).toBe(false);
  });
});
