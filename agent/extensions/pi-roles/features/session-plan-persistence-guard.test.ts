import { beforeEach, describe, expect, it, mock } from "bun:test";

const getActiveRole = mock();
const readFrontmatter = mock();
const registerRoleTransitionPolicy = mock();

mock.module("../../_shared/pi-roles/index.ts", () => ({
    ACTIVE_ROLE_ENTRY_TYPE: "pi-roles:active-role",
    getActiveRole,
    readFrontmatter,
    registerRoleTransitionPolicy,
}));

const {
    default: registerSessionPlanPersistenceGuard,
} = await import("./session-plan-persistence-guard.ts");

type Handler = (event: any, ctx: any) => any;

interface CommandContext {
    cwd: string;
    hasUI: boolean;
    ui: {
        confirm: (title: string, message: string) => Promise<boolean>;
        notify: (message: string, level: string) => void;
    };
    sessionManager: {
        getSessionId: () => string;
        getSessionFile: () => undefined;
        getEntries: () => Array<{
            type: "custom";
            customType: string;
            data: Record<string, unknown>;
        }>;
    };
}

function setup(options: { hasUI?: boolean; confirm?: boolean } = {}) {
    const handlers = new Map<string, Handler>();
    const commands = new Map<
        string,
        { handler: (args: string, ctx: CommandContext) => Promise<void> }
    >();
    const sentUserMessages: Array<{ content: string; options?: unknown }> = [];
    const notifications: Array<{ message: string; level: string }> = [];
    const entries: Array<{
        type: "custom";
        customType: string;
        data: Record<string, unknown>;
    }> = [];
    const pi = {
        on: (event: string, handler: Handler) => handlers.set(event, handler),
        registerCommand: (
            name: string,
            command: { handler: (args: string, ctx: CommandContext) => Promise<void> },
        ) => commands.set(name, command),
        sendUserMessage: (content: string, options?: unknown) => {
            sentUserMessages.push({ content, options });
        },
        appendEntry: (customType: string, data: Record<string, unknown>) => {
            entries.push({ type: "custom", customType, data });
        },
    };
    const ctx: CommandContext = {
        cwd: "/workspace",
        hasUI: options.hasUI ?? true,
        ui: {
            confirm: async () => options.confirm ?? true,
            notify: (message: string, level: string) => {
                notifications.push({ message, level });
            },
        },
        sessionManager: {
            getSessionId: () => "session-1",
            getSessionFile: () => undefined,
            getEntries: () => entries,
        },
    };

    registerSessionPlanPersistenceGuard(pi as never);
    return { ctx, entries, handlers, sentUserMessages, commands, notifications };
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

    it("registers no content-path handlers, so it can never withhold an answer", () => {
        const { handlers } = setup();

        expect(handlers.has("message_end")).toBe(false);
        expect(handlers.has("turn_end")).toBe(false);
        expect(handlers.has("before_agent_start")).toBe(false);
    });

    it("fails closed on handoff when lifecycle state is missing after reload", () => {
        const { entries } = setup();
        entries.push({
            type: "custom",
            customType: "pi-roles:active-role",
            data: { name: "quick-planner", appliedAt: 100 },
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
    });

    it("records durable evidence on a successful save and allows handoff", () => {
        const { ctx, entries, handlers } = setup();

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

    it("allows leaving after reload restores a role with a saved plan", () => {
        getActiveRole.mockReturnValue({
            name: "quick-planner",
            path: "/roles/quick-planner.md",
            appliedAt: 200,
        });
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

    it("does not accept history or failed saves as persistence evidence", () => {
        const { ctx, entries, handlers } = setup();

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
        expect(entries).toEqual([]);
    });

    it("does not engage for roles without the session-plan persistence opt-in", async () => {
        readFrontmatter.mockReturnValue({});
        const { ctx, entries, commands, notifications } = setup();

        const command = commands.get("session-plan-abandon");
        if (!command) throw new Error("/session-plan-abandon was not registered");
        await command.handler("", ctx);

        expect(notifications).toEqual([
            {
                message: expect.stringContaining(
                    "No session-plan persistence guard is active",
                ),
                level: "info",
            },
        ]);
        expect(entries).toEqual([]);
        expect(
            registerRoleTransitionPolicy.mock.calls[0]?.[0]({
                from: { name: "quick-planner" },
                to: { name: "pi-agent" },
                sessionEntries: entries,
            }),
        ).toEqual({ allow: true });
    });

    it("releases the handoff gate through /session-plan-abandon", async () => {
        const { ctx, entries, commands, notifications } = setup();
        entries.push({
            type: "custom",
            customType: "pi-roles:active-role",
            data: { name: "quick-planner", appliedAt: 100 },
        });
        const command = commands.get("session-plan-abandon");
        if (!command) throw new Error("/session-plan-abandon was not registered");

        await command.handler("", ctx);

        expect(entries.slice(1)).toEqual([
            {
                type: "custom",
                customType: "session-plan-persistence-guard:abandoned",
                data: expect.objectContaining({
                    role: "quick-planner",
                    roleAppliedAt: 100,
                }),
            },
        ]);
        expect(notifications).toEqual([
            {
                message: expect.stringContaining("Released"),
                level: "info",
            },
        ]);
        expect(
            registerRoleTransitionPolicy.mock.calls[0]?.[0]({
                from: {
                    name: "quick-planner",
                    handoffGuard: "session-plan-persistence",
                },
                to: { name: "pi-agent" },
                sessionEntries: entries,
            }),
        ).toEqual({ allow: true });
    });

    it("requires an interactive confirmation and honours a declined abandon", async () => {
        const noUi = setup({ hasUI: false });
        const noUiCommand = noUi.commands.get("session-plan-abandon");
        if (!noUiCommand)
            throw new Error("/session-plan-abandon was not registered");

        await expect(noUiCommand.handler("", noUi.ctx)).rejects.toThrow(
            "requires an interactive confirmation",
        );

        const declined = setup({ confirm: false });
        const declinedCommand = declined.commands.get("session-plan-abandon");
        if (!declinedCommand)
            throw new Error("/session-plan-abandon was not registered");
        await declinedCommand.handler("", declined.ctx);

        expect(declined.entries).toEqual([]);
        expect(
            registerRoleTransitionPolicy.mock.calls[0]?.[0]({
                from: {
                    name: "quick-planner",
                    handoffGuard: "session-plan-persistence",
                },
                to: { name: "pi-agent" },
                sessionEntries: declined.entries,
            }),
        ).toEqual({
            allow: false,
            reason: expect.stringContaining("session_plan"),
        });
    });
});
