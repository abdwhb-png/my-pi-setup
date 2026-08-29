import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadExtensionConfig } from "../_shared/config-loader.ts";
import type { AutopilotBudgets } from "./runtime-state.ts";

export interface YoloConfig {
    protectedTools: string[];
    protectedExtensions: string[];
}

export interface AutopilotConfig extends AutopilotBudgets {
    guardedTools: string[];
    guardedCommands: string[];
}

export interface DangerousModeConfig extends YoloConfig {
    autopilot: AutopilotConfig;
}

export const DEFAULT_AUTOPILOT: AutopilotConfig = {
    maxTurns: 8,
    maxRetries: 2,
    maxDurationMs: 600_000,
    guardedTools: [
        "*deploy*",
        "*publish*",
        "*purchase*",
        "*payment*",
        "*delete*",
        "*destroy*",
    ],
    guardedCommands: [
        "*git push*",
        "*gh pr create*",
        "*gh release create*",
        "*npm publish*",
        "*bun publish*",
        "*pnpm publish*",
        "*docker push*",
        "*kubectl apply*",
        "*kubectl delete*",
        "*helm install*",
        "*helm upgrade*",
        "*terraform apply*",
        "*terraform destroy*",
    ],
};

const DEFAULT_CONFIG: DangerousModeConfig = {
    protectedTools: [],
    protectedExtensions: [],
    autopilot: DEFAULT_AUTOPILOT,
};

interface ConfigLayer extends YoloConfig {
    autopilot: Partial<AutopilotConfig>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePatterns(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value.flatMap((entry) => {
        if (typeof entry !== "string") return [];
        const pattern = entry.trim();
        return pattern ? [pattern] : [];
    });
}

function normalizePositiveInteger(value: unknown): number | undefined {
    return Number.isInteger(value) && Number(value) > 0
        ? Number(value)
        : undefined;
}

function normalizeAutopilot(
    raw: unknown,
): Partial<AutopilotConfig> | undefined {
    if (!isRecord(raw)) return undefined;

    const maxTurns = normalizePositiveInteger(raw.maxTurns);
    const maxRetries = normalizePositiveInteger(raw.maxRetries);
    const maxDurationMs = normalizePositiveInteger(raw.maxDurationMs);
    const guardedTools = normalizePatterns(raw.guardedTools);
    const guardedCommands = normalizePatterns(raw.guardedCommands);

    return {
        ...(maxTurns === undefined ? {} : { maxTurns }),
        ...(maxRetries === undefined ? {} : { maxRetries }),
        ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
        ...(guardedTools === undefined ? {} : { guardedTools }),
        ...(guardedCommands === undefined ? {} : { guardedCommands }),
    };
}

function normalize(raw: unknown): Partial<ConfigLayer> {
    if (!isRecord(raw)) return {};

    const protectedTools = normalizePatterns(raw.protectedTools);
    const protectedExtensions = normalizePatterns(raw.protectedExtensions);
    const autopilot = normalizeAutopilot(raw.autopilot);

    return {
        ...(protectedTools === undefined ? {} : { protectedTools }),
        ...(protectedExtensions === undefined ? {} : { protectedExtensions }),
        ...(autopilot === undefined ? {} : { autopilot }),
    };
}

function isValidPatternList(value: unknown): boolean {
    return (
        Array.isArray(value) &&
        value.every(
            (entry) => typeof entry === "string" && entry.trim().length > 0,
        )
    );
}

function isPositiveInteger(value: unknown): boolean {
    return Number.isInteger(value) && Number(value) > 0;
}

function validateAutopilot(path: string, value: unknown): void {
    if (!isRecord(value)) {
        throw new Error(
            `Invalid configuration: autopilot in ${path} must be an object.`,
        );
    }

    for (const field of ["maxTurns", "maxRetries", "maxDurationMs"] as const) {
        if (field in value && !isPositiveInteger(value[field])) {
            throw new Error(
                `Invalid configuration: ${field} in ${path} must be a positive integer.`,
            );
        }
    }

    for (const field of ["guardedTools", "guardedCommands"] as const) {
        if (field in value && !isValidPatternList(value[field])) {
            throw new Error(
                `Invalid configuration: ${field} in ${path} must be a non-empty string list.`,
            );
        }
    }
}

function validateConfigFile(path: string): void {
    if (!existsSync(path)) return;

    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        throw new Error(`Invalid configuration: cannot parse ${path}.`);
    }

    if (!isRecord(raw)) {
        throw new Error(`Invalid configuration: ${path} must be an object.`);
    }

    for (const field of ["protectedTools", "protectedExtensions"] as const) {
        if (field in raw && !isValidPatternList(raw[field])) {
            throw new Error(
                `Invalid configuration: ${field} in ${path} must be a non-empty string list.`,
            );
        }
    }

    if ("autopilot" in raw) validateAutopilot(path, raw.autopilot);
}

function mergeConfig(
    base: ConfigLayer,
    overlay: Partial<ConfigLayer>,
): ConfigLayer {
    return {
        protectedTools: overlay.protectedTools ?? base.protectedTools,
        protectedExtensions:
            overlay.protectedExtensions ?? base.protectedExtensions,
        autopilot: {
            ...base.autopilot,
            ...overlay.autopilot,
        },
    };
}

export function loadConfig(
    cwd: string,
    agentDir?: string,
): DangerousModeConfig {
    const resolvedAgentDir = agentDir ?? getAgentDir();
    validateConfigFile(join(resolvedAgentDir, "pi-dangerous-mode.json"));
    validateConfigFile(join(cwd, ".pi", "pi-dangerous-mode.json"));

    const loaded = loadExtensionConfig<ConfigLayer>(cwd, {
        defaults: DEFAULT_CONFIG,
        normalize,
        merge: mergeConfig,
        sources: [{ legacyFilename: "pi-dangerous-mode.json" }],
        agentDir: resolvedAgentDir,
    });

    return {
        protectedTools: [...loaded.protectedTools],
        protectedExtensions: [...loaded.protectedExtensions],
        autopilot: {
            ...DEFAULT_AUTOPILOT,
            ...loaded.autopilot,
            guardedTools: [
                ...(loaded.autopilot.guardedTools ??
                    DEFAULT_AUTOPILOT.guardedTools),
            ],
            guardedCommands: [
                ...(loaded.autopilot.guardedCommands ??
                    DEFAULT_AUTOPILOT.guardedCommands),
            ],
        },
    };
}

function matchesPattern(value: string, pattern: string): boolean {
    const expression = pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
    return new RegExp(`^${expression}$`).test(value);
}

export function matchesTool(
    toolName: string,
    patterns: readonly string[],
): boolean {
    return patterns.some((pattern) => matchesPattern(toolName, pattern));
}

export function matchesExtension(
    extensionPath: string,
    patterns: readonly string[],
): boolean {
    const normalizedPath = extensionPath.replaceAll("\\", "/");
    const segments = normalizedPath.split("/").filter(Boolean);
    return patterns.some(
        (pattern) =>
            matchesPattern(normalizedPath, pattern) ||
            segments.some((segment) => matchesPattern(segment, pattern)),
    );
}
