import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadExtensionConfig } from "../_shared/config-loader.ts";

export interface YoloConfig {
    protectedTools: string[];
    protectedExtensions: string[];
}

const DEFAULT_CONFIG: YoloConfig = {
    protectedTools: [],
    protectedExtensions: [],
};

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

function normalize(raw: unknown): Partial<YoloConfig> {
    if (!isRecord(raw)) return {};

    const protectedTools = normalizePatterns(raw.protectedTools);
    const protectedExtensions = normalizePatterns(raw.protectedExtensions);

    return {
        ...(protectedTools === undefined ? {} : { protectedTools }),
        ...(protectedExtensions === undefined ? {} : { protectedExtensions }),
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
}

export function loadConfig(cwd: string, agentDir?: string): YoloConfig {
    const resolvedAgentDir = agentDir ?? getAgentDir();
    validateConfigFile(join(resolvedAgentDir, "pi-dangerous-mode.json"));
    validateConfigFile(join(cwd, ".pi", "pi-dangerous-mode.json"));

    return loadExtensionConfig(cwd, {
        defaults: DEFAULT_CONFIG,
        normalize,
        sources: [{ legacyFilename: "pi-dangerous-mode.json" }],
        agentDir: resolvedAgentDir,
    });
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
