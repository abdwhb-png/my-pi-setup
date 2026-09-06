/** Bounded capture of Think execution receipts for post-compaction recovery. */

import { redactTextPreservingContext } from "../../_shared/redaction.ts";
import {
    parseThinkExecuteHeader,
    parseThinkFailurePayload,
    type ThinkExecuteHeader,
    type ThinkFailurePayload,
} from "../public-contract.ts";
import type { ThinkStore } from "../storage/store.ts";
import type { ThinkExecuteAction } from "../types.ts";

export const CAPTURE_ENTRY_TYPE = "think-in-code:execution-receipt";
export const CAPTURE_RECORD_VERSION = 2;

export interface ThinkExecutionReceipt {
    status: "success" | "partial" | "error";
    action: ThinkExecuteAction;
    sourceStatus?: "succeeded" | "failed" | "mixed";
    sourceBytes?: number;
    resultBytes?: number;
    truncated?: boolean;
    indexStatus?: ThinkExecuteHeader["indexStatus"];
    code?: string;
    reason?: string;
    recovery?: ThinkFailurePayload["recovery"];
    archiveIds: readonly string[];
    derivation?: string;
}

export interface CaptureRecord {
    version: 2;
    id: string;
    sessionId: string;
    turnIndex: number;
    receipt: ThinkExecutionReceipt;
    createdAt: number;
}

export interface ThinkToolResultCapture {
    toolName: string;
    content?: unknown;
    details?: unknown;
}

export class CaptureBuffer {
    readonly #store: ThinkStore;
    readonly #sessionId: string;
    readonly #maxDerivationChars: number;
    readonly #queue: CaptureRecord[] = [];

    constructor(
        store: ThinkStore,
        sessionId: string,
        maxDerivationChars = 512,
    ) {
        this.#store = store;
        this.#sessionId = sessionId;
        this.#maxDerivationChars = maxDerivationChars;
    }

    addToolResult(
        input: ThinkToolResultCapture,
        turnIndex: number,
    ): CaptureRecord | null {
        const receipt = parseThinkExecutionReceipt(
            input,
            this.#maxDerivationChars,
        );
        if (!receipt) return null;
        const record: CaptureRecord = {
            version: CAPTURE_RECORD_VERSION,
            id: `receipt-${turnIndex}-${this.#queue.length}`,
            sessionId: this.#sessionId,
            turnIndex,
            receipt,
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
                    kind: CAPTURE_ENTRY_TYPE,
                    payload: record,
                });
            } catch {
                // Receipt capture is best-effort and must not affect tool execution.
            }
        }
        return records;
    }

    pending(): readonly CaptureRecord[] {
        return [...this.#queue];
    }
}

export function parseThinkExecutionReceipt(
    input: ThinkToolResultCapture,
    maxDerivationChars = 512,
): ThinkExecutionReceipt | null {
    if (input.toolName !== "think_execute") return null;

    const failure = parseThinkFailurePayload(input.content);
    if (failure) {
        return {
            status: "error",
            action: failure.action,
            code: failure.code,
            reason: failure.reason,
            recovery: failure.recovery,
            archiveIds: archiveIdsFromDetails(input.details),
        };
    }

    const header = parseThinkExecuteHeader(input.content);
    if (!header) return null;
    const derivation = secondText(input.content);
    const safeDerivation = derivation
        ? redactTextPreservingContext(derivation, {
              maxLength: maxDerivationChars,
          })
        : "";
    return receiptFromHeader(header, safeDerivation);
}

export function isCaptureRecord(value: unknown): value is CaptureRecord {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Partial<CaptureRecord>;
    if (
        record.version !== CAPTURE_RECORD_VERSION ||
        typeof record.id !== "string" ||
        typeof record.sessionId !== "string" ||
        !Number.isInteger(record.turnIndex) ||
        typeof record.createdAt !== "number" ||
        typeof record.receipt !== "object" ||
        record.receipt === null
    ) {
        return false;
    }
    const receipt = record.receipt as Partial<ThinkExecutionReceipt>;
    return (
        (receipt.status === "success" ||
            receipt.status === "partial" ||
            receipt.status === "error") &&
        typeof receipt.action === "string" &&
        Array.isArray(receipt.archiveIds) &&
        receipt.archiveIds.every((id) => typeof id === "string")
    );
}

function receiptFromHeader(
    header: ThinkExecuteHeader,
    derivation: string,
): ThinkExecutionReceipt {
    return {
        status: header.status,
        action: header.action,
        sourceStatus: header.sourceStatus,
        sourceBytes: header.sourceBytes,
        resultBytes: header.resultBytes,
        truncated: header.truncated,
        indexStatus: header.indexStatus,
        archiveIds: [...header.archiveIds],
        ...(derivation ? { derivation } : {}),
    };
}

function secondText(content: unknown): string | undefined {
    if (!Array.isArray(content)) return undefined;
    const second = content[1];
    if (typeof second !== "object" || second === null) return undefined;
    const type = Reflect.get(second, "type");
    const text = Reflect.get(second, "text");
    return type === "text" && typeof text === "string" ? text : undefined;
}

function archiveIdsFromDetails(details: unknown): string[] {
    if (typeof details !== "object" || details === null) return [];
    const value = Reflect.get(details, "archiveIds");
    return Array.isArray(value)
        ? value.filter((id): id is string => typeof id === "string")
        : [];
}
