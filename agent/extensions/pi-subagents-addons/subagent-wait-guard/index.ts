/**
 * Guard parent answers using pi-subagents' current-session status RPC.
 * TUI reminders preserve output and rely on native completion notifications.
 * Headless sessions get one wait turn per active snapshot; paused work needs attention.
 */

import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    buildFollowUp,
    buildParentReminder,
    buildReplacement,
    injectProgressProtocol,
    isPrematureFinalAssistant,
    stripProgressMarker,
    type GuardNoticeKind,
} from "./guard.ts";

import { SubagentRpcClient } from "../../_shared/subagents/rpc-client.ts";
import { readActiveRuns, type ActiveSubagentRun } from "./status.ts";

interface SessionInterventionState {
    fingerprint: string;
    followUpPending: boolean;
    followUpSent: boolean;
    progressPermit: boolean;
}

interface SessionIdentityManager {
    getSessionFile(): string | undefined;
    getSessionId(): string;
}

/** Mirrors pi-subagents' session identity selection. */
function resolveSessionIdentity(manager: SessionIdentityManager): string {
    return manager.getSessionFile() ?? manager.getSessionId();
}

function runFingerprint(runs: readonly ActiveSubagentRun[]): string {
    return JSON.stringify(runs.map((run) => [run.id, run.status]));
}

function hasPausedRun(runs: readonly ActiveSubagentRun[]): boolean {
    return runs.some((run) => run.status === "paused");
}

function replacementKind(
    runs: readonly ActiveSubagentRun[],
    interactive: boolean,
): GuardNoticeKind {
    if (hasPausedRun(runs)) return "attention";
    return interactive ? "interactive" : "headless";
}

export default function register(pi: ExtensionAPI): void {
    if (process.env.PI_SUBAGENT_WAIT_GUARD === "off") return;
    const sendMessage = pi.sendMessage.bind(pi);
    const client = new SubagentRpcClient(pi.events, {
        sourceExtension: "subagent-wait-guard",
    });
    const sessionInterventions = new Map<string, SessionInterventionState>();
    const statusErrors = new Map<string, string>();

    async function activeRuns(
        ctx: ExtensionContext,
    ): Promise<ActiveSubagentRun[] | undefined> {
        const sessionId = resolveSessionIdentity(ctx.sessionManager);
        if (statusErrors.has(sessionId)) return undefined;
        try {
            const runs = readActiveRuns(await client.status());
            statusErrors.delete(sessionId);
            return runs;
        } catch (error) {
            const message = `[subagent-wait-guard] Cannot verify delegated work: ${error instanceof Error ? error.message : String(error)}`;
            if (statusErrors.get(sessionId) !== message) {
                statusErrors.set(sessionId, message);
                sendMessage(
                    {
                        customType: "subagent-wait-guard-status-error",
                        content: message,
                        display: true,
                    },
                    { triggerTurn: false },
                );
            }
            return undefined;
        }
    }

    function resetIfSettled(
        sessionId: string,
        runs: readonly ActiveSubagentRun[],
    ): boolean {
        if (runs.length > 0) return false;
        sessionInterventions.delete(sessionId);
        return true;
    }

    function interventionState(
        sessionId: string,
        runs: readonly ActiveSubagentRun[],
    ): SessionInterventionState {
        const fingerprint = runFingerprint(runs);
        const current = sessionInterventions.get(sessionId);
        if (current?.fingerprint === fingerprint) return current;
        const created: SessionInterventionState = {
            fingerprint,
            followUpPending: false,
            followUpSent: false,
            progressPermit: hasPausedRun(runs),
        };
        sessionInterventions.set(sessionId, created);
        return created;
    }

    function reconcileTurnEndState(
        sessionId: string,
        runs: readonly ActiveSubagentRun[],
    ): SessionInterventionState | undefined {
        const current = sessionInterventions.get(sessionId);
        if (!current) return undefined;
        const fingerprint = runFingerprint(runs);
        if (current.fingerprint === fingerprint) return current;
        if (!current.followUpPending) return undefined;
        const reconciled: SessionInterventionState = {
            fingerprint,
            followUpPending: true,
            followUpSent: false,
            progressPermit: hasPausedRun(runs),
        };
        sessionInterventions.set(sessionId, reconciled);
        return reconciled;
    }

    pi.on("before_agent_start", async (event, ctx) => {
        const sessionId = resolveSessionIdentity(ctx.sessionManager);
        // Retry next request; do not repeat a failed RPC on every boundary of this turn.
        statusErrors.delete(sessionId);
        const runs = await activeRuns(ctx);
        return {
            systemPrompt: injectProgressProtocol(
                event.systemPrompt,
                (runs ?? []).map((run) => run.id),
            ),
        };
    });

    pi.on("tool_result", async (event, ctx) => {
        if (
            event.isError ||
            (event.toolName !== "subagent" && event.toolName !== "bg_wait")
        ) {
            return;
        }
        const sessionId = resolveSessionIdentity(ctx.sessionManager);
        statusErrors.delete(sessionId);
        const runs = await activeRuns(ctx);
        if (!runs || resetIfSettled(sessionId, runs)) return;
        interventionState(sessionId, runs).progressPermit = true;
    });

    pi.on("message_end", async (event, ctx) => {
        const { message } = event;
        if (message.role !== "assistant") return undefined;
        const progressMessage = stripProgressMarker(message);
        const sessionId = resolveSessionIdentity(ctx.sessionManager);
        const runs = await activeRuns(ctx);
        if (!runs) {
            if (ctx.mode === "tui" || !isPrematureFinalAssistant(message))
                return undefined;
            return {
                message: {
                    ...message,
                    content: [
                        {
                            type: "text" as const,
                            text: statusErrors.get(sessionId)!,
                        },
                    ],
                },
            };
        }
        if (resetIfSettled(sessionId, runs)) {
            return progressMessage ? { message: progressMessage } : undefined;
        }
        if (!isPrematureFinalAssistant(message)) {
            return progressMessage ? { message: progressMessage } : undefined;
        }
        const state = interventionState(sessionId, runs);
        const progressPermitted = state.progressPermit;
        state.progressPermit = false;
        if (progressMessage && progressPermitted) {
            return { message: progressMessage };
        }
        const interactive = ctx.mode === "tui";
        if (!state.followUpPending && !state.followUpSent) {
            state.followUpPending = true;
        }
        if (interactive) {
            return progressMessage ? { message: progressMessage } : undefined;
        }
        return {
            message: buildReplacement(
                message,
                runs.map((run) => run.id),
                replacementKind(runs, interactive),
            ),
        };
    });

    pi.on("turn_end", async (_event, ctx) => {
        const sessionId = resolveSessionIdentity(ctx.sessionManager);
        const runs = await activeRuns(ctx);
        if (!runs || resetIfSettled(sessionId, runs)) return;
        const state = reconcileTurnEndState(sessionId, runs);
        if (!state?.followUpPending || state.followUpSent) return;
        state.followUpPending = false;
        state.followUpSent = true;
        const interactive = ctx.mode === "tui";
        if (interactive || hasPausedRun(runs)) {
            sendMessage(
                {
                    customType: "subagent-wait-guard-reminder",
                    content: buildParentReminder(
                        runs.map((run) => run.id),
                        replacementKind(runs, interactive),
                    ),
                    display: false,
                },
                { triggerTurn: false },
            );
            return;
        }
        sendMessage(
            {
                customType: "subagent-wait-guard-reminder",
                content: buildFollowUp(runs.map((run) => run.id)),
                display: false,
            },
            { deliverAs: "followUp" },
        );
    });

    pi.on("session_shutdown", (_event, ctx) => {
        const sessionId = resolveSessionIdentity(ctx.sessionManager);
        sessionInterventions.delete(sessionId);
        statusErrors.delete(sessionId);
        client.dispose();
    });
}
