/**
 * Registration-level tests for the plan-review hint appended to successful
 * write_plan / edit_plan results under a guarded planning role.
 */

import { describe, expect, it, mock, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const getActiveRole = mock();
const readFrontmatter = mock();

mock.module("@plannotator/pi-extension/config.js", () => ({
    loadPlannotatorConfig: () => ({ config: { planFileDir: "pi-plans" } }),
    resolvePlanFileDir: () => "pi-plans",
}));
mock.module("../_shared/pi-roles.ts", () => ({
    getActiveRole,
    readFrontmatter,
}));

type ExecuteResult = {
    content: Array<{ type: string; text: string }>;
    details: unknown;
    isError: boolean;
};

function setup() {
    const { registerPlanTools } = require("./plan-tools");
    const tools = new Map<
        string,
        {
            execute: (
                toolCallId: string,
                params: Record<string, unknown>,
                signal: undefined,
                onUpdate: undefined,
                ctx: unknown,
            ) => Promise<ExecuteResult>;
        }
    >();
    const pi = {
        registerTool: (tool: { name: string }) =>
            tools.set(tool.name, tool as never),
    };
    registerPlanTools(pi as never);
    return tools;
}

const cleanup: string[] = [];

afterEach(() => {
    for (const dir of cleanup.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function newCwd() {
    const cwd = mkdtempSync(join(tmpdir(), "plan-hint-"));
    cleanup.push(cwd);
    return cwd;
}

function guardedCtx(cwd: string, guard: string | undefined) {
    getActiveRole.mockReturnValue({ path: "/roles/plan.md", name: "plan" });
    readFrontmatter.mockReturnValue(
        guard === undefined ? {} : { handoffGuard: guard },
    );
    return {
        cwd,
        sessionManager: {
            getEntries: () => [],
            getSessionId: () => "session-1",
        },
    };
}

describe("plan review hint", () => {
    it("appends a submit hint to a successful write_plan under a guarded role", async () => {
        const tools = setup();
        const cwd = newCwd();
        const result = await tools.get("write_plan")!.execute(
            "call-1",
            { path: "feature.md", content: "# Plan" },
            undefined,
            undefined,
            guardedCtx(cwd, "plan-submission"),
        );

        expect(result.isError).toBe(false);
        expect(result.content[0]?.text).toContain("to pi-plans/feature.md");
        expect(result.content[0]?.text).toContain(
            "Plan revision pending review: submit it with plan_submit for approval.",
        );
    });

    it("appends a submit hint to a successful edit_plan under a guarded role", async () => {
        const tools = setup();
        const cwd = newCwd();
        const write = await tools.get("write_plan")!.execute(
            "call-1",
            { path: "feature.md", content: "# Plan" },
            undefined,
            undefined,
            guardedCtx(cwd, "plan-submission"),
        );
        expect(write.isError).toBe(false);

        const result = await tools.get("edit_plan")!.execute(
            "call-2",
            {
                path: "feature.md",
                edits: [{ oldText: "# Plan", newText: "# Plan v2" }],
            },
            undefined,
            undefined,
            guardedCtx(cwd, "plan-submission"),
        );

        expect(result.isError).toBe(false);
        expect(result.content[0]?.text).toContain(
            "Plan revision pending review: submit it with plan_submit for approval.",
        );
    });

    it("adds no hint when the active role is not guarded", async () => {
        const tools = setup();
        const result = await tools.get("write_plan")!.execute(
            "call-1",
            { path: "feature.md", content: "# Plan" },
            undefined,
            undefined,
            guardedCtx(newCwd(), undefined),
        );

        expect(result.isError).toBe(false);
        expect(result.content[0]?.text).not.toContain("plan_submit");
    });

    it("adds no hint to a failed write even under a guarded role", async () => {
        const tools = setup();
        const result = await tools.get("edit_plan")!.execute(
            "call-1",
            {
                path: "missing.md",
                edits: [{ oldText: "x", newText: "y" }],
            },
            undefined,
            undefined,
            guardedCtx(newCwd(), "plan-submission"),
        );

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).not.toContain("plan_submit");
    });
});
