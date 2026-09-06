import { describe, expect, it } from "bun:test";

import { parseThinkExecutionReceipt } from "./capture.ts";

describe("Think execution receipt capture", () => {
    it("reads status, derivation and archives from content without details", () => {
        const receipt = parseThinkExecutionReceipt({
            toolName: "think_execute",
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        status: "partial",
                        action: "batch",
                        sourceStatus: "mixed",
                        sourceBytes: 20,
                        resultBytes: 5,
                        truncated: false,
                        archiveIds: ["archive456"],
                        indexStatus: "indexed",
                        total: 3,
                        succeeded: 2,
                        failed: 1,
                        blocked: 0,
                    }),
                },
                { type: "text", text: "partial derivation" },
            ],
        });

        expect(receipt).toEqual({
            status: "partial",
            action: "batch",
            sourceStatus: "mixed",
            sourceBytes: 20,
            resultBytes: 5,
            truncated: false,
            indexStatus: "indexed",
            archiveIds: ["archive456"],
            derivation: "partial derivation",
        });
    });

    it("reads a safe terminal error from content without details", () => {
        const receipt = parseThinkExecutionReceipt({
            toolName: "think_execute",
            content: [
                {
                    type: "text",
                    text: `Error: ${JSON.stringify({
                        tool: "think_execute",
                        status: "error",
                        action: "command",
                        stage: "source",
                        code: "setup-failed",
                        reason: "Sandbox setup failed",
                        recovery: "restore_sandbox",
                    })}`,
                },
            ],
        });

        expect(receipt).toEqual({
            status: "error",
            action: "command",
            code: "setup-failed",
            reason: "Sandbox setup failed",
            recovery: "restore_sandbox",
            archiveIds: [],
        });
    });

    it("ignores every non-Think tool result", () => {
        expect(
            parseThinkExecutionReceipt({
                toolName: "bash",
                content: [{ type: "text", text: "large output" }],
                details: { reason: "command failed" },
            }),
        ).toBeNull();
    });
});
