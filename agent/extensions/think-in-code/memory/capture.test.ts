import { describe, expect, it } from "bun:test";

import {
    CAPTURE_PRIORITIES,
    classifyToolCall,
    classifyToolResult,
} from "./capture";

describe("capture classification", () => {
    it("reads a successful think_execute header from content when details are absent", () => {
        const result = classifyToolResult({
            toolName: "think_execute",
            isError: false,
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        status: "success",
                        action: "content",
                        sourceStatus: "succeeded",
                        sourceBytes: 12,
                        resultBytes: 4,
                        truncated: false,
                        archiveIds: ["archive123"],
                    }),
                },
                { type: "text", text: "safe derivation" },
            ],
        });

        expect(result.priority).toBe(CAPTURE_PRIORITIES.verifiedFact);
        expect(result.text).toBe("think_execute succeeded: content, 12→4 bytes");
        expect(result.references).toEqual(["archive123"]);
    });

    it("reads a partial batch header from content without depending on details", () => {
        const result = classifyToolResult({
            toolName: "think_execute",
            isError: false,
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
                        total: 3,
                        succeeded: 2,
                        failed: 1,
                        blocked: 0,
                    }),
                },
                { type: "text", text: "partial derivation" },
            ],
        });

        expect(result.priority).toBe(CAPTURE_PRIORITIES.blocker);
        expect(result.text).toBe(
            "think_execute partial: batch, succeeded=2, failed=1, blocked=0",
        );
        expect(result.references).toEqual(["archive456"]);
    });

    it("reads a terminal think_execute error payload from content", () => {
        const result = classifyToolResult({
            toolName: "think_execute",
            isError: true,
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

        expect(result.priority).toBe(CAPTURE_PRIORITIES.blocker);
        expect(result.text).toBe(
            "think_execute failed [setup-failed]: Sandbox setup failed",
        );
    });

    it("assigns blocker priority to error tool results and surfaces the reason", () => {
        const result = classifyToolResult({
            toolName: "bash",
            isError: true,
            details: { reason: "command not allowed" },
        });
        expect(result.priority).toBe(CAPTURE_PRIORITIES.blocker);
        expect(result.text).toContain("command not allowed");
    });

    it("classifies broker-blocked Think results as blockers without isError", () => {
        const result = classifyToolResult({
            toolName: "think_execute",
            isError: false,
            details: { blockedReason: "analysis sandbox unavailable" },
        });
        expect(result.priority).toBe(CAPTURE_PRIORITIES.blocker);
        expect(result.text).toContain("analysis sandbox unavailable");
    });

    it("classifies failed batch items and failed diagnostics as blockers", () => {
        expect(
            classifyToolResult({
                toolName: "think_execute",
                isError: false,
                details: { items: [{ id: "a", status: "failed", error: "exit 1" }] },
            }).priority,
        ).toBe(CAPTURE_PRIORITIES.blocker);
        expect(
            classifyToolResult({
                toolName: "lsp_diagnostics",
                isError: false,
                details: { errorCount: 2 },
            }).priority,
        ).toBe(CAPTURE_PRIORITIES.blocker);
    });

    it("elevates think_execute success to a verified fact with archive references", () => {
        const result = classifyToolResult({
            toolName: "think_execute",
            isError: false,
            references: ["abc12345"],
        });
        expect(result.priority).toBe(CAPTURE_PRIORITIES.verifiedFact);
        expect(result.references).toEqual(["abc12345"]);
    });

    it("captures edit/write paths as verified facts", () => {
        const editResult = classifyToolResult({
            toolName: "edit",
            isError: false,
            details: { path: "/tmp/file.ts" },
        });
        expect(editResult.text).toBe("edit /tmp/file.ts");
    });

    it("keeps tool-call classification deterministic for the same input", () => {
        const a = classifyToolCall({
            toolName: "bash",
            args: { command: "ls" },
        });
        const b = classifyToolCall({
            toolName: "bash",
            args: { command: "ls" },
        });
        expect(a.priority).toBe(b.priority);
        expect(a.text).toBe(b.text);
    });

    it("extracts subject fields per tool name", () => {
        expect(
            classifyToolCall({
                toolName: "read",
                args: { path: "/tmp/file" },
            }).text,
        ).toContain("/tmp/file");
        expect(
            classifyToolCall({
                toolName: "grep",
                args: { pattern: "needle" },
            }).text,
        ).toContain("needle");
    });
});
