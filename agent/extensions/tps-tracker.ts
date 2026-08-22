/**
 * TPS Tracker Extension
 *
 * Tracks tokens per second during model generation and reports
 * final TPS statistics at the end of each agent run.
 *
 * The live footer status and the agent-end summary show both the input and
 * output tokens of the current run, composed with the shared colour palette
 * (see _shared/tps-status.ts for the pure renderers).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TPS_SUMMARY_EVENT } from "./_shared/agent-run-summary.ts";
import { buildTpsStatus, buildTpsSummary } from "./_shared/tps-status.ts";
import { createUiColors } from "./_shared/ui/ui-colors.ts";

export default function (pi: ExtensionAPI) {
    /** Timestamp when the current assistant message event started. Used as a fallback. */
    let messageStart: number | null = null;
    /** Timestamp of the first streamed output delta for the current assistant message. */
    let streamStart: number | null = null;
    /** Estimated streamed output tokens for live display before providers report final usage. */
    let estimatedStreamedTokens = 0;
    /** Cumulative official output tokens across all assistant messages in this agent run. */
    let totalOutputTokens = 0;
    /** Cumulative official input tokens across all assistant messages in this agent run. */
    let totalInputTokens = 0;
    /** Cumulative time (ms) spent actually streaming output deltas (excludes tool execution and first-token latency). */
    let totalStreamMs = 0;

    pi.on("agent_start", async (_event, ctx) => {
        totalOutputTokens = 0;
        totalStreamMs = 0;
        totalInputTokens = 0;
        messageStart = null;
        streamStart = null;
        estimatedStreamedTokens = 0;
        const theme = ctx.ui.theme;
        ctx.ui.setStatus(
            "tps",
            createUiColors(theme).subtle("⏱ generating..."),
        );
    });

    pi.on("message_start", async (event) => {
        if (event.message.role !== "assistant") return;
        messageStart = Date.now();
        streamStart = null;
        estimatedStreamedTokens = 0;
    });

    pi.on("message_update", async (event, ctx) => {
        if (event.message.role !== "assistant") return;

        const streamEvent = event.assistantMessageEvent;
        const isOutputDelta =
            streamEvent.type === "text_delta" ||
            streamEvent.type === "thinking_delta" ||
            streamEvent.type === "toolcall_delta";

        if (!isOutputDelta) return;

        const now = Date.now();
        streamStart ??= now;
        estimatedStreamedTokens += Math.max(0, streamEvent.delta.length / 4);

        const elapsed = (now - streamStart) / 1000;
        const officialTokens = event.message.usage.output;
        const currentTokens =
            officialTokens > 0 ? officialTokens : estimatedStreamedTokens;

        if (elapsed > 0 && currentTokens > 0) {
            const tps = Math.round(currentTokens / elapsed);
            const colors = createUiColors(ctx.ui.theme);
            ctx.ui.setStatus(
                "tps",
                buildTpsStatus(
                    {
                        input: event.message.usage.input || 0,
                        output: currentTokens,
                        tps,
                        elapsedMs: now - streamStart,
                    },
                    colors,
                ),
            );
        }
    });

    pi.on("message_end", async (event) => {
        if (event.message.role !== "assistant") return;

        const messageTokens = event.message.usage.output;
        totalInputTokens += event.message.usage.input || 0;

        const timingStart = streamStart ?? messageStart;
        if (!timingStart || messageTokens <= 0) {
            messageStart = null;
            streamStart = null;
            estimatedStreamedTokens = 0;
            return;
        }

        totalOutputTokens += messageTokens;
        totalStreamMs += Math.max(0, Date.now() - timingStart);

        messageStart = null;
        streamStart = null;
        estimatedStreamedTokens = 0;
    });

    pi.on("agent_end", async (_event, ctx) => {
        const elapsed = totalStreamMs / 1000;
        const tps =
            totalOutputTokens > 0 && elapsed > 0
                ? Math.round(totalOutputTokens / elapsed)
                : 0;

        const colors = createUiColors(ctx.ui.theme);
        const summary = buildTpsSummary(
            {
                input: totalInputTokens,
                output: totalOutputTokens,
                tps,
                elapsedMs: totalStreamMs,
            },
            colors,
        );

        pi.events.emit(TPS_SUMMARY_EVENT, {
            prefix: "TPS",
            text: summary,
        });
        ctx.ui.setStatus(
            "tps",
            colors.success(
                `done — ${tps > 0 ? colors.primary(`${tps} tok/s`) : colors.subtle("N/A")}`,
            ),
        );
    });
}
