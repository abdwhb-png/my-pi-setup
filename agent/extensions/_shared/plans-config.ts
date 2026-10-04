import { loadExtensionConfig } from "./config-loader.ts";

export interface PlansConfig {
    browserCommand?: string;
    autoExecute: boolean;
}

export function loadPlansConfig(
    cwd: string,
    projectTrusted = false,
    agentDir?: string,
): PlansConfig {
    return loadExtensionConfig<PlansConfig>(cwd, {
        defaults: { autoExecute: true },
        normalize: (raw) => {
            if (raw === undefined) return {};
            if (!raw || typeof raw !== "object" || Array.isArray(raw))
                throw new Error("plans must be an object");
            if ("planFileDir" in raw)
                throw new Error(
                    "plans.planFileDir is retired. Run the extension-layout migration before loading Pi.",
                );
            const config: Partial<PlansConfig> = {};
            for (const [key, value] of [
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
            if ("autoExecute" in raw) {
                if (typeof raw.autoExecute !== "boolean")
                    throw new Error("autoExecute must be a boolean");
                config.autoExecute = raw.autoExecute;
            }
            return config;
        },
        agentDir,
        projectTrusted,

        owner: "plans",
    });
}
