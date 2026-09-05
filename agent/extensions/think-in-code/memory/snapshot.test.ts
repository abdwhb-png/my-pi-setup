import { describe, expect, it } from "bun:test";

import type { CaptureRecord } from "./capture";
import { buildSnapshot } from "./snapshot";

function record(partial: Partial<CaptureRecord>): CaptureRecord {
    return {
        id: partial.id ?? "r",
        sessionId: partial.sessionId ?? "s",
        turnIndex: partial.turnIndex ?? 0,
        priority: partial.priority ?? 3,
        source: partial.source ?? "user",
        text: partial.text ?? "",
        references: partial.references,
        createdAt: partial.createdAt ?? 0,
    };
}

describe("snapshot builder", () => {
    it("clamps output under the token budget", () => {
        const records: CaptureRecord[] = [];
        for (let i = 0; i < 5000; i += 1) {
            records.push(
                record({
                    id: `r-${i}`,
                    turnIndex: i,
                    priority: 3,
                    text: `verified fact number ${i} with enough text to consume tokens quickly`,
                }),
            );
        }
        const snapshot = buildSnapshot(records, { tokenBudget: 1500 });
        expect(snapshot.estimatedTokens).toBeLessThanOrEqual(1500);
        expect(snapshot.droppedCount).toBeGreaterThan(0);
    });

    it("prioritizes blockers over verified facts", () => {
        const records = [
            record({ id: "v1", priority: 3, text: "verified content" }),
            record({ id: "b1", priority: 0, text: "blocker content" }),
        ];
        const snapshot = buildSnapshot(records);
        expect(snapshot.content.indexOf("[blocker]")).toBeLessThan(
            snapshot.content.indexOf("[verified]"),
        );
    });

    it("preserves archive references even when the record text would overflow", () => {
        const records = [
            record({
                id: "huge",
                priority: 0,
                text: "X".repeat(50_000),
                references: ["abc12345", "def67890"],
            }),
        ];
        const snapshot = buildSnapshot(records, { tokenBudget: 200 });
        expect(snapshot.archiveReferenceCount).toBe(2);
        expect(snapshot.content).toContain("abc12345");
    });

    it("produces a deterministic hash for identical records", () => {
        const records = [
            record({ id: "a", priority: 0, text: "first" }),
            record({ id: "b", priority: 3, text: "second" }),
        ];
        const first = buildSnapshot(records);
        const second = buildSnapshot(records);
        expect(first.deterministicHash).toBe(second.deterministicHash);
    });

    it("never emits a routing directive (no @-tool references)", () => {
        const records = [
            record({
                id: "u",
                priority: 1,
                text: "User asked for @ctx_batch_execute to be removed",
            }),
            record({ id: "v", priority: 3, text: "File: /tmp/x.ts" }),
        ];
        const snapshot = buildSnapshot(records);
        expect(snapshot.content).not.toMatch(/use\s+@?think_[a-z_]+/i);
        expect(snapshot.content).not.toMatch(/call\s+@?ctx_[a-z_]+/i);
    });

    it("drops records without priority tags via overflow rather than dropping silently", () => {
        const records = [record({ id: "huge", priority: 0, text: "Y".repeat(20_000) })];
        const snapshot = buildSnapshot(records, { tokenBudget: 50 });
        expect(snapshot.droppedCount).toBe(1);
    });
});