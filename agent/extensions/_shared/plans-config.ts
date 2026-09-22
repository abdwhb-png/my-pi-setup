import { homedir } from "node:os";
import { join } from "node:path";
import { loadExtensionConfig } from "./config-loader.ts";

export interface PlansConfig {
    planFileDir?: string;
    browserCommand?: string;
}

export function loadPlansConfig(
    cwd: string,
    projectTrusted = false,
    agentDir?: string,
): PlansConfig {
    return loadExtensionConfig<PlansConfig>(cwd, {
        defaults: {},
        normalize: (raw) => {
            if (raw === undefined) return {};
            if (!raw || typeof raw !== "object" || Array.isArray(raw))
                throw new Error("plans must be an object");
            const config: PlansConfig = {};
            for (const [key, value] of [
                [
                    "planFileDir",
                    "planFileDir" in raw ? raw.planFileDir : undefined,
                ],
                [
                    "browserCommand",
                    "browserCommand" in raw ? raw.browserCommand : undefined,
                ],
            ] as const) {
                if (value === undefined) continue;
                if (typeof value !== "string" || !value.trim())
                    throw new Error(`${key} must be a nonempty string`);
                config[key] = value;
            }
            return config;
        },
        agentDir,
        projectTrusted,
        strict: true,
        sources: [
            {
                settingsKey: "plans",
                legacyFilename: "plannotator.json",
                cumulative: true,
            },
        ],
    });
}

export function resolvePlanFileDir(config: PlansConfig): string | undefined {
    const path = config.planFileDir?.trim();
    return path?.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}
