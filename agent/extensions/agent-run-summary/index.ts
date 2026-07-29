import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    type AgentRunSummaryPayload,
    isAgentRunSummaryPayload,
    onAgentSettled,
    TOOL_SUMMARY_EVENT,
    TPS_SUMMARY_EVENT,
} from "../_shared/agent-run-summary.ts";
import { createUiColors } from "../_shared/ui/ui-colors.ts";

const SEPARATOR = "  ·  ";

export default function (pi: ExtensionAPI) {
    let tpsSummary: AgentRunSummaryPayload | null = null;
    let toolSummary: AgentRunSummaryPayload | null = null;

    pi.events.on(TPS_SUMMARY_EVENT, (payload) => {
        if (isAgentRunSummaryPayload(payload)) {
            tpsSummary = payload;
        }
    });

    pi.events.on(TOOL_SUMMARY_EVENT, (payload) => {
        if (isAgentRunSummaryPayload(payload)) {
            toolSummary = payload;
        }
    });

    pi.on("agent_start", async () => {
        tpsSummary = null;
        toolSummary = null;
    });

    onAgentSettled(pi, async (_event, ctx) => {
        if (!ctx.hasUI) return;

        const colors = createUiColors(ctx.ui.theme);
        const summary = [tpsSummary, toolSummary]
            .filter(
                (payload): payload is AgentRunSummaryPayload =>
                    payload !== null,
            )
            .map(
                (payload) =>
                    `${colors.muted(`[${payload.prefix}]`)} ${payload.text}`,
            )
            .join(SEPARATOR);
        if (summary) {
            ctx.ui.notify(summary, "info");
        }
    });
}
