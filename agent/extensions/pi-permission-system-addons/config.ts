import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { loadExtensionConfig } from "../_shared/config-loader.ts";

export interface AddonConfig {
    inherit: Record<string, string>;
}

export class AddonConfigError extends Error {
    constructor(message: string) {
        super(`[pi-permission-system-addons] ${message}`);
        this.name = "AddonConfigError";
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getUpstreamConfigPath(agentDir: string): string {
    return join(agentDir, "extensions", "pi-permission-system", "config.json");
}

function readUpstreamConfig(agentDir: string): Record<string, unknown> {
    const configPath = getUpstreamConfigPath(agentDir);
    if (!existsSync(configPath)) return {};

    try {
        const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
        if (!isRecord(parsed)) {
            throw new Error("config root must be an object");
        }
        return parsed;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new AddonConfigError(
            `Cannot read pi-permission-system config at '${configPath}': ${message}`,
        );
    }
}

export function readUpstreamYoloMode(agentDir: string): boolean {
    return readUpstreamConfig(agentDir).yoloMode === true;
}

export function writeUpstreamYoloMode(
    agentDir: string,
    enabled: boolean,
): void {
    const configPath = getUpstreamConfigPath(agentDir);
    const tmpPath = `${configPath}.tmp`;
    const updated = { ...readUpstreamConfig(agentDir), yoloMode: enabled };

    try {
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(
            tmpPath,
            `${JSON.stringify(updated, null, 4)}\n`,
            "utf-8",
        );
        renameSync(tmpPath, configPath);
    } catch (error) {
        try {
            if (existsSync(tmpPath)) unlinkSync(tmpPath);
        } catch {}
        const message = error instanceof Error ? error.message : String(error);
        throw new AddonConfigError(
            `Cannot write pi-permission-system config at '${configPath}': ${message}`,
        );
    }
}

function normalize(raw: unknown): Partial<AddonConfig> {
    if (!isRecord(raw)) return {};
    const result: Partial<AddonConfig> = {};

    // inherit map
    const inheritRaw = raw.inherit;
    if (isRecord(inheritRaw)) {
        const inherit: Record<string, string> = {};
        for (const [tool, surface] of Object.entries(inheritRaw)) {
            if (typeof surface === "string" && surface.length > 0) {
                inherit[tool] = surface;
            }
        }
        result.inherit = inherit;
    }

    return result;
}

export function loadConfig(cwd: string, agentDir?: string): AddonConfig {
    return loadExtensionConfig(cwd, {
        defaults: { inherit: {} },
        normalize,
        sources: [{ legacyFilename: "pi-permission-system-addons.json" }],
        agentDir,
    });
}
