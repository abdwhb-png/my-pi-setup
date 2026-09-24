import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    parseFallbackAdviceConfig,
    registerFallbackAdvice,
} from "./fallback-advice.ts";
import registerSubagentsOverview from "./pi-subagents-overview/index.ts";
import registerSubagentWaitGuard from "./subagent-wait-guard/index.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readAddonsConfig(
    path: string | URL = new URL("./config.json", import.meta.url),
) {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) throw new Error("Invalid subagents addon config");
    return {
        subagentWaitGuard:
            isRecord(parsed.subagentWaitGuard) &&
            parsed.subagentWaitGuard.enabled === true,
        piSubagentsOverview:
            isRecord(parsed.piSubagentsOverview) &&
            parsed.piSubagentsOverview.enabled === true,
        fallbackAdvice: parseFallbackAdviceConfig(
            parsed.fallbackAdvice ?? { enabled: false },
        ),
    };
}

export default function registerSubagentsAddons(
    pi: ExtensionAPI,
    configPath?: string | URL,
): void {
    const config = readAddonsConfig(configPath);
    if (config.subagentWaitGuard) registerSubagentWaitGuard(pi);
    if (config.piSubagentsOverview) registerSubagentsOverview(pi);
    if (config.fallbackAdvice.enabled)
        registerFallbackAdvice(pi, config.fallbackAdvice);
}
