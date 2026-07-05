/**
 * Shared audit tool routing helpers.
 *
 * Decision helpers for consumers (safe-bash, pi-overrides, save-tokens) to
 * determine how to behave given the currently active audit profile.
 *
 * No pi dependencies. No direct imports from other extensions.
 * Reads live state from audit-state only.
 */

import { getActivePolicy } from "./audit-state";

// ─── Public types ────────────────────────────────────────────────────────────

/** Lightweight description of a shell command about to be executed. */
export interface ShellCommand {
  /** Command name (e.g. "grep", "find", "ls"). */
  name: string;
  /** Command arguments. */
  args: string[];
}

/** The context in which compression would be applied. */
export type CompressionContext = "search" | "read" | "shell";

/** Advice for shell command routing. */
export type ShellRedirectAdvice =
  /** The shell command should be blocked and redirected to a native built-in. */
  | "redirect"
  /** The shell command is allowed but caller should suggest native equivalent. */
  | "prefer-native"
  /** The shell command is allowed as-is. */
  | "allow";

// ─── Redirectable command sets ───────────────────────────────────────────────

/** Shell commands that have native pi equivalents and may be redirected. */
const REDIRECTABLE_COMMANDS = new Set(["grep", "rg", "find", "fd", "ls"]);

// ─── Routing helpers ─────────────────────────────────────────────────────────

/**
 * Whether the active profile enforces strict redirection of shell commands to native built-ins.
 * When true (standard profile), redirectable commands are blocked and redirected.
 * When false (audit/advanced profiles), the caller only receives a soft "prefer-native" hint.
 */
export function shouldEnforceNativeTools(): boolean {
  return getActivePolicy().enforceNativeTools;
}

/**
 * Whether the active profile relaxes gitignore filtering for the given tool type.
 *
 * - "grep": affects grep/rg-like search
 * - "find": affects find/fd-like directory traversal
 *
 * Returns true when the caller should ignore gitignore (i.e., show gitignored results).
 */
export function shouldIgnoreGitignore(tool: "grep" | "find"): boolean {
  const policy = getActivePolicy();
  return tool === "grep" ? policy["grep.ignoreGitignore"] : policy["find.ignoreGitignore"];
}

/**
 * Whether the active profile should surface hidden files in listing results.
 */
export function shouldShowHidden(): boolean {
  return getActivePolicy()["listing.showHidden"];
}

/**
 * Whether the active profile should return read content verbatim (no transformation).
 */
export function shouldReturnUnchanged(): boolean {
  return getActivePolicy()["read.unchanged"];
}

/**
 * Whether compression should be disabled for the given context.
 *
 * - "search": grep / find / rg / fd tool results
 * - "read":   file read tool results
 * - "shell":  generic shell (bash / safe-bash) results
 */
export function shouldDisableCompression(context: CompressionContext): boolean {
  const policy = getActivePolicy();
  switch (context) {
    case "search":
      return policy["compression.disableForSearch"];
    case "read":
      return policy["compression.disableForRead"];
    case "shell":
      return policy["compression.disableForShellResults"];
    default: {
      const exhaustive: never = context;
      throw new Error(`Unhandled CompressionContext: ${String(exhaustive)}`);
    }
  }
}

/**
 * Routing advice for a shell command given the active audit profile.
 *
 * - standard:  redirectable commands → "redirect"; others → "allow"
 * - audit/advanced: redirectable commands → "prefer-native"; others → "allow"
 *
 * This helper does NOT apply danger/safety logic — that belongs to bash-guard.
 */
export function getShellRedirectAdvice(cmd: ShellCommand): ShellRedirectAdvice {
  if (!REDIRECTABLE_COMMANDS.has(cmd.name)) {
    return "allow";
  }

  const policy = getActivePolicy();
  if (policy.enforceNativeTools) {
    return "redirect";
  }

  return "prefer-native";
}
