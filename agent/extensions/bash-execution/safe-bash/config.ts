/**
 * Config loader for the safe-bash extension.
 *
 * Reads the `safeBash` key from settings.json (global + project) via the
 * shared config-loader. Project settings override global.
 *
 * Schema is documented in `safe-bash/README.md`. Unknown or invalid values
 * fall back to defaults while valid global/project fields merge per layer.
 */
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { DANGER_GROUP_IDS } from "../../_shared/command-execution/guard.ts";
import type { CommandGuardPolicy } from "../../_shared/command-execution/policy.ts";
import { loadExtensionConfig } from "../../_shared/config-loader.ts";
import { SAFE_BASH_AUDIT_BOUNDS } from "./telemetry/types.ts";

export type SafeBashMode = "coexist" | "replace";
export type SafeBashGuardPolicy = CommandGuardPolicy;

export interface SafeBashTelemetryConfig {
    enabled: boolean;
    directory: string;
    retentionDays: number;
    captureCommand: boolean;
    maxCommandLength: number;
    auditDays: number;
    auditLimit: number;
}

export interface SafeBashConfig {
    mode: SafeBashMode;
    /**
     * Shell commands (by first word) allowed to bypass native-tool redirection
     * in standard profile. Empty = redirection enforced as usual.
     * `isDangerous()` still runs on these commands — only the redirect is bypassed.
     */
    allowedShellCommands: string[];
    /** Per-danger-group action. Missing groups default to `deny`. */
    guardPolicy: Record<string, SafeBashGuardPolicy>;
    /** Local, redacted command-attempt telemetry used by `/safe-bash-audit`. */
    telemetry: SafeBashTelemetryConfig;
}

export const DEFAULT_SAFE_BASH_CONFIG: SafeBashConfig = {
    mode: "coexist",
    allowedShellCommands: [],
    guardPolicy: {},
    telemetry: {
        enabled: true,
        directory: "~/.pi/agent/safe-bash-telemetry",
        retentionDays: 30,
        captureCommand: true,
        maxCommandLength: 10_000,
        auditDays: 30,
        auditLimit: 100,
    },
};

function isPositiveInteger(value: unknown): value is number {
    return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        Number.isInteger(value) &&
        value > 0
    );
}

function normalizeTelemetry(raw: unknown): Partial<SafeBashTelemetryConfig> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return {};
    }
    const obj = raw as Record<string, unknown>;
    const result: Partial<SafeBashTelemetryConfig> = {};

    if (typeof obj.enabled === "boolean") result.enabled = obj.enabled;
    if (typeof obj.directory === "string" && obj.directory.trim()) {
        result.directory = obj.directory;
    }
    if (typeof obj.captureCommand === "boolean") {
        result.captureCommand = obj.captureCommand;
    }
    for (const key of ["retentionDays", "maxCommandLength"] as const) {
        if (isPositiveInteger(obj[key])) result[key] = obj[key];
    }
    if (
        isPositiveInteger(obj.auditDays) &&
        obj.auditDays <= SAFE_BASH_AUDIT_BOUNDS.days
    ) {
        result.auditDays = obj.auditDays;
    }
    if (
        isPositiveInteger(obj.auditLimit) &&
        obj.auditLimit <= SAFE_BASH_AUDIT_BOUNDS.limit
    ) {
        result.auditLimit = obj.auditLimit;
    }
    return result;
}

/**
 * Normalize raw JSON → Partial<SafeBashConfig>.
 * Keeps only valid `mode`, `allowedShellCommands`, `guardPolicy`, and telemetry fields.
 */
export function normalizeSafeBashConfig(raw: unknown): Partial<SafeBashConfig> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return {};
    }
    const obj = raw as Record<string, unknown>;
    const result: Partial<SafeBashConfig> = {};

    const mode = obj.mode;
    if (mode === "replace" || mode === "coexist") {
        result.mode = mode;
    }

    const allowed = obj.allowedShellCommands;
    if (Array.isArray(allowed)) {
        const filtered = allowed.filter(
            (entry): entry is string => typeof entry === "string",
        );
        if (filtered.length > 0) {
            result.allowedShellCommands = filtered;
        }
    }

    const telemetry = normalizeTelemetry(obj.telemetry);
    if (Object.keys(telemetry).length > 0)
        result.telemetry = telemetry as SafeBashTelemetryConfig;

    const guardPolicyRaw = obj.guardPolicy;
    if (
        typeof guardPolicyRaw === "object" &&
        guardPolicyRaw !== null &&
        !Array.isArray(guardPolicyRaw)
    ) {
        const knownGroups = new Set(DANGER_GROUP_IDS);
        const filtered: Record<string, SafeBashGuardPolicy> = {};
        for (const [groupId, value] of Object.entries(
            guardPolicyRaw as Record<string, unknown>,
        )) {
            if (
                knownGroups.has(groupId) &&
                (value === "ask" || value === "deny" || value === "allow")
            ) {
                filtered[groupId] = value;
            }
        }
        if (Object.keys(filtered).length > 0) result.guardPolicy = filtered;
    }

    return result;
}

/**
 * Load safe-bash config from settings.json via the shared config-loader.
 *
 * @param cwd - Working directory (defaults to process.cwd())
 * @param agentDir - Agent directory override (for testing)
 * @param _settingsManager - Injected SettingsManager (for testing)
 */
export function loadSafeBashConfig(
    cwd: string = process.cwd(),
    agentDir?: string,
    _settingsManager?: SettingsManager,
): SafeBashConfig {
    return loadExtensionConfig<SafeBashConfig>(cwd, {
        defaults: DEFAULT_SAFE_BASH_CONFIG,
        normalize: normalizeSafeBashConfig,
        merge: (base, overlay) => ({
            ...base,
            ...overlay,
            guardPolicy: {
                ...base.guardPolicy,
                ...overlay.guardPolicy,
            },
            telemetry: {
                ...base.telemetry,
                ...overlay.telemetry,
            },
        }),
        sources: [{ settingsKey: "safeBash" }],
        agentDir,
        _settingsManager,
    });
}
