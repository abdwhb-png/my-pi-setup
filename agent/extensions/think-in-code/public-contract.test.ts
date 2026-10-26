import { expect, test } from "bun:test";
import { createThinkExecutionError, parseThinkFailurePayload } from "./public-contract.ts";

test("failure serialization and parsing preserve only closed analysis error classes", () => {
    const base = {
        action: "content" as const, stage: "analysis" as const,
        code: "analysis-failed", reason: "Analysis failed", recovery: "change_program" as const,
    };
    const error = createThinkExecutionError({ ...base, errorClass: "SyntaxError" });
    const content = [{ type: "text", text: error.message }];
    expect(parseThinkFailurePayload(content)).toMatchObject({ ...base, errorClass: "SyntaxError" });
    for (const errorClass of [undefined, "SECRET_ERROR_NAME", { name: "SyntaxError" }]) {
        const payload = { tool: "think_execute", status: "error", ...base, errorClass };
        expect(parseThinkFailurePayload([{ type: "text", text: JSON.stringify(payload) }]))
            .toEqual({ tool: "think_execute", status: "error", ...base });
    }
});
