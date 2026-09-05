/**
 * Session state capture for Think-in-Code.
 *
 * Classification rules (priority order, high → low):
 *
 *   P0 — unresolved blockers and errors from any tool result.
 *   P1 — user decisions / corrections / explicit objectives.
 *   P2 — active objective or open action items.
 *   P3 — verified facts from tool evidence (file paths, command outcomes,
 *         archive references, test/diagnostic results).
 *   P4 — assistant claims without tool evidence (lower priority, never
 *         relabeled as verified).
 *
 * Completed or noisy events are dropped. All persisted text is run through
 * `redactTextPreservingContext` and hard-bounded by length before storage.
 *
 * Capture failures are fail-open and visible: they never block unrelated Pi
 * operation.
 */

import { redactTextPreservingContext } from "../../_shared/redaction.ts";
import type { ThinkStore } from "../storage/store.ts";

export const CAPTURE_PRIORITIES = Object.freeze({
    blocker: 0,
    userDecision: 1,
    objective: 2,
    verifiedFact: 3,
    assistantClaim: 4,
});

export const CAPTURE_ENTRY_TYPE = "think-in-code:capture";

export type CapturePriority =
    (typeof CAPTURE_PRIORITIES)[keyof typeof CAPTURE_PRIORITIES];

export interface CaptureRecord {
    id: string;
    sessionId: string;
    turnIndex: number;
    priority: CapturePriority;
    source: "user" | "assistant" | "tool-call" | "tool-result";
    text: string;
    references?: readonly string[];
    createdAt: number;
}

export interface CaptureInput {
    sessionId: string;
    turnIndex: number;
    source: CaptureRecord["source"];
    text: string;
    priority: CapturePriority;
    references?: readonly string[];
    /** Maximum characters for the stored text. Default: 1024. */
    maxChars?: number;
}

export class CaptureBuffer {
    readonly #store: ThinkStore;
    readonly #sessionId: string;
    readonly #maxChars: number;
    readonly #queue: CaptureRecord[] = [];

    constructor(store: ThinkStore, sessionId: string, maxChars = 1024) {
        this.#store = store;
        this.#sessionId = sessionId;
        this.#maxChars = maxChars;
    }

    add(input: CaptureInput): CaptureRecord | null {
        const text = redactTextPreservingContext(input.text, {
            maxLength: input.maxChars ?? this.#maxChars,
        });
        if (text.length === 0) return null;
        const record: CaptureRecord = {
            id: `cap-${input.turnIndex}-${input.priority}-${this.#queue.length}`,
            sessionId: this.#sessionId,
            turnIndex: input.turnIndex,
            priority: input.priority,
            source: input.source,
            text,
            references: input.references ? [...input.references] : undefined,
            createdAt: Date.now(),
        };
        this.#queue.push(record);
        return record;
    }

    flush(): CaptureRecord[] {
        const records = [...this.#queue];
        this.#queue.length = 0;
        for (const record of records) {
            try {
                this.#store.recordSessionEvent({
                    sessionId: record.sessionId,
                    turnIndex: record.turnIndex,
                    kind: `${CAPTURE_ENTRY_TYPE}:${record.priority}`,
                    payload: record,
                });
            } catch {
                // fail-open: a capture failure never blocks unrelated work
            }
        }
        return records;
    }

    pending(): readonly CaptureRecord[] {
        return [...this.#queue];
    }
}

/**
 * Classify a tool call event into a priority + bounded text fragment.
 */
export function classifyToolCall(input: {
    toolName: string;
    args: Record<string, unknown>;
}): { priority: CapturePriority; text: string; references?: string[] } {
    const { toolName, args } = input;
    const subject = pickSubject(toolName, args);
    const text = subject ? `${toolName} → ${subject}` : toolName;
    return {
        priority: CAPTURE_PRIORITIES.objective,
        text,
    };
}

/**
 * Classify a tool result event into a priority + bounded text fragment.
 */
export function classifyToolResult(input: {
    toolName: string;
    isError: boolean;
    details?: unknown;
    references?: readonly string[];
}): { priority: CapturePriority; text: string; references?: string[] } {
    const { toolName, isError, details, references } = input;
    const detailRecord =
        details && typeof details === "object"
            ? (details as Record<string, unknown>)
            : undefined;
    const blockedReason =
        typeof detailRecord?.blockedReason === "string"
            ? detailRecord.blockedReason
            : undefined;
    const failedBatchItem = Array.isArray(detailRecord?.items)
        ? detailRecord.items.find(
              (item) =>
                  typeof item === "object" &&
                  item !== null &&
                  (item as { status?: unknown }).status !== "succeeded",
          )
        : undefined;
    const diagnosticFailure =
        (typeof detailRecord?.errorCount === "number" &&
            detailRecord.errorCount > 0) ||
        (typeof detailRecord?.failed === "number" && detailRecord.failed > 0) ||
        detailRecord?.passed === false;
    if (isError || blockedReason || failedBatchItem || diagnosticFailure) {
        const batchRecord =
            failedBatchItem && typeof failedBatchItem === "object"
                ? (failedBatchItem as Record<string, unknown>)
                : undefined;
        const batchError =
            typeof batchRecord?.error === "string"
                ? batchRecord.error
                : typeof batchRecord?.status === "string"
                  ? batchRecord.status
                  : batchRecord
                    ? "batch item failed"
                    : undefined;
        const reason =
            blockedReason ??
            batchError ??
            (detailRecord && "reason" in detailRecord
                ? String(detailRecord.reason)
                : diagnosticFailure
                  ? "diagnostic or test failure"
                  : "tool error");
        return {
            priority: CAPTURE_PRIORITIES.blocker,
            text: `${toolName} failed: ${reason}`,
            references: references ? [...references] : undefined,
        };
    }
    if (toolName === "think_execute" || toolName === "think_batch_execute") {
        return {
            priority: CAPTURE_PRIORITIES.verifiedFact,
            text: `${toolName} succeeded`,
            references: references ? [...references] : undefined,
        };
    }
    if (toolName === "edit" || toolName === "write") {
        const path =
            details && typeof details === "object" && "path" in details
                ? String((details as { path: unknown }).path)
                : "";
        return {
            priority: CAPTURE_PRIORITIES.verifiedFact,
            text: `${toolName} ${path}`,
        };
    }
    return {
        priority: CAPTURE_PRIORITIES.verifiedFact,
        text: `${toolName} succeeded`,
    };
}

function pickSubject(toolName: string, args: Record<string, unknown>): string {
    if (toolName === "read" || toolName === "edit" || toolName === "write") {
        return typeof args.path === "string" ? args.path : "";
    }
    if (
        toolName === "bash" ||
        toolName === "safe_bash" ||
        toolName === "think_execute"
    ) {
        return typeof args.command === "string" ? args.command : "";
    }
    if (toolName === "grep" || toolName === "find") {
        return typeof args.pattern === "string" ? args.pattern : "";
    }
    return "";
}
