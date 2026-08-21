import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagentsOverview from "./pi-subagents-overview/index.ts";

function addonEnabled(): boolean {
    try {
        const parsed: unknown = JSON.parse(
            readFileSync(new URL("./config.json", import.meta.url), "utf8"),
        );
        return (
            parsed !== null &&
            typeof parsed === "object" &&
            !Array.isArray(parsed) &&
            (parsed as { enabled?: unknown }).enabled === true
        );
    } catch {
        return false;
    }
}

export default function registerSubagentsAddons(pi: ExtensionAPI): void {
    if (!addonEnabled()) return;
    registerSubagentsOverview(pi);
}
