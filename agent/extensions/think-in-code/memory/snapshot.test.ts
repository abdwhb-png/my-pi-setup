import { describe, expect, it } from "bun:test";

import type { CaptureRecord } from "./capture.ts";
import { buildSnapshot } from "./snapshot.ts";

function receipt(
    turnIndex: number,
    derivation = `derived result ${turnIndex}`,
): CaptureRecord {
    return {
        version: 2,
        id: `receipt-${turnIndex}`,
        sessionId: "session",
        turnIndex,
        createdAt: turnIndex,
        receipt: {
            status: "success",
            action: "command",
            sourceStatus: "succeeded",
            sourceBytes: 4096,
            resultBytes: Buffer.byteLength(derivation),
            truncated: false,
            indexStatus: "indexed",
            archiveIds: [`archive-${turnIndex}`],
            derivation,
        },
    };
}

describe("Think execution receipt snapshot", () => {
    it("keeps only technical receipts under the hard 2 KB limit", () => {
        const records: unknown[] = [
            {
                id: "legacy-user-memory",
                source: "user",
                text: "remember my private preference forever",
                priority: 1,
            },
            ...Array.from({ length: 100 }, (_, index) =>
                receipt(index, `bounded derivation ${index} ${"x".repeat(300)}`),
            ),
        ];

        const snapshot = buildSnapshot(records);

        expect(snapshot.byteCount).toBeLessThanOrEqual(2048);
        expect(snapshot.content).not.toContain("private preference");
        expect(snapshot.content).toContain('"type":"think-execution-receipts"');
        expect(snapshot.content).toContain('"action":"command"');
        expect(snapshot.droppedCount).toBeGreaterThan(0);
    });

    it("preserves a safe failure code and recovery without details", () => {
        const record: CaptureRecord = {
            version: 2,
            id: "receipt-error",
            sessionId: "session",
            turnIndex: 3,
            createdAt: 3,
            receipt: {
                status: "error",
                action: "batch",
                code: "sandbox-setup-failed",
                reason: "Sandbox setup failed",
                recovery: "restore_sandbox",
                archiveIds: [],
            },
        };

        const snapshot = buildSnapshot([record]);
        const parsed = JSON.parse(snapshot.content) as {
            receipts: Array<Record<string, unknown>>;
        };
        expect(parsed.receipts[0]).toMatchObject({
            status: "error",
            action: "batch",
            code: "sandbox-setup-failed",
            recovery: "restore_sandbox",
        });
    });

    it("prioritizes the most recent execution receipts", () => {
        const snapshot = buildSnapshot(
            Array.from({ length: 40 }, (_, index) => receipt(index)),
            { byteBudget: 512 },
        );
        expect(snapshot.content).toContain("archive-39");
        expect(snapshot.content).not.toContain("archive-0");
    });
});
