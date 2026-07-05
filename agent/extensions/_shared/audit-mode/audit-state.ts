/**
 * Shared audit runtime state.
 *
 * Tiny getter/setter/reset API for the active audit profile.
 * Consumers read from here; the owner extension (audit-mode/index.ts) writes.
 *
 * No pi dependencies — plain module-level state.
 */

import { resolveAuditPolicy, type AuditProfileName, type AuditSettings, type ResolvedAuditPolicy } from "./audit-policy";

// Re-export for consumers that only need the snapshot type.
export type { AuditProfileName };
export type AuditStateSnapshot = ResolvedAuditPolicy;

// ─── Module-level runtime state ──────────────────────────────────────────────

let activeProfile: AuditProfileName = "standard";
let settingsOverride: AuditSettings | undefined;

// ─── Public API ──────────────────────────────────────────────────────────────

/** Return the name of the currently active audit profile. */
export function getActiveProfile(): AuditProfileName {
  return activeProfile;
}

/** Set the active audit profile. Called by the owner extension on command. */
export function setActiveProfile(name: AuditProfileName): void {
  activeProfile = name;
}

/**
 * Reset active profile to the given default (or "standard" if not provided).
 * Called e.g. on session start or when user runs /audit-mode off.
 * NOTE: does NOT clear settingsOverride — use resetAuditState() for a full reset.
 */
export function resetActiveProfile(defaultProfile: AuditProfileName = "standard"): void {
  activeProfile = defaultProfile;
}

/**
 * Full reset: clears both the active profile and any settings override.
 * Use this in tests or at session teardown to prevent state leakage.
 */
export function resetAuditState(defaultProfile: AuditProfileName = "standard"): void {
  activeProfile = defaultProfile;
  settingsOverride = undefined;
}

/**
 * Initialize audit state from merged settings.
 * Typically called by the owner extension on session_start.
 */
export function initAuditState(settings?: AuditSettings): void {
  settingsOverride = settings;
  const defaultProfile = settings?.defaultProfile ?? "standard";
  resetActiveProfile(defaultProfile);
}

/**
 * Return the fully-resolved policy for the currently active profile,
 * including any settings overrides loaded at init time.
 */
export function getActivePolicy(): AuditStateSnapshot {
  return resolveAuditPolicy(settingsOverride, activeProfile);
}
