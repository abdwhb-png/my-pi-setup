import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const registerRoleTransitionPolicy = mock();
const getActiveRole = mock();
const readFrontmatter = mock();

mock.module("@plannotator/pi-extension/config.js", () => ({
    loadPlannotatorConfig: () => ({ config: { planFileDir: "pi-plans" } }),
    resolvePlanFileDir: () => "pi-plans",
}));
mock.module("../_shared/pi-roles.ts", () => ({
    getActiveRole,
    readFrontmatter,
    registerRoleTransitionPolicy,
}));

const {
    default: registerPlanSubmissionGuard,
} = await import("./plan-submission-guard.ts");
const {
    PLAN_REVIEW_REVISION_ENTRY,
    PLAN_REVIEW_SUBMITTED_ENTRY,
} = await import("./plan-submission-lifecycle.ts");

function setup() {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const entries: Array<{
        type: "custom";
        customType: string;
        data: Record<string, unknown>;
    }> = [];
    const pi = {
        on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) =>
            handlers.set(event, handler),
        appendEntry: (customType: string, data: Record<string, unknown>) =>
            entries.push({ type: "custom", customType, data }),
        registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
            commands.set(name, command),
    };
    const ctx = {
        cwd: "/workspace",
        hasUI: false,
        sessionManager: { getEntries: () => entries },
        ui: { notify: mock(), confirm: mock(() => true) },
    };

    registerPlanSubmissionGuard(pi as never);
    return { handlers, commands, entries, pi, ctx };
}

describe("plan submission guard", () => {
    beforeEach(() => {
        registerRoleTransitionPolicy.mockReset();
        getActiveRole.mockReturnValue({ path: "/roles/plan.md" });
        readFrontmatter.mockReturnValue({ handoffGuard: "plan-submission" });
    });

    afterEach(() => {
        mock.restore();
    });

    it("records a revision and its approved submission from existing tool results", async () => {
        const { handlers, entries, ctx } = setup();
        const onToolResult = handlers.get("tool_result")!;

        await onToolResult(
            {
                toolName: "write_plan",
                isError: false,
                input: { path: "feature.md" },
                details: {},
            },
            ctx,
        );
        await onToolResult(
            {
                toolName: "plan_submit",
                isError: false,
                input: { filePath: "pi-plans/feature.md" },
                details: { approved: true },
            },
            ctx,
        );

        expect(entries).toEqual([
            expect.objectContaining({
                customType: PLAN_REVIEW_REVISION_ENTRY,
                data: expect.objectContaining({ path: "pi-plans/feature.md", revision: 1 }),
            }),
            expect.objectContaining({
                customType: PLAN_REVIEW_SUBMITTED_ENTRY,
                data: expect.objectContaining({
                    path: "pi-plans/feature.md",
                    revision: 1,
                    approved: true,
                }),
            }),
        ]);
    });

    it("blocks exit from a guarded role until a plan revision is approved", () => {
        const { handlers, entries, ctx } = setup();
        handlers.get("session_start")!({}, ctx);
        const policy = registerRoleTransitionPolicy.mock.calls[0]?.[0];

        expect(
            policy({
                from: { handoffGuard: "plan-submission" },
                to: { handoffGuard: undefined },
                transition: { kind: "manual" },
                sessionEntries: entries,
            }),
        ).toEqual({
            allow: false,
            reason: "An approved plan revision is required before leaving this planning role.",
        });
    });

    it("blocks exit when a later plan revision remains a draft", async () => {
        const { handlers, entries, ctx } = setup();
        await handlers.get("tool_result")!(
            {
                toolName: "write_plan",
                isError: false,
                input: { path: "approved.md" },
                details: {},
            },
            ctx,
        );
        await handlers.get("tool_result")!(
            {
                toolName: "plan_submit",
                isError: false,
                input: { filePath: "pi-plans/approved.md" },
                details: { approved: true },
            },
            ctx,
        );
        await handlers.get("tool_result")!(
            {
                toolName: "write_plan",
                isError: false,
                input: { path: "feature.md" },
                details: {},
            },
            ctx,
        );
        const policy = registerRoleTransitionPolicy.mock.calls[0]?.[0];

        expect(
            policy({
                from: { handoffGuard: "plan-submission" },
                to: { handoffGuard: undefined },
                transition: { kind: "manual" },
                sessionEntries: entries,
            }),
        ).toEqual({
            allow: false,
            reason: "Plan approval required for pi-plans/feature.md. Submit it for approval before leaving this planning role.",
        });
    });

    it("permits exit after the latest revision is approved", async () => {
        const { handlers, entries, ctx } = setup();
        await handlers.get("tool_result")!(
            {
                toolName: "write_plan",
                isError: false,
                input: { path: "feature.md" },
                details: {},
            },
            ctx,
        );
        await handlers.get("tool_result")!(
            {
                toolName: "plan_submit",
                isError: false,
                input: { filePath: "pi-plans/feature.md" },
                details: { approved: true },
            },
            ctx,
        );
        const policy = registerRoleTransitionPolicy.mock.calls[0]?.[0];

        expect(
            policy({
                from: { handoffGuard: "plan-submission" },
                to: { handoffGuard: undefined },
                transition: { kind: "request" },
                sessionEntries: entries,
            }),
        ).toEqual({ allow: true });
    });

    it("does not track generic plan-tool results outside an opted-in role", async () => {
        getActiveRole.mockReturnValue({ path: "/roles/quick-planner.md" });
        readFrontmatter.mockReturnValue({});
        const { handlers, entries, ctx } = setup();

        await handlers.get("tool_result")!(
            {
                toolName: "write_plan",
                isError: false,
                input: { path: "feature.md" },
                details: {},
            },
            ctx,
        );

        expect(entries).toEqual([]);
    });

    it("abandons a tracked revision only after interactive confirmation", async () => {
        const { handlers, commands, entries, ctx } = setup();
        ctx.hasUI = true;
        await handlers.get("tool_result")!(
            {
                toolName: "write_plan",
                isError: false,
                input: { path: "feature.md" },
                details: {},
            },
            ctx,
        );

        await commands.get("abandon-plan")!.handler("pi-plans/feature.md", ctx);

        expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
        expect(entries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    customType: "plan-review-guard:abandoned",
                    data: expect.objectContaining({
                        path: "pi-plans/feature.md",
                        revision: 1,
                    }),
                }),
            ]),
        );

        const policy = registerRoleTransitionPolicy.mock.calls[0]?.[0];
        expect(
            policy({
                from: { handoffGuard: "plan-submission" },
                to: { handoffGuard: undefined },
                transition: { kind: "manual" },
                sessionEntries: entries,
            }),
        ).toEqual({
            allow: false,
            reason: "An approved plan revision is required before leaving this planning role.",
        });
    });

    it("registers no turn_end reminder", async () => {
        const { handlers, ctx } = setup();
        ctx.hasUI = true;
        await handlers.get("tool_result")!(
            {
                toolName: "write_plan",
                isError: false,
                input: { path: "feature.md" },
                details: {},
            },
            ctx,
        );

        expect(handlers.has("turn_end")).toBe(false);
        expect(ctx.ui.notify).not.toHaveBeenCalled();
    });
});
