/**
 * Pure decision core for the subagent-wait-guard extension.
 *
 * No runtime imports: everything here is deterministic and unit-testable.
 * Message shapes come from pi's real types.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * True when an assistant message is a final prose answer (no tool calls),
 * i.e. exactly the kind of message that must not land while delegated
 * subagent runs are still in flight.
 */
export function isPrematureFinalAssistant(message: AssistantMessage): boolean {
    if (message.role !== "assistant") return false;
    if (message.content.some((part) => part.type === "toolCall")) return false;
    return message.content.some(
        (part) => part.type === "text" && part.text.trim().length > 0,
    );
}

function runList(runIds: readonly string[]): string {
    return runIds.map((id) => '"' + id + '"').join(", ");
}

/** Replacement assistant message body shown instead of a premature answer. */
export function buildReplacement(
    original: AssistantMessage,
    runIds: readonly string[],
): AssistantMessage {
    const notice =
        "[subagent-wait-guard] This answer was withheld because delegated subagent run(s) " +
        runList(runIds) +
        " are still in flight. Call subagent_wait({ all: true }), retrieve their final reports, " +
        "and only then produce the answer incorporating them.";
    return { ...original, content: [{ type: "text", text: notice }] };
}

/** Follow-up user message forcing the agent to wait for in-flight runs. */
export function buildFollowUp(runIds: readonly string[]): string {
    return (
        "[subagent-wait-guard] Subagent run(s) " +
        runList(runIds) +
        " are still in flight and their final reports have not been incorporated. " +
        "Do not finalize. Call subagent_wait({ all: true }) now; when runs reach terminal state, " +
        "retrieve each final report, incorporate it, and only then answer the pending question."
    );
}

/**
 * Consecutive-intervention bookkeeping. Returns the next count, or null when
 * the cap is reached (guard must back off and let prompt rules take over).
 */
export function nextInterventionCount(
    current: number,
    cap: number,
): number | null {
    if (current >= cap) return null;
    return current + 1;
}
