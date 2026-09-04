import { beforeEach, describe, expect, it, mock } from "bun:test";

const getActiveRole = mock();
const readFrontmatter = mock();
const registerRoleTransitionPolicy = mock();

mock.module("../_shared/pi-roles.ts", () => ({
    ACTIVE_ROLE_ENTRY_TYPE: "pi-roles:active-role",
    getActiveRole,
    readFrontmatter,
    registerRoleTransitionPolicy,
}));

const {
    default: registerSessionPlanPersistenceGuard,
} = await import("./session-plan-persistence-guard.ts");

type Handler = (event: any, ctx: any) => any;

const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
    },
};

function assistantText(text: string) {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "openai-completions",
        provider: "openai",
        model: "test-model",
        usage,
        stopReason: "stop",
        timestamp: Date.now(),
    };
}

function setup() {
    const handlers = new Map<string, Handler>();
    const sentUserMessages: Array<{ content: string; options?: unknown }> = [];
    const entries: Array<{
        type: "custom";
        customType: string;
        data: Record<string, unknown>;
    }> = [];
    const pi = {
        on: (event: string, handler: Handler) => handlers.set(event, handler),
        sendUserMessage: (content: string, options?: unknown) => {
            sentUserMessages.push({ content, options });
        },
        appendEntry: (customType: string, data: Record<string, unknown>) => {
            entries.push({ type: "custom", customType, data });
        },
    };
    const ctx = {
        sessionManager: {
            getSessionId: () => "session-1",
            getSessionFile: () => undefined,
            getEntries: () => entries,
        },
    };

    registerSessionPlanPersistenceGuard(pi as never);
    return { ctx, entries, handlers, sentUserMessages };
}

describe("session plan persistence guard", () => {
    beforeEach(() => {
        getActiveRole.mockReset();
        readFrontmatter.mockReset();
        registerRoleTransitionPolicy.mockReset();
        getActiveRole.mockReturnValue({
            name: "quick-planner",
            path: "/roles/quick-planner.md",
            appliedAt: 100,
        });
        readFrontmatter.mockReturnValue({
            handoffGuard: "session-plan-persistence",
        });
    });

    it("withholds final prose and forces session_plan save when current planning turn has no successful save", () => {
        const { ctx, handlers, sentUserMessages } = setup();

        handlers.get("before_agent_start")!({}, ctx);
        const result = handlers.get("message_end")!(
            { message: assistantText("unpersisted plan") },
            ctx,
        );
        handlers.get("turn_end")!({}, ctx);

        expect(result.message.content).toEqual([
            expect.objectContaining({
                type: "text",
                text: expect.stringContaining("session_plan"),
            }),
        ]);
        expect(JSON.stringify(result.message.content)).not.toContain(
            "unpersisted plan",
        );
        expect(sentUserMessages).toEqual([
            {
                content: expect.stringContaining("session_plan"),
                options: { deliverAs: "followUp" },
            },
        ]);
    });

    it("fails closed when lifecycle state is missing after reload", () => {
        const { ctx, handlers } = setup();

        const result = handlers.get("message_end")!(
            { message: assistantText("answer after reload") },
            ctx,
        );

        expect(result?.message?.content).toEqual([
            expect.objectContaining({
                text: expect.stringContaining("session_plan"),
            }),
        ]);
    });

    it("allows final prose after a successful session_plan save and records durable evidence", () => {
        const { ctx, entries, handlers, sentUserMessages } = setup();
        handlers.get("before_agent_start")!({}, ctx);

        handlers.get("tool_result")!(
            {
                toolName: "session_plan",
                isError: false,
                details: {
                    action: "save",
                    topic: "durable-quick-plan",
                    exists: true,
                    version: 2,
                },
            },
            ctx,
        );
        const result = handlers.get("message_end")!(
            { message: assistantText("persisted plan") },
            ctx,
        );
        handlers.get("turn_end")!({}, ctx);

        expect(result).toBeUndefined();
        expect(sentUserMessages).toEqual([]);
        expect(entries).toEqual([
            {
                type: "custom",
                customType: "session-plan-persistence-guard:saved",
                data: expect.objectContaining({
                    role: "quick-planner",
                    topic: "durable-quick-plan",
                    version: 2,
                }),
            },
        ]);
    });

    it("blocks leaving opted-in planning role until current role has persisted a plan", () => {
        const { ctx, entries, handlers } = setup();
        entries.push({
            type: "custom",
            customType: "pi-roles:active-role",
            data: {
                name: "quick-planner",
                source: "user",
                path: "/roles/quick-planner.md",
                appliedAt: 100,
            },
        });
        const policy = registerRoleTransitionPolicy.mock.calls[0]?.[0];

        expect(
            policy({
                from: {
                    name: "quick-planner",
                    handoffGuard: "session-plan-persistence",
                },
                to: { name: "pi-agent" },
                sessionEntries: entries,
            }),
        ).toEqual({
            allow: false,
            reason: expect.stringContaining("session_plan"),
        });

        handlers.get("before_agent_start")!({}, ctx);
        handlers.get("tool_result")!(
            {
                toolName: "session_plan",
                isError: false,
                details: {
                    action: "save",
                    topic: "handoff-plan",
                    exists: true,
                    version: 1,
                },
            },
            ctx,
        );

        expect(
            policy({
                from: {
                    name: "quick-planner",
                    handoffGuard: "session-plan-persistence",
                },
                to: { name: "pi-agent" },
                sessionEntries: entries,
            }),
        ).toEqual({ allow: true });
    });

    it("allows leaving after reload re-applies the same role with a saved plan", () => {
        const { entries } = setup();
        entries.push(
            {
                type: "custom",
                customType: "pi-roles:active-role",
                data: {
                    name: "quick-planner",
                    source: "user",
                    path: "/roles/quick-planner.md",
                    appliedAt: 100,
                },
            },
            {
                type: "custom",
                customType: "session-plan-persistence-guard:saved",
                data: {
                    role: "quick-planner",
                    roleAppliedAt: 100,
                },
            },
            {
                type: "custom",
                customType: "pi-roles:active-role",
                data: {
                    name: "quick-planner",
                    source: "user",
                    path: "/roles/quick-planner.md",
                    appliedAt: 200,
                },
            },
        );
        const policy = registerRoleTransitionPolicy.mock.calls[0]?.[0];

        expect(
            policy({
                from: {
                    name: "quick-planner",
                    handoffGuard: "session-plan-persistence",
                },
                to: { name: "pi-agent" },
                sessionEntries: entries,
            }),
        ).toEqual({ allow: true });
    });

    it("allows final prose after reload restores a role with a saved plan", () => {
        getActiveRole.mockReturnValue({
            name: "quick-planner",
            path: "/roles/quick-planner.md",
            appliedAt: 200,
        });
        const { ctx, entries, handlers } = setup();
        entries.push(
            {
                type: "custom",
                customType: "pi-roles:active-role",
                data: {
                    name: "quick-planner",
                    source: "user",
                    path: "/roles/quick-planner.md",
                    appliedAt: 100,
                },
            },
            {
                type: "custom",
                customType: "session-plan-persistence-guard:saved",
                data: {
                    role: "quick-planner",
                    roleAppliedAt: 100,
                },
            },
            {
                type: "custom",
                customType: "pi-roles:active-role",
                data: {
                    name: "quick-planner",
                    source: "user",
                    path: "/roles/quick-planner.md",
                    appliedAt: 200,
                },
            },
        );

        handlers.get("before_agent_start")!({}, ctx);

        expect(
            handlers.get("message_end")!(
                { message: assistantText("implementation handoff") },
                ctx,
            ),
        ).toBeUndefined();
    });

    it("requires a new save after leaving and re-entering the planning role", () => {
        const { entries } = setup();
        entries.push(
            {
                type: "custom",
                customType: "pi-roles:active-role",
                data: { name: "quick-planner", appliedAt: 100 },
            },
            {
                type: "custom",
                customType: "session-plan-persistence-guard:saved",
                data: { role: "quick-planner", roleAppliedAt: 100 },
            },
            {
                type: "custom",
                customType: "pi-roles:active-role",
                data: { name: "pi-agent", appliedAt: 150 },
            },
            {
                type: "custom",
                customType: "pi-roles:active-role",
                data: { name: "quick-planner", appliedAt: 200 },
            },
        );
        const policy = registerRoleTransitionPolicy.mock.calls[0]?.[0];

        expect(
            policy({
                from: {
                    name: "quick-planner",
                    handoffGuard: "session-plan-persistence",
                },
                to: { name: "pi-agent" },
                sessionEntries: entries,
            }),
        ).toEqual({
            allow: false,
            reason: expect.stringContaining("session_plan"),
        });
    });

    it("does not accept history, failed saves, or roles without opt-in", () => {
        const { ctx, entries, handlers } = setup();
        handlers.get("before_agent_start")!({}, ctx);

        handlers.get("tool_result")!(
            {
                toolName: "session_plan",
                isError: false,
                details: { action: "history", topic: "plan", exists: true },
            },
            ctx,
        );
        handlers.get("tool_result")!(
            {
                toolName: "session_plan",
                isError: true,
                details: {
                    action: "save",
                    topic: "plan",
                    exists: true,
                    version: 1,
                },
            },
            ctx,
        );

        expect(
            handlers.get("message_end")!(
                { message: assistantText("still unpersisted") },
                ctx,
            ),
        ).toBeDefined();
        expect(entries).toEqual([]);

        readFrontmatter.mockReturnValue({});
        expect(
            handlers.get("message_end")!(
                { message: assistantText("ordinary response") },
                ctx,
            ),
        ).toBeUndefined();
    });
});
