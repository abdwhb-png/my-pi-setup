import { loadExtensionConfig } from "../_shared/config-loader.ts";

export interface AddonConfig {
    inherit: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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
