/**
 * Per-project Think-in-Code configuration.
 *
 * Storage location: ~/.pi/agent/think-in-code/projects/<sha256(realpath(cwd))>
 * Loaded via loadExtensionConfig (settings.json key "thinkInCode" with legacy
 * "think-in-code.json" fallback). The home is always resolved through
 * `homedir()` at runtime — never hardcoded — so test fixtures can target a
 * disposable directory.
 *
 * Limits are downward-only: malformed or out-of-range user values fall back to
 * defaults rather than widening the ceiling.
 */

import { homedir } from "node:os";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { DANGER_GROUP_IDS } from "../_shared/command-execution/guard.ts";
import type { CommandGuardPolicy } from "../_shared/command-execution/policy.ts";
import {
    normalizeCommandRewriteRules,
    type BashRewriteRule,
} from "../_shared/command-execution/rewrites.ts";
import { loadExtensionConfig } from "../_shared/config-loader.ts";
import { THINK_AUDIT_BOUNDS } from "./telemetry/types.ts";

export const THINK_IN_CODE_SETTINGS_KEY = "thinkInCode";
export const THINK_IN_CODE_LEGACY_FILE = "think-in-code.json";

export const DEFAULT_THINK_IN_CODE_CONFIG: ThinkInCodeConfig = Object.freeze({
    languages: ["javascript", "typescript", "python"],
    retentionHours: 24,
    projectQuotaBytes: 512 * 1024 * 1024,
    restoreTokenBudget: 1500,
    searchSnippetChars: 240,
    indexedSnippetChars: 1024,
    maxResultBytes: 64 * 1024,
    batchConcurrency: 2,
    maxBatchCommands: 16,
    network: false,
    commandPolicy: {
        allowedShellCommands: [],
        guardPolicy: {},
        rewrites: [],
    },
    telemetry: {
        enabled: true,
        retentionDays: 30,
        captureCommand: true,
        maxCommandLength: 10_000,
        auditDays: 30,
        auditLimit: 100,
    },
});

export interface ThinkCommandPolicyConfig {
    allowedShellCommands: string[];
    guardPolicy: Record<string, CommandGuardPolicy>;
    rewrites: BashRewriteRule[];
}

export interface ThinkTelemetryConfig {
    enabled: boolean;
    retentionDays: number;
    captureCommand: boolean;
    maxCommandLength: number;
    auditDays: number;
    auditLimit: number;
}

export interface ThinkInCodeConfig {
    /** Languages the analyzer accepts. Fixed set: javascript/typescript/python. */
    languages: readonly string[];
    /** Time-to-live for raw archives and indexed rows. Hours, downward clamped. */
    retentionHours: number;
    /** Maximum bytes per project store. Bytes, downward clamped to ≤ 512 MiB. */
    projectQuotaBytes: number;
    /** Token budget for the post-compaction restore message. */
    restoreTokenBudget: number;
    /** Maximum characters of a search-result snippet. */
    searchSnippetChars: number;
    /** Maximum characters of text indexed per document. */
    indexedSnippetChars: number;
    /** Maximum derived text returned to Pi by any single think_* tool. */
    maxResultBytes: number;
    /** Concurrent commands for think_execute action=batch. Hard ceiling 2. */
    batchConcurrency: number;
    /** Maximum commands in one think_execute action=batch call. */
    maxBatchCommands: number;
    /**
     * Network access for the analyzer / archive pipeline.
     * Always `false`. Exists so legacy callers cannot widen the policy.
     */
    network: false;
    /** Command policy owned by Think-in-Code; never inherited from safeBash. */
    commandPolicy: ThinkCommandPolicyConfig;
    /** Per-project private command-attempt telemetry. */
    telemetry: ThinkTelemetryConfig;
}

export interface ThinkInCodeConfigLimits {
    /** Hard ceiling for retentionHours. Default: 24. */
    maxRetentionHours?: number;
    /** Hard ceiling for projectQuotaBytes. Default: 512 MiB. */
    maxProjectQuotaBytes?: number;
    /** Hard ceiling for restoreTokenBudget. Default: 1500. */
    maxRestoreTokenBudget?: number;
    /** Hard ceiling for searchSnippetChars. Default: 240. */
    maxSearchSnippetChars?: number;
    /** Hard ceiling for indexedSnippetChars. Default: 1024. */
    maxIndexedSnippetChars?: number;
    /** Hard ceiling for maxResultBytes. Default: 64 KiB. */
    maxResultBytes?: number;
    /** Hard ceiling for batchConcurrency. Default: 2. */
    maxBatchConcurrency?: number;
    /** Hard ceiling for maxBatchCommands. Default: 16. */
    maxBatchCommands?: number;
}

const DEFAULT_LIMITS: Required<ThinkInCodeConfigLimits> = Object.freeze({
    maxRetentionHours: 24,
    maxProjectQuotaBytes: 512 * 1024 * 1024,
    maxRestoreTokenBudget: 1500,
    maxSearchSnippetChars: 240,
    maxIndexedSnippetChars: 1024,
    maxResultBytes: 64 * 1024,
    maxBatchConcurrency: 2,
    maxBatchCommands: 16,
});

const ALLOWED_LANGUAGES: ReadonlySet<string> = new Set([
    "javascript",
    "typescript",
    "python",
]);

function isPositiveInteger(value: unknown): value is number {
    return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        Number.isInteger(value) &&
        value > 0
    );
}

function clampDown(
    name: keyof ThinkInCodeConfigLimits,
    value: unknown,
    ceiling: number,
): number {
    if (!isPositiveInteger(value)) return ceiling;
    return Math.min(value, ceiling);
}

const THINK_REWRITE_PROFILES: ReadonlySet<string> = new Set([
    "think_execute",
    "think_batch_execute",
]);

function normalizeGuardPolicy(
    raw: unknown,
): Record<string, CommandGuardPolicy> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return {};
    }
    const knownGroups = new Set(DANGER_GROUP_IDS);
    const result: Record<string, CommandGuardPolicy> = {};
    for (const [groupId, value] of Object.entries(
        raw as Record<string, unknown>,
    )) {
        if (
            knownGroups.has(groupId) &&
            (value === "ask" || value === "deny" || value === "allow")
        ) {
            result[groupId] = value;
        }
    }
    return result;
}

function normalizeCommandPolicy(raw: unknown): ThinkCommandPolicyConfig {
    const defaults = DEFAULT_THINK_IN_CODE_CONFIG.commandPolicy;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return {
            allowedShellCommands: [...defaults.allowedShellCommands],
            guardPolicy: { ...defaults.guardPolicy },
            rewrites: [...defaults.rewrites],
        };
    }
    const record = raw as Record<string, unknown>;
    return {
        allowedShellCommands: Array.isArray(record.allowedShellCommands)
            ? record.allowedShellCommands.filter(
                  (entry): entry is string => typeof entry === "string",
              )
            : [...defaults.allowedShellCommands],
        guardPolicy: Object.hasOwn(record, "guardPolicy")
            ? normalizeGuardPolicy(record.guardPolicy)
            : { ...defaults.guardPolicy },
        rewrites: Array.isArray(record.rewrites)
            ? normalizeCommandRewriteRules(
                  record.rewrites,
                  THINK_REWRITE_PROFILES,
              )
            : [...defaults.rewrites],
    };
}

function normalizeCommandPolicyOverlay(
    raw: unknown,
): Partial<ThinkCommandPolicyConfig> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return {};
    }
    const record = raw as Record<string, unknown>;
    const normalized = normalizeCommandPolicy(record);
    const overlay: Partial<ThinkCommandPolicyConfig> = {};
    for (const key of [
        "allowedShellCommands",
        "guardPolicy",
        "rewrites",
    ] as const) {
        if (Object.hasOwn(record, key)) overlay[key] = normalized[key] as never;
    }
    return overlay;
}

function normalizeTelemetry(raw: unknown): ThinkTelemetryConfig {
    const defaults = DEFAULT_THINK_IN_CODE_CONFIG.telemetry;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return { ...defaults };
    }
    const record = raw as Record<string, unknown>;
    const positive = (key: string, fallback: number, ceiling?: number) => {
        const value = record[key];
        if (!isPositiveInteger(value)) return fallback;
        return ceiling === undefined ? value : Math.min(value, ceiling);
    };
    return {
        enabled:
            typeof record.enabled === "boolean"
                ? record.enabled
                : defaults.enabled,
        retentionDays: positive("retentionDays", defaults.retentionDays, 30),
        captureCommand:
            typeof record.captureCommand === "boolean"
                ? record.captureCommand
                : defaults.captureCommand,
        maxCommandLength: positive(
            "maxCommandLength",
            defaults.maxCommandLength,
            10_000,
        ),
        auditDays: positive(
            "auditDays",
            defaults.auditDays,
            THINK_AUDIT_BOUNDS.days,
        ),
        auditLimit: positive(
            "auditLimit",
            defaults.auditLimit,
            THINK_AUDIT_BOUNDS.limit,
        ),
    };
}

function normalizeTelemetryOverlay(
    raw: unknown,
): Partial<ThinkTelemetryConfig> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return {};
    }
    const record = raw as Record<string, unknown>;
    const normalized = normalizeTelemetry(record);
    const overlay: Partial<ThinkTelemetryConfig> = {};
    for (const key of Object.keys(
        DEFAULT_THINK_IN_CODE_CONFIG.telemetry,
    ) as Array<keyof ThinkTelemetryConfig>) {
        if (Object.hasOwn(record, key)) {
            Object.assign(overlay, { [key]: normalized[key] });
        }
    }
    return overlay;
}

export function normalizeThinkInCodeConfig(
    raw: unknown,
    limits: ThinkInCodeConfigLimits = {},
): ThinkInCodeConfig {
    const effectiveLimits = { ...DEFAULT_LIMITS, ...limits };
    const defaults = DEFAULT_THINK_IN_CODE_CONFIG;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return { ...defaults };
    }
    const record = raw as Record<string, unknown>;

    let languages = [...defaults.languages];
    if (Array.isArray(record.languages)) {
        const filtered = record.languages.filter(
            (lang): lang is string =>
                typeof lang === "string" && ALLOWED_LANGUAGES.has(lang),
        );
        if (filtered.length > 0) languages = filtered;
    }

    return {
        languages,
        retentionHours: clampDown(
            "maxRetentionHours",
            record.retentionHours,
            effectiveLimits.maxRetentionHours,
        ),
        projectQuotaBytes: clampDown(
            "maxProjectQuotaBytes",
            record.projectQuotaBytes,
            effectiveLimits.maxProjectQuotaBytes,
        ),
        restoreTokenBudget: clampDown(
            "maxRestoreTokenBudget",
            record.restoreTokenBudget,
            effectiveLimits.maxRestoreTokenBudget,
        ),
        searchSnippetChars: clampDown(
            "maxSearchSnippetChars",
            record.searchSnippetChars,
            effectiveLimits.maxSearchSnippetChars,
        ),
        indexedSnippetChars: clampDown(
            "maxIndexedSnippetChars",
            record.indexedSnippetChars,
            effectiveLimits.maxIndexedSnippetChars,
        ),
        maxResultBytes: clampDown(
            "maxResultBytes",
            record.maxResultBytes,
            effectiveLimits.maxResultBytes,
        ),
        batchConcurrency: clampDown(
            "maxBatchConcurrency",
            record.batchConcurrency,
            effectiveLimits.maxBatchConcurrency,
        ),
        maxBatchCommands: clampDown(
            "maxBatchCommands",
            record.maxBatchCommands,
            effectiveLimits.maxBatchCommands,
        ),
        // Network is intentionally non-configurable.
        network: false,
        commandPolicy: normalizeCommandPolicy(record.commandPolicy),
        telemetry: normalizeTelemetry(record.telemetry),
    };
}

function normalizeThinkInCodeOverlay(raw: unknown): Partial<ThinkInCodeConfig> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        return {};
    const record = raw as Record<string, unknown>;
    const normalized = normalizeThinkInCodeConfig(record);
    const overlay: Partial<ThinkInCodeConfig> = {};
    for (const key of Object.keys(DEFAULT_THINK_IN_CODE_CONFIG) as Array<
        keyof ThinkInCodeConfig
    >) {
        if (
            Object.hasOwn(record, key) &&
            key !== "network" &&
            key !== "commandPolicy" &&
            key !== "telemetry"
        ) {
            Object.assign(overlay, { [key]: normalized[key] });
        }
    }
    if (Object.hasOwn(record, "commandPolicy")) {
        overlay.commandPolicy = normalizeCommandPolicyOverlay(
            record.commandPolicy,
        ) as ThinkCommandPolicyConfig;
    }
    if (Object.hasOwn(record, "telemetry")) {
        overlay.telemetry = normalizeTelemetryOverlay(
            record.telemetry,
        ) as ThinkTelemetryConfig;
    }
    return overlay;
}

export function loadThinkInCodeConfig(
    cwd: string,
    agentDir?: string,
    settingsManager?: SettingsManager,
): ThinkInCodeConfig {
    return loadExtensionConfig(cwd, {
        defaults: DEFAULT_THINK_IN_CODE_CONFIG,
        normalize: normalizeThinkInCodeOverlay,
        merge: (base, overlay) =>
            normalizeThinkInCodeConfig({
                ...base,
                ...overlay,
                commandPolicy: {
                    ...base.commandPolicy,
                    ...overlay.commandPolicy,
                    guardPolicy: {
                        ...base.commandPolicy.guardPolicy,
                        ...overlay.commandPolicy?.guardPolicy,
                    },
                },
                telemetry: {
                    ...base.telemetry,
                    ...overlay.telemetry,
                },
            }),
        sources: [
            {
                settingsKey: THINK_IN_CODE_SETTINGS_KEY,
                legacyFilename: THINK_IN_CODE_LEGACY_FILE,
                projectLocal: true,
            },
        ],
        agentDir,
        _settingsManager: settingsManager,
    });
}

/** Resolve the on-disk root for the Think-in-Code store. */
export function resolveThinkInCodeRoot(home: string = homedir()): string {
    return `${home}/.pi/agent/think-in-code`;
}

export interface ProjectStorePathOptions {
    home?: string;
}

/**
 * Per-project canonical store directory:
 * `<home>/.pi/agent/think-in-code/projects/<sha256(realpath(cwd))>`.
 *
 * The canonical project path is captured alongside so the store can detect an
 * impossible hash/path mismatch on reopen.
 */
export function resolveProjectStorePath(
    canonicalPath: string,
    options: ProjectStorePathOptions = {},
): string {
    const home = options.home ?? homedir();
    const segment = hashProjectPath(canonicalPath);
    return `${resolveThinkInCodeRoot(home)}/projects/${segment}`;
}

/** SHA-256 (lowercase hex) of the canonical project path. */
export function hashProjectPath(canonicalPath: string): string {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(canonicalPath);
    return hasher.digest("hex");
}
