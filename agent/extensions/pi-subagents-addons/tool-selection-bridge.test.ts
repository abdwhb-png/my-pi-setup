import { describe, expect, it } from "bun:test";
import { resolvePiLaunchToolPlan } from "pi-subagents/child-tool-plan";
import { resolveSubagentToolSelection, splitToolSelectors } from "pi-subagents/tool-selection";
import { registerToolGroupChildSelection } from "./tool-selection-bridge.ts";

describe("tool-group child selection bridge", () => {
    it("expands nested groups before the child tool ceiling, keeping direct names", () => {
        const dispose = registerToolGroupChildSelection(
            { inspect: ["read", "@lens"], lens: ["grep"] },
            () => ["read", "grep"],
        );
        try {
            const plan = resolvePiLaunchToolPlan({
                tools: ["@inspect", "ls"],
                capabilityCeiling: { version: 1, allowedTools: ["read", "ls"], denyExtensions: false, sources: ["test"] },
            });
            expect(plan.resolvedDeclaredTools).toEqual(["read", "grep", "ls"]);
            expect(plan.effectiveToolAllowlist).toEqual(["read", "ls"]);
        } finally {
            dispose();
        }
    });

    it("keeps MCP selectors for pi-subagents to resolve through its own MCP path", () => {
        const dispose = registerToolGroupChildSelection(
            { docs: ["mcp:context7", "read"] },
            () => ["read"],
        );
        try {
            const selectors = resolveSubagentToolSelection({ tools: ["@docs"] });
            expect(selectors).toEqual(["mcp:context7", "read"]);
            expect(splitToolSelectors(selectors)).toEqual({ tools: ["read"], mcpDirectTools: ["context7"] });
        } finally {
            dispose();
        }
    });

    it("rejects cycles and missing groups instead of silently omitting tools", () => {
        const dispose = registerToolGroupChildSelection(
            { first: ["@second"], second: ["@first"] },
            () => [],
        );
        try {
            expect(() => resolvePiLaunchToolPlan({ tools: ["@first"] })).toThrow(/cycle/i);
            expect(() => resolvePiLaunchToolPlan({ tools: ["@missing"] })).toThrow(/missing-group/i);
        } finally {
            dispose();
        }
    });
});
