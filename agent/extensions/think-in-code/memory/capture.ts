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
import {
    parseThinkExecuteHeader,
    parseThinkFailurePayload,
} from "../public-contract.ts";
import type { ThinkStore } from "../storage/store.ts";

export const CAPTURE_PRIORITIES = Object.freeze({
    blocker: 0,
    userDecision: 1,
    objective: 2,
    verifiedFact: 3,
    assistantClaim: 4,
});

export const CAPTURE_ENTRY_TYPE = "think-in-code:capture";
type OpaqueValue = ErrorOptions["cause"];

function property(value: OpaqueValue, key: PropertyKey): OpaqueValue {
    return typeof value === "object" && value !== null
        ? Reflect.get(value, key)
        : undefined;
}

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
    content?: unknown;
    details?: unknown;
    references?: readonly string[];
}): { priority: CapturePriority; text: string; references?: string[] } {
    const { toolName, isError, content, details, references } = input;
    const thinkHeader =
        toolName === "think_execute"
            ? parseThinkExecuteHeader(content)
            : undefined;
    const thinkFailure =
        toolName === "think_execute"
            ? parseThinkFailurePayload(content)
            : undefined;
    const resolvedReferences = references
        ? [...references]
        : thinkHeader
          ? [...thinkHeader.archiveIds]
          : undefined;
    if (thinkFailure) {
        return {
            priority: CAPTURE_PRIORITIES.blocker,
            text: `${toolName} failed [${thinkFailure.code}]: ${thinkFailure.reason}`,
            references: resolvedReferences,
        };
    }
    if (thinkHeader?.status === "partial") {
        const counters =
            thinkHeader.action === "batch"
                ? `, succeeded=${thinkHeader.succeeded ?? 0}, failed=${thinkHeader.failed ?? 0}, blocked=${thinkHeader.blocked ?? 0}`
                : "";
        return {
            priority: CAPTURE_PRIORITIES.blocker,
            text: `${toolName} partial: ${thinkHeader.action}${counters}`,
            references: resolvedReferences,
        };
    }
    if (thinkHeader?.status === "success") {
        return {
            priority: CAPTURE_PRIORITIES.verifiedFact,
            text: `${toolName} succeeded: ${thinkHeader.action}, ${thinkHeader.sourceBytes}→${thinkHeader.resultBytes} bytes`,
            references: resolvedReferences,
        };
    }
    const blockedReasonValue = property(details, "blockedReason");
    const blockedReason =
        typeof blockedReasonValue === "string" ? blockedReasonValue : undefined;
    const items = property(details, "items");
    const failedBatchItem = Array.isArray(items)
        ? items.find((item) => property(item, "status") !== "succeeded")
        : undefined;
    const errorCount = property(details, "errorCount");
    const failed = property(details, "failed");
    const passed = property(details, "passed");
    const diagnosticFailure =
        (typeof errorCount === "number" && errorCount > 0) ||
        (typeof failed === "number" && failed > 0) ||
        passed === false;
    if (isError || blockedReason || failedBatchItem || diagnosticFailure) {
        const batchErrorValue = property(failedBatchItem, "error");
        const batchStatus = property(failedBatchItem, "status");
        const batchError =
            typeof batchErrorValue === "string"
                ? batchErrorValue
                : typeof batchStatus === "string"
                  ? batchStatus
                  : failedBatchItem
                    ? "batch item failed"
                    : undefined;
        const detailReason = property(details, "reason");
        const safeDetailReason =
            typeof detailReason === "string" ? detailReason : undefined;
        const reason =
            blockedReason ??
            batchError ??
            (safeDetailReason !== undefined
                ? safeDetailReason
                : diagnosticFailure
                  ? "diagnostic or test failure"
                  : "tool error");
        return {
            priority: CAPTURE_PRIORITIES.blocker,
            text: `${toolName} failed: ${reason}`,
            references: resolvedReferences,
        };
    }
    if (toolName === "think_execute" || toolName === "think_batch_execute") {
        return {
            priority: CAPTURE_PRIORITIES.verifiedFact,
            text: `${toolName} succeeded`,
            references: resolvedReferences,
        };
    }
    if (toolName === "edit" || toolName === "write") {
        const pathValue = property(details, "path");
        const path = typeof pathValue === "string" ? pathValue : "";
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
