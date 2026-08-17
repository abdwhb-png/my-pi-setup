import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const TPS_SUMMARY_EVENT = "agent-run-summary:tps";
export const TOOL_SUMMARY_EVENT = "agent-run-summary:tools";

export interface AgentRunSummaryPayload {
    prefix: string;
    text: string;
}

export function isAgentRunSummaryPayload(
    value: unknown,
): value is AgentRunSummaryPayload {
    if (typeof value !== "object" || value === null) return false;
    return (
        "prefix" in value &&
        typeof (value as { prefix?: unknown }).prefix === "string" &&
        (value as { prefix: string }).prefix.length > 0 &&
        "text" in value &&
        typeof (value as { text?: unknown }).text === "string" &&
        (value as { text: string }).text.length > 0
    );
}

type AgentSettledHandler = (
    event: { type: "agent_settled" },
    ctx: ExtensionContext,
) => void | Promise<void>;

/** Register runtime Pi 0.80's agent_settled event with Pi 0.79 workspace types. */
export function onAgentSettled(
    pi: ExtensionAPI,
    handler: AgentSettledHandler,
): void {
    const settledApi = pi as unknown as {
        on(event: "agent_settled", handler: AgentSettledHandler): void;
    };
    settledApi.on("agent_settled", handler);
}
