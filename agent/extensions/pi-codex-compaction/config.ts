import { loadExtensionConfig } from "../_shared/config-loader.ts";

export interface CodexCompactionConfig {
    autoCompact: boolean;
    thresholdRatio: number;
}

const DEFAULT_CONFIG: CodexCompactionConfig = {
    autoCompact: true,
    thresholdRatio: 0.9,
};

export function loadConfig(
    cwd: string,
    projectTrusted: boolean,
): CodexCompactionConfig {
    return loadExtensionConfig(cwd, {
        owner: "codexCompaction",
        defaults: DEFAULT_CONFIG,
        projectTrusted,
        normalize: (raw) => {
            if (!raw || typeof raw !== "object") return {};
            return {
                ...("autoCompact" in raw && typeof raw.autoCompact === "boolean"
                    ? { autoCompact: raw.autoCompact }
                    : {}),
                ...("thresholdRatio" in raw &&
                typeof raw.thresholdRatio === "number" &&
                raw.thresholdRatio > 0 &&
                raw.thresholdRatio < 1
                    ? { thresholdRatio: raw.thresholdRatio }
                    : {}),
            };
        },
    });
}
