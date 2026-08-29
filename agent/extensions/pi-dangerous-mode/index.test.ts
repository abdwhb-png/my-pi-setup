import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { default: extension } = await import("./index.ts");
const {
    isDangerousEnabled,
    setDangerousRuntimeState,
} = await import("./runner-patch.ts");
const {
    getRuntimeStatus,
    isAutopilotEnabled,
    recordAutopilotTurn,
    setUiBrokerCompatibility,
} = await import("./runtime-state.ts");
const { AUTOPILOT_COMPLETE_TOOL } = await import("./autopilot-loop.ts");

type Command = {
    handler: (args: string, ctx: CommandContext) => Promise<void>;
    getArgumentCompletions?: (
        prefix: string,
    ) => Array<{ value: string; label: string }> | null;
};

type CommandContext = {
    cwd: string;
    ui: {
        notify: (
            message: string,
            level: "info" | "warning" | "error",
        ) => void;
    };
    hasPendingMessages(): boolean;
};

type SessionStartEvent = { reason: "startup" | "reload" | "new" };
type SessionHandler = (
    event: SessionStartEvent,
    ctx: CommandContext,
) => void | Promise<void>;

interface SetupFixture {
    commands: Map<string, Command>;
    dangerousCommand: Command;
    autopilotCommand: Command;
    sessionStart(event: SessionStartEvent, ctx: CommandContext): Promise<void>;
    sessionShutdown(ctx: CommandContext): Promise<void>;
    sessionShutdownHandlerCount: number;
    flags: string[];
    activeTools(): string[];
    entries: Array<[string, unknown]>;
}

const temporaryDirectories: string[] = [];

afterEach(() => {
    setDangerousRuntimeState({
        enabled: false,
        config: { protectedTools: [], protectedExtensions: [] },
    });
    setUiBrokerCompatibility(true);
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function setup(
    dangerousFlag = false,
    autopilotFlag = false,
): SetupFixture {
    const commands = new Map<string, Command>();
    const sessionHandlers: SessionHandler[] = [];
    const sessionShutdownHandlers: SessionHandler[] = [];
    const flags: string[] = [];
    const entries: Array<[string, unknown]> = [];
    let activeTools = ["read", "bash"];

    extension({
        registerFlag(name: string) {
            flags.push(name);
        },
        registerCommand(name: string, definition: Command) {
            commands.set(name, definition);
        },
        registerTool(definition: { name: string }) {
            activeTools.push(definition.name);
        },
        getFlag(name: string) {
            if (name === "dangerously-skip-permissions") {
                return dangerousFlag;
            }
            if (name === "autopilot") return autopilotFlag;
            return undefined;
        },
        on(event: string, handler: SessionHandler) {
            if (event === "session_start") sessionHandlers.push(handler);
            if (event === "session_shutdown") {
                sessionShutdownHandlers.push(handler);
            }
        },
        getActiveTools() {
            return [...activeTools];
        },
        setActiveTools(names: string[]) {
            activeTools = [...names];
        },
        appendEntry(type: string, data: unknown) {
            entries.push([type, data]);
        },
        sendMessage() {},
        events: {
            on() {
                return () => {};
            },
            emit() {},
        },
    } as never);

    const dangerousCommand = commands.get("dangerous-mode");
    const autopilotCommand = commands.get("autopilot");
    if (!dangerousCommand || !autopilotCommand || sessionHandlers.length < 2) {
        throw new Error("pi-dangerous-mode did not register both modes");
    }
    return {
        commands,
        dangerousCommand,
        autopilotCommand,
        async sessionStart(event, ctx) {
            for (const handler of sessionHandlers) await handler(event, ctx);
        },
        async sessionShutdown(ctx) {
            for (const handler of sessionShutdownHandlers) {
                await handler({ reason: "startup" }, ctx);
            }
        },
        sessionShutdownHandlerCount: sessionShutdownHandlers.length,
        flags,
        activeTools: () => [...activeTools],
        entries,
    };
}

function createContext(): {
    ctx: CommandContext;
    notifications: Array<[string, string]>;
} {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dangerous-mode-index-"));
    temporaryDirectories.push(cwd);
    const notifications: Array<[string, string]> = [];
    return {
        ctx: {
            cwd,
            ui: {
                notify(message, level) {
                    notifications.push([message, level]);
                },
            },
            hasPendingMessages: () => false,
        },
        notifications,
    };
}

describe("pi-dangerous-mode extension", () => {
    it("registers Dangerous and Autopilot flags and commands", () => {
        const fixture = setup();

        expect(fixture.flags).toEqual([
            "dangerously-skip-permissions",
            "autopilot",
        ]);
        expect([...fixture.commands.keys()]).toEqual([
            "dangerous-mode",
            "autopilot",
        ]);
        expect(fixture.autopilotCommand.getArgumentCompletions?.("")).toEqual([
            { value: "on", label: "on" },
            { value: "off", label: "off" },
            { value: "status", label: "status" },
        ]);
    });

    it("registers UI broker cleanup for session shutdown", async () => {
        const fixture = setup();
        const { ctx } = createContext();

        expect(fixture.sessionShutdownHandlerCount).toBe(2);
        await fixture.sessionShutdown(ctx);
    });

    it("enables, disables, and reports dangerous mode without reload", async () => {
        const fixture = setup();
        const { ctx, notifications } = createContext();
        await fixture.sessionStart({ reason: "startup" }, ctx);

        await fixture.dangerousCommand.handler("on", ctx);
        expect(isDangerousEnabled()).toBe(true);

        await fixture.dangerousCommand.handler("off", ctx);
        expect(isDangerousEnabled()).toBe(false);

        await fixture.dangerousCommand.handler("status", ctx);
        expect(notifications.at(-1)?.[0]).toContain("OFF");
    });

    it("enables Autopilot as an independent Dangerous source", async () => {
        const fixture = setup();
        const { ctx } = createContext();
        await fixture.sessionStart({ reason: "startup" }, ctx);

        await fixture.autopilotCommand.handler("on", ctx);
        expect(isAutopilotEnabled()).toBe(true);
        expect(isDangerousEnabled()).toBe(true);
        expect(fixture.activeTools()).toContain(AUTOPILOT_COMPLETE_TOOL);

        await fixture.autopilotCommand.handler("off", ctx);
        expect(isAutopilotEnabled()).toBe(false);
        expect(isDangerousEnabled()).toBe(false);
        expect(fixture.activeTools()).not.toContain(AUTOPILOT_COMPLETE_TOOL);
    });

    it("keeps direct Dangerous active after Autopilot turns off", async () => {
        const fixture = setup();
        const { ctx } = createContext();
        await fixture.sessionStart({ reason: "startup" }, ctx);

        await fixture.dangerousCommand.handler("on", ctx);
        await fixture.autopilotCommand.handler("on", ctx);
        await fixture.autopilotCommand.handler("off", ctx);

        expect(isAutopilotEnabled()).toBe(false);
        expect(isDangerousEnabled()).toBe(true);
    });

    it("keeps both modes disabled and reports invalid configuration", async () => {
        const fixture = setup(true, true);
        const { ctx, notifications } = createContext();
        mkdirSync(join(ctx.cwd, ".pi"), { recursive: true });
        writeFileSync(
            join(ctx.cwd, ".pi", "pi-dangerous-mode.json"),
            JSON.stringify({ protectedExtensions: "brainstorm-forcer" }),
        );

        await fixture.sessionStart({ reason: "startup" }, ctx);
        expect(isDangerousEnabled()).toBe(false);
        expect(isAutopilotEnabled()).toBe(false);
        expect(notifications.at(-1)).toEqual([
            expect.stringContaining("Invalid configuration"),
            "error",
        ]);
    });

    it("rejects Autopilot enable while UI broker is incompatible", async () => {
        const fixture = setup();
        const { ctx, notifications } = createContext();
        await fixture.sessionStart({ reason: "startup" }, ctx);
        setUiBrokerCompatibility(false);

        await fixture.autopilotCommand.handler("on", ctx);

        expect(isAutopilotEnabled()).toBe(false);
        expect(notifications.at(-1)).toEqual([
            expect.stringContaining("cannot be enabled"),
            "error",
        ]);
    });

    it("reports protected surfaces and Autopilot counters", async () => {
        const fixture = setup(false, true);
        const { ctx, notifications } = createContext();
        mkdirSync(join(ctx.cwd, ".pi"), { recursive: true });
        writeFileSync(
            join(ctx.cwd, ".pi", "pi-dangerous-mode.json"),
            JSON.stringify({
                protectedTools: ["bash"],
                protectedExtensions: ["brainstorm-forcer"],
            }),
        );
        await fixture.sessionStart({ reason: "startup" }, ctx);
        recordAutopilotTurn({ hadError: true, now: Date.now() });

        await fixture.autopilotCommand.handler("status", ctx);

        const message = notifications.at(-1)?.[0] ?? "";
        expect(message).toContain("phase=running");
        expect(message).toContain("turns=1/8");
        expect(message).toContain("retries=1/2");
        expect(message).toContain("runner=compatible");
        expect(message).toContain("ui=compatible");
        expect(message).toContain("bash");
        expect(message).toContain("brainstorm-forcer");
    });

    it("rejects invalid command arguments with mode-specific usage", async () => {
        const fixture = setup();
        const { ctx, notifications } = createContext();
        await fixture.sessionStart({ reason: "startup" }, ctx);

        await fixture.dangerousCommand.handler("toggle", ctx);
        await fixture.autopilotCommand.handler("", ctx);
        await fixture.autopilotCommand.handler("unexpected", ctx);

        expect(notifications).toEqual([
            ["Usage: /dangerous-mode [on|off|status]", "warning"],
            ["Usage: /autopilot [on|off|status]", "warning"],
            ["Usage: /autopilot [on|off|status]", "warning"],
        ]);
    });

    it("activates both modes from CLI flags", async () => {
        const fixture = setup(true, true);
        const { ctx } = createContext();

        await fixture.sessionStart({ reason: "startup" }, ctx);

        expect(isAutopilotEnabled()).toBe(true);
        expect(isDangerousEnabled()).toBe(true);
        expect(fixture.activeTools()).toContain(AUTOPILOT_COMPLETE_TOOL);
    });

    it("preserves explicit Autopilot override on reload and resets on new session", async () => {
        const fixture = setup(false, true);
        const { ctx } = createContext();
        await fixture.sessionStart({ reason: "startup" }, ctx);
        await fixture.autopilotCommand.handler("off", ctx);

        await fixture.sessionStart({ reason: "reload" }, ctx);
        expect(isAutopilotEnabled()).toBe(false);

        await fixture.sessionStart({ reason: "new" }, ctx);
        expect(isAutopilotEnabled()).toBe(true);
        expect(getRuntimeStatus().autopilot.override).toBeUndefined();
    });
});
