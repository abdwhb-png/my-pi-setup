import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
    completeAutopilot,
    getAutopilotBudgetRemaining,
    getRuntimeStatus,
    isAutopilotEnabled,
    recordAutopilotTurn,
} from "./runtime-state.ts";
import type { createTelemetryRecorder } from "./telemetry.ts";

export const AUTOPILOT_COMPLETE_TOOL = "autopilot_complete";
const AUTOPILOT_CONTINUE_MESSAGE = "pi:autopilot:continue";

let agentActive = false;
let agentRunHadError = false;
let continuationQueued = false;
let nextContinuationReason: "prompt_blocked" | undefined;

export function isAutopilotAgentActive(): boolean {
    return agentActive;
}

export function noteAutopilotPromptBlocked(): void {
    nextContinuationReason = "prompt_blocked";
}

export function syncAutopilotToolVisibility(pi: ExtensionAPI): void {
    const activeTools = pi.getActiveTools();
    const shouldBeActive = isAutopilotEnabled();
    const isActive = activeTools.includes(AUTOPILOT_COMPLETE_TOOL);
    if (shouldBeActive === isActive) return;

    pi.setActiveTools(
        shouldBeActive
            ? [...activeTools, AUTOPILOT_COMPLETE_TOOL]
            : activeTools.filter(
                  (toolName) => toolName !== AUTOPILOT_COMPLETE_TOOL,
              ),
    );
}

function instruction(now: number): string {
    const remaining = getAutopilotBudgetRemaining(now);
    return `AUTOPILOT ACTIVE. Do not request human input. Choose the safest non-interactive path from current context. If a prompt is blocked, use an alternative path; do not repeat the same prompt. Continue until requested work and executable validation are complete. Then call autopilot_complete exactly once with outcome=completed. If a protected action is required or no safe path exists, call autopilot_complete with outcome=blocked and explain blocker. Remaining budget: ${remaining.turns} turns, ${remaining.retries} error continuations, ${remaining.milliseconds} ms. No hidden evaluator will decide for you.`;
}

function isBudgetStopReason(
    reason: string | undefined,
): reason is "turn_budget" | "retry_budget" | "time_budget" {
    return (
        reason === "turn_budget" ||
        reason === "retry_budget" ||
        reason === "time_budget"
    );
}

export function registerAutopilotLoop(
    pi: ExtensionAPI,
    deps: {
        now?: () => number;
        telemetry: ReturnType<typeof createTelemetryRecorder>;
    },
): void {
    const now = deps.now ?? Date.now;

    pi.registerTool({
        name: AUTOPILOT_COMPLETE_TOOL,
        label: "Complete Autopilot",
        description:
            "Finish active Autopilot after requested work and executable validation complete, or report a blocker requiring human action.",
        parameters: Type.Object(
            {
                outcome: StringEnum(["completed", "blocked"] as const),
                summary: Type.String({ minLength: 1 }),
                remainingRisks: Type.Optional(Type.Array(Type.String())),
            },
            { additionalProperties: false },
        ),
        async execute(_id, params) {
            completeAutopilot({
                outcome: params.outcome,
                reason: params.summary,
            });
            deps.telemetry({
                event: "completed",
                outcome: params.outcome,
            });
            syncAutopilotToolVisibility(pi);
            return {
                content: [
                    {
                        type: "text",
                        text: `Autopilot ${params.outcome}.`,
                    },
                ],
                details: {
                    outcome: params.outcome,
                    remainingRiskCount: params.remainingRisks?.length ?? 0,
                },
            };
        },
    });

    pi.on("session_start", () => {
        agentActive = false;
        agentRunHadError = false;
        continuationQueued = false;
        nextContinuationReason = undefined;
        syncAutopilotToolVisibility(pi);
    });

    pi.on("before_agent_start", (event) => {
        if (!isAutopilotEnabled()) return undefined;
        return {
            systemPrompt: `${event.systemPrompt}\n\n${instruction(now())}`,
        };
    });

    pi.on("agent_start", () => {
        agentActive = true;
        agentRunHadError = false;
        continuationQueued = false;
        syncAutopilotToolVisibility(pi);
    });

    pi.on("turn_end", (event) => {
        if (!isAutopilotEnabled()) return;

        const hadError = event.toolResults.some((result) => result.isError);
        agentRunHadError ||= hadError;
        recordAutopilotTurn({ hadError, now: now() });
        const status = getRuntimeStatus().autopilot;
        deps.telemetry({
            event: "turn_recorded",
            turnsUsed: status.turnsUsed,
            retriesUsed: status.retriesUsed,
            hadError,
        });
        if (
            status.phase === "budget_exhausted" &&
            isBudgetStopReason(status.stopReason)
        ) {
            deps.telemetry({ event: "stopped", reason: status.stopReason });
            syncAutopilotToolVisibility(pi);
        }
    });

    pi.on("agent_settled", (_event, ctx) => {
        agentActive = false;
        syncAutopilotToolVisibility(pi);
        const status = getRuntimeStatus().autopilot;
        if (
            !status.effective ||
            status.phase !== "running" ||
            continuationQueued ||
            ctx.hasPendingMessages()
        ) {
            return;
        }

        const reason =
            nextContinuationReason ?? (agentRunHadError ? "retry" : "continue");
        continuationQueued = true;
        nextContinuationReason = undefined;
        pi.sendMessage(
            {
                customType: AUTOPILOT_CONTINUE_MESSAGE,
                content:
                    "Continue Autopilot from current context. Do not request human input. Finish with autopilot_complete.",
                display: false,
                details: { reason },
            },
            { triggerTurn: true },
        );
        deps.telemetry({ event: "continuation_queued", reason });
    });
}
