/**
 * Deterministic 1500-token post-compaction snapshot builder.
 *
 * Priority order (high → low):
 *   1. unresolved blockers / errors
 *   2. user decisions / corrections
 *   3. active objective / open actions
 *   4. verified facts (file paths, command outcomes, archive references)
 *
 * Completed / noisy events are dropped. Archive references are always
 * preserved (they are opaque IDs, not raw bytes).
 *
 * Output is hard-clamped to the configured token budget using Pi's exported
 * `estimateTokens` (chars/4 conservative heuristic).
 *
 * Stable for identical records: ties are broken by (priority, turnIndex, id)
 * then alphabetically by id. No tool-routing directives are ever emitted.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

import type { CaptureRecord } from "./capture.ts";

export const SNAPSHOT_ENTRY_TYPE = "think-in-code:snapshot";

export interface SnapshotOptions {
    /** Hard token budget. Default: 1500. */
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

/**
 * Sort and truncate capture records to fit inside the token budget.
 *
 * No routing directives are ever included — output is a passive
 * project-context summary only.
 */
export function buildSnapshot(
    records: readonly CaptureRecord[],
    options: SnapshotOptions = {},
): Snapshot {
    const tokenBudget = options.tokenBudget ?? 1500;
    const sorted = [...records].sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        if (a.turnIndex !== b.turnIndex) return a.turnIndex - b.turnIndex;
        return a.id.localeCompare(b.id);
    });

    const kept: CaptureRecord[] = [];
    let droppedCount = 0;
    let working = "";
    let archiveReferenceCount = 0;

    for (const record of sorted) {
        const line = formatRecord(record);
        const candidate = working ? `${working}\n${line}` : line;
        const estimate = estimateTokens(syntheticMessage(candidate));
        if (estimate > tokenBudget) {
            // If a single record exceeds the budget on its own, still keep
            // its archive references (always preserved), then drop the rest.
            if (record.references && record.references.length > 0) {
                const refLine = `archiveRefs(${record.id}): ${record.references.join(", ")}`;
                const refCandidate = working
                    ? `${working}\n${refLine}`
                    : refLine;
                const refEstimate = estimateTokens(
                    syntheticMessage(refCandidate),
                );
                if (refEstimate <= tokenBudget) {
                    working = refCandidate;
                    archiveReferenceCount += record.references.length;
                    kept.push(record);
                    continue;
                }
            }
            droppedCount += 1;
            continue;
        }
        working = candidate;
        if (record.references) {
            archiveReferenceCount += record.references.length;
        }
        kept.push(record);
    }

    const estimatedTokens = estimateTokens(syntheticMessage(working));
    const byteCount = Buffer.byteLength(working, "utf8");
    const deterministicHash = simpleHash(kept.map((r) => r.id).join("|"));
    return {
        content: working,
        byteCount,
        estimatedTokens,
        droppedCount,
        archiveReferenceCount,
        deterministicHash,
    };
}

function formatRecord(record: CaptureRecord): string {
    const refs =
        record.references && record.references.length > 0
            ? ` [refs:${record.references.join(",")}]`
            : "";
    return `${tagFor(record.priority)} t${record.turnIndex} ${record.text}${refs}`;
}

function tagFor(priority: CaptureRecord["priority"]): string {
    switch (priority) {
        case 0:
            return "[blocker]";
        case 1:
            return "[decision]";
        case 2:
            return "[objective]";
        case 3:
            return "[verified]";
        case 4:
            return "[claim]";
        default:
            return "[note]";
    }
}

function syntheticMessage(content: string): AgentMessage {
    // SAFETY: estimateTokens reads only role + content blocks; we cast the
    // minimal subset it actually inspects.
    return {
        role: "user",
        content: [{ type: "text", text: content }],
        timestamp: 0,
    } as unknown as AgentMessage;
}

/** Deterministic FNV-1a-style hash; sufficient for change detection. */
function simpleHash(input: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}
