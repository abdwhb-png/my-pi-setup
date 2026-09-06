/** Deterministic, one-shot Think execution receipt for post-compaction use. */

import { isCaptureRecord, type ThinkExecutionReceipt } from "./capture.ts";

export const SNAPSHOT_ENTRY_TYPE = "think-in-code:snapshot";
export const MAX_RECEIPT_SNAPSHOT_BYTES = 2048;

export interface SnapshotOptions {
    /** Hard byte budget, clamped to 2 KiB. */
    byteBudget?: number;
    /** Backward-compatible input; converted at four bytes per token. */
    tokenBudget?: number;
}

export interface Snapshot {
    content: string;
    byteCount: number;
    estimatedTokens: number;
    droppedCount: number;
    archiveReferenceCount: number;
    deterministicHash: string;
}

interface SnapshotReceipt extends ThinkExecutionReceipt {
    turnIndex: number;
}

export function buildSnapshot(
    records: readonly unknown[],
    options: SnapshotOptions = {},
): Snapshot {
    const requestedBudget =
        options.byteBudget ??
        (options.tokenBudget === undefined
            ? MAX_RECEIPT_SNAPSHOT_BYTES
            : options.tokenBudget * 4);
    const byteBudget = Math.max(
        256,
        Math.min(MAX_RECEIPT_SNAPSHOT_BYTES, Math.floor(requestedBudget)),
    );
    const valid = records
        .filter(isCaptureRecord)
        .toSorted(
            (left, right) =>
                right.turnIndex - left.turnIndex ||
                right.createdAt - left.createdAt ||
                right.id.localeCompare(left.id),
        );
    const receipts: SnapshotReceipt[] = [];
    let droppedCount = records.length - valid.length;

    for (const record of valid) {
        const candidate: SnapshotReceipt = {
            turnIndex: record.turnIndex,
            ...record.receipt,
            archiveIds: [...record.receipt.archiveIds],
        };
        if (tryAppend(receipts, candidate, byteBudget)) continue;

        const withoutDerivation = { ...candidate };
        delete withoutDerivation.derivation;
        if (tryAppend(receipts, withoutDerivation, byteBudget)) continue;

        const boundedReferences = {
            ...withoutDerivation,
            archiveIds: [] as string[],
        };
        for (const archiveId of withoutDerivation.archiveIds) {
            const next = {
                ...boundedReferences,
                archiveIds: [...boundedReferences.archiveIds, archiveId],
            };
            if (fits([...receipts, next], byteBudget)) {
                boundedReferences.archiveIds.push(archiveId);
            } else {
                break;
            }
        }
        if (tryAppend(receipts, boundedReferences, byteBudget)) continue;
        droppedCount += 1;
    }

    const content = serialize(receipts);
    const byteCount = Buffer.byteLength(content, "utf8");
    return {
        content,
        byteCount,
        estimatedTokens: Math.ceil(byteCount / 4),
        droppedCount,
        archiveReferenceCount: receipts.reduce(
            (total, receipt) => total + receipt.archiveIds.length,
            0,
        ),
        deterministicHash: simpleHash(content),
    };
}

function tryAppend(
    receipts: SnapshotReceipt[],
    receipt: SnapshotReceipt,
    byteBudget: number,
): boolean {
    if (!fits([...receipts, receipt], byteBudget)) return false;
    receipts.push(receipt);
    return true;
}

function fits(
    receipts: readonly SnapshotReceipt[],
    byteBudget: number,
): boolean {
    return Buffer.byteLength(serialize(receipts), "utf8") <= byteBudget;
}

function serialize(receipts: readonly SnapshotReceipt[]): string {
    return JSON.stringify({ type: "think-execution-receipts", receipts });
}

function simpleHash(input: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}
