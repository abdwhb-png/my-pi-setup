import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagentsOverview from "./pi-subagents-overview/index.ts";
import registerSubagentWaitGuard from "./subagent-wait-guard/index.ts";

type AddonName = "piSubagentsOverview" | "subagentWaitGuard";

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addonEnabled(name: AddonName): boolean {
    try {
        const parsed: unknown = JSON.parse(
            readFileSync(new URL("./config.json", import.meta.url), "utf8"),
        );
        if (!isRecord(parsed)) return false;
        const addon = parsed[name];
        return isRecord(addon) && addon.enabled === true;
    } catch {
        return false;
    }
}

export default function registerSubagentsAddons(pi: ExtensionAPI): void {
    if (addonEnabled("subagentWaitGuard")) registerSubagentWaitGuard(pi);
    if (addonEnabled("piSubagentsOverview")) registerSubagentsOverview(pi);
}
