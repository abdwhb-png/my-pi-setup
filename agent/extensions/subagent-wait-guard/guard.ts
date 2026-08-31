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

export type GuardNoticeKind = "interactive" | "headless" | "attention";

const REPLACEMENT_GUIDANCE = {
    interactive:
        "Pi will wake this session when completion notifications arrive. Return control now and incorporate every final report before answering.",
    attention:
        "At least one run needs attention. Inspect its status and resolve that request before waiting or answering.",
    headless:
        "This non-interactive session must wait before answering; a single blocking-wait instruction will follow.",
} as const satisfies Record<GuardNoticeKind, string>;

/** True only for the interactive TUI. RPC exposes UI APIs but cannot receive a native TUI wake. */
export function isInteractiveTuiRuntime(
    hasUI: boolean,
    argv: readonly string[],
): boolean {
    if (!hasUI) return false;
    return !argv.some(
        (argument, index) =>
            argument === "--mode=rpc" ||
            (argument === "--mode" && argv[index + 1] === "rpc"),
    );
}

/** Replacement assistant message body shown instead of a premature answer. */
export function buildReplacement(
    original: AssistantMessage,
    runIds: readonly string[],
    kind: GuardNoticeKind,
): AssistantMessage {
    const prefix =
        "[subagent-wait-guard] Answer deferred because delegated subagent run(s) " +
        runList(runIds) +
        " have not produced final reports. ";
    return {
        ...original,
        content: [{ type: "text", text: prefix + REPLACEMENT_GUIDANCE[kind] }],
    };
}

/** Follow-up user message forcing a non-interactive agent to wait for in-flight runs. */
export function buildFollowUp(runIds: readonly string[]): string {
    return (
        "[subagent-wait-guard] Subagent run(s) " +
        runList(runIds) +
        " are still in flight. Use the standalone `subagent_wait` tool with `{ all: true }`, " +
        'not `subagent({ action: "wait" })`; `wait` is not a subagent management action. ' +
        "After all runs reach terminal state, retrieve and incorporate every final report before answering."
    );
}
