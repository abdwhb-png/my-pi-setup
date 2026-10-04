import {
    readExtensionConfig,
    isProjectConfigTrusted,
} from "../_shared/config-loader.ts";
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

import { type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import {
    normalizeAuditSettings,
    mergeAuditSettings,
    formatPolicySummary,
    type AuditSettings,
} from "../_shared/audit-mode/audit-policy.ts";
import type { AuditProfileName } from "../_shared/audit-mode/audit-policy.ts";
import {
    initAuditState,
    setActiveProfile,
    resetActiveProfile,
    getActiveProfile,
    getActivePolicy,
} from "../_shared/audit-mode/audit-state.ts";
import { createWidget } from "../_shared/fancy-footer.ts";
import {
    createUiColors,
    type UiColorsCreation,
} from "../_shared/ui/ui-colors.ts";

// ─── Config loading ───────────────────────────────────────────────────────────

function loadMergedSettings(
    cwd: string,
    projectTrusted: boolean,
): {
    settings: AuditSettings;
    hasProjectOverride: boolean;
} {
    const global = normalizeAuditSettings(
        readExtensionConfig("auditMode", { scope: "global" }),
    );
    const project = normalizeAuditSettings(
        isProjectConfigTrusted(cwd, undefined, projectTrusted)
            ? readExtensionConfig("auditMode", { scope: "project", cwd })
            : undefined,
    );
    return {
        settings: mergeAuditSettings(global, project),
        hasProjectOverride: Object.keys(project).length > 0,
    };
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
    const filtered = SUBCOMMANDS.filter(
        (cmd) => !trimmed || cmd.startsWith(trimmed),
    );
    return filtered.length > 0
        ? filtered.map((value) => ({ value, label: value }))
        : null;
}

// ─── Footer widget render ────────────────────────────────────────────────────

/** Magnifier glyph — matches the metaphor of reviewing changes. */
const AUDIT_ICON = "🔍";
const WIDGET_ID = "audit-mode";

/**
 * Pure render for the audit-mode footer widget.
 *
 * Returns a pre-themed composite string: a dim label (`🔍 audit:`) followed
 * by the profile value colored by severity (warning / primary). Hidden
 * (null) when the profile is `standard`. The widget contribution sets
 * `styled: true` so pi-fancy-footer uses this string verbatim.
 */
export function renderAuditWidget(
    theme: Theme,
    profile: AuditProfileName,
): string | null {
    if (profile === "standard") return null;
    const colors: UiColorsCreation = createUiColors(theme);
    const label = colors.subtle(`${AUDIT_ICON}audit:`);
    const value =
        profile === "audit" ? colors.warning(profile) : colors.primary(profile);
    return `${label} ${value}`;
}

// ─── Extension entry point ────────────────────────────────────────────────────

export default function activate(pi: ExtensionAPI) {
    // Track project override state across session_start for status display.
    let sessionHasProjectOverride = false;

    const w = createWidget(pi, {
        id: WIDGET_ID,
        label: "Audit Mode",
        description: "Shows the active audit-mode profile (audit or advanced).",
        row: 1,
        order: 14,
        align: "right",
        grow: false,
        styled: true,
        render: (ctx) => renderAuditWidget(ctx.theme, getActiveProfile()),
    });

    pi.on("session_start", (_event, ctx) => {
        const { settings, hasProjectOverride } = loadMergedSettings(
            ctx.cwd,
            ctx.isProjectTrusted(),
        );
        sessionHasProjectOverride = hasProjectOverride;
        initAuditState(settings);
        w.update(ctx);
    });

    pi.registerCommand("audit-mode", {
        description:
            "Toggle audit mode or show status (/audit-mode on|off|advanced|status)",
        getArgumentCompletions,
        handler: async (args, ctx) => {
            const arg = args.trim().toLowerCase();

            if (arg === "on") {
                setActiveProfile("audit");
                w.update(ctx);
                ctx.ui.notify("Audit mode activated (audit profile)", "info");
                return;
            }

            if (arg === "advanced") {
                setActiveProfile("advanced");
                w.update(ctx);
                ctx.ui.notify(
                    "Audit mode activated (advanced profile — compression relaxed)",
                    "info",
                );
                return;
            }

            if (arg === "off") {
                resetActiveProfile("standard");
                w.update(ctx);
                ctx.ui.notify(
                    "Audit mode off — reset to standard profile",
                    "info",
                );
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
