/**
 * Audit-mode owner extension.
 *
 * Owns the `/audit-mode` command and is the sole writer of shared audit state.
 * Consumers (pi-overrides, safe-bash, save-tokens) read from _shared/audit-mode.
 *
 * Command surface:
 *   /audit-mode on       — activate audit profile
 *   /audit-mode off      — reset to standard profile
 *   /audit-mode advanced — activate advanced profile
 *   /audit-mode status   — display active profile, resolved flags, config source
 */

import { SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  normalizeAuditSettings,
  mergeAuditSettings,
  formatPolicySummary,
  type AuditSettings,
} from "../_shared/audit-mode/audit-policy.ts";
import {
  initAuditState,
  setActiveProfile,
  resetActiveProfile,
  getActiveProfile,
  getActivePolicy,
} from "../_shared/audit-mode/audit-state.ts";

// ─── Config loading ───────────────────────────────────────────────────────────

type SettingsRecord = Record<string, object | null | undefined>;

function isAuditSettings(value: object | null | undefined): value is AuditSettings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadMergedSettings(cwd: string): {
  settings: AuditSettings;
  hasProjectOverride: boolean;
} {
  let globalRaw: AuditSettings | null = null;
  let projectRaw: AuditSettings | null = null;

  try {
    const manager = SettingsManager.create(cwd);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const globalSettings = manager.getGlobalSettings() as SettingsRecord;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const projectSettings = manager.getProjectSettings() as SettingsRecord;
    if (isAuditSettings(globalSettings.auditMode)) globalRaw = globalSettings.auditMode;
    if (isAuditSettings(projectSettings.auditMode)) projectRaw = projectSettings.auditMode;
  } catch {
    // If settings cannot be loaded, fall back to defaults
  }

  const global = normalizeAuditSettings(globalRaw);
  const project = normalizeAuditSettings(projectRaw);
  const merged = mergeAuditSettings(global, project);

  const hasProjectOverride = Object.keys(project).length > 0;

  return { settings: merged, hasProjectOverride };
}

// ─── Status rendering ─────────────────────────────────────────────────────────

function renderStatus(hasProjectOverride: boolean): string {
  const profile = getActiveProfile();
  const policy = getActivePolicy();

  const overrideLabel = hasProjectOverride
    ? "project config: YES (project overrides global)"
    : "project config: NO (using global / defaults)";

  const flags = formatPolicySummary(policy);

  return [
    `Audit Mode — profile: ${profile}`,
    "",
    "Resolved flags:",
    ...flags.map((f) => `  ${f}`),
    "",
    overrideLabel,
    "",
    "Usage: /audit-mode [on|off|advanced|status]",
  ].join("\n");
}

// ─── Completions ─────────────────────────────────────────────────────────────

const SUBCOMMANDS = ["on", "off", "advanced", "status"] as const;

function getArgumentCompletions(prefix: string) {
  const trimmed = prefix.trimStart().toLowerCase();
  const filtered = SUBCOMMANDS.filter((cmd) => !trimmed || cmd.startsWith(trimmed));
  return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
}

// ─── Extension entry point ────────────────────────────────────────────────────

export default function activate(pi: ExtensionAPI) {
  // Track project override state across session_start for status display.
  let sessionHasProjectOverride = false;

  pi.on("session_start", (_event, ctx) => {
    const { settings, hasProjectOverride } = loadMergedSettings(ctx.cwd);
    sessionHasProjectOverride = hasProjectOverride;
    initAuditState(settings);
  });

  pi.registerCommand("audit-mode", {
    description:
      "Toggle audit mode or show status (/audit-mode on|off|advanced|status)",
    getArgumentCompletions,
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg === "on") {
        setActiveProfile("audit");
        ctx.ui.notify("Audit mode activated (audit profile)", "info");
        return;
      }

      if (arg === "advanced") {
        setActiveProfile("advanced");
        ctx.ui.notify(
          "Audit mode activated (advanced profile — compression relaxed)",
          "info",
        );
        return;
      }

      if (arg === "off") {
        resetActiveProfile("standard");
        ctx.ui.notify("Audit mode off — reset to standard profile", "info");
        return;
      }

      if (arg === "status" || arg === "") {
        const status = renderStatus(sessionHasProjectOverride);
        ctx.ui.notify(status, "info");
        return;
      }

      ctx.ui.notify(
        `Unknown argument: "${arg}"\nUsage: /audit-mode [on|off|advanced|status]`,
        "error",
      );
    },
  });
}
