import { readFileSync } from "node:fs";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readExtensionConfig } from "../_shared/config-loader.ts";
import {
    parseFallbackAdviceConfig,
    registerFallbackAdvice,
} from "./fallback-advice.ts";
import registerSubagentsOverview from "./pi-subagents-overview/index.ts";
import registerSubagentWaitGuard from "./subagent-wait-guard/index.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readAddonsConfig(path?: string | URL) {
    const parsed: unknown =
        path === undefined
            ? (readExtensionConfig("subagentsAddons", { scope: "global" }) ??
              {})
            : JSON.parse(readFileSync(path, "utf8"));
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
    let config: ReturnType<typeof readAddonsConfig> | undefined;
    try {
        config = readAddonsConfig(configPath);
    } catch {
        // Report configuration failures from the lifecycle handler so Pi keeps the extension loaded.
    }
    pi.on("session_start", (_event, ctx) => {
        try {
            readAddonsConfig(configPath);
            ctx.ui.setStatus("subagents-addons", undefined);
        } catch (error) {
            const message = `Invalid subagents addon configuration: ${error instanceof Error ? error.message : String(error)}. Fix it and /reload.`;
            ctx.ui.setStatus("subagents-addons", message);
            ctx.ui.notify(message, "error");
        }
    });
    if (config?.subagentWaitGuard) registerSubagentWaitGuard(pi);
    if (config?.piSubagentsOverview) registerSubagentsOverview(pi);
    if (config?.fallbackAdvice.enabled)
        registerFallbackAdvice(pi, config.fallbackAdvice);
}
