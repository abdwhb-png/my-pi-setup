import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const THINKING_LEVELS = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
] as const satisfies readonly ThinkingLevel[];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
    return (
        typeof value === "string" &&
        THINKING_LEVELS.includes(value as ThinkingLevel)
    );
}
