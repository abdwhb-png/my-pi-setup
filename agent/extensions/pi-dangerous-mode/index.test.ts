import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import dangerousModeExtension from "./index.ts";

type Command = {
    handler: (args: string, ctx: CommandContext) => Promise<void>;
    getArgumentCompletions?: (
        prefix: string,
    ) => Array<{ value: string; label: string }> | null;
};

type CommandContext = {
    cwd: string;
    hasUI?: boolean;
    ui: {
        notify(message: string, level: "info" | "warning" | "error"): void;
        confirm?: (title: string, message: string) => Promise<boolean>;
        theme?: unknown;
    };
};

function setup(): {
    commands: Map<string, Command>;
    flags: string[];
} {
    const commands = new Map<string, Command>();
    const flags: string[] = [];
    dangerousModeExtension({
        registerFlag(name: string) {
            flags.push(name);
        },
        registerCommand(name: string, definition: Command) {
            commands.set(name, definition);
        },
        registerTool() {},
        getFlag() {
            return false;
        },
        getActiveTools() {
            return [];
        },
        setActiveTools() {},
        appendEntry() {},
        sendMessage() {},
        on() {},
        events: { on: () => () => {}, emit() {} },
    } as unknown as ExtensionAPI);
    return { commands, flags };
}

describe("pi-dangerous-mode extension", () => {
    it("registers Dangerous flag and explicit Unattended command", () => {
        const fixture = setup();

        expect(fixture.flags).toEqual(["dangerously-skip-permissions"]);
        expect([...fixture.commands.keys()]).toEqual([
            "dangerous-mode",
            "unattended",
        ]);
        expect(
            fixture.commands.get("unattended")?.getArgumentCompletions?.(""),
        ).toEqual([
            { value: "on", label: "on" },
            { value: "off", label: "off" },
            { value: "status", label: "status" },
        ]);
    });

    it("prompts for confirmation when enabling dangerous-mode and cancels if rejected", async () => {
        const fixture = setup();
        const command = fixture.commands.get("dangerous-mode")!;
        const notifications: Array<[string, string]> = [];
        let confirmCalled = false;

        const ctx: CommandContext = {
            cwd: "/test",
            hasUI: true,
            ui: {
                notify(message, level) {
                    notifications.push([message, level]);
                },
                confirm: async () => {
                    confirmCalled = true;
                    return false;
                },
            },
        };

        await command.handler("on", ctx);

        expect(confirmCalled).toBe(true);
        expect(notifications).toContainEqual([
            "Dangerous mode activation canceled.",
            "info",
        ]);
    });

    it("enables dangerous-mode when confirmation is accepted", async () => {
        const fixture = setup();
        const command = fixture.commands.get("dangerous-mode")!;
        const notifications: Array<[string, string]> = [];
        let confirmCalled = false;

        const ctx: CommandContext = {
            cwd: "/test",
            hasUI: true,
            ui: {
                notify(message, level) {
                    notifications.push([message, level]);
                },
                confirm: async () => {
                    confirmCalled = true;
                    return true;
                },
            },
        };

        await command.handler("on", ctx);

        expect(confirmCalled).toBe(true);
        expect(notifications).toContainEqual([
            "Dangerous mode: ON.",
            "info",
        ]);

        // Disabling does not ask for confirmation
        confirmCalled = false;
        await command.handler("off", ctx);
        expect(confirmCalled).toBe(false);
        expect(notifications).toContainEqual([
            "Dangerous mode: OFF.",
            "info",
        ]);
    });

    it("notifies without prompting if dangerous-mode is already on", async () => {
        const fixture = setup();
        const command = fixture.commands.get("dangerous-mode")!;
        const notifications: Array<[string, string]> = [];
        let confirmCount = 0;

        const ctx: CommandContext = {
            cwd: "/test",
            hasUI: true,
            ui: {
                notify(message, level) {
                    notifications.push([message, level]);
                },
                confirm: async () => {
                    confirmCount++;
                    return true;
                },
            },
        };

        await command.handler("on", ctx);
        expect(confirmCount).toBe(1);

        // Turn on again while already active
        await command.handler("on", ctx);
        expect(confirmCount).toBe(1);
        expect(notifications).toContainEqual([
            "Dangerous mode is already ON.",
            "info",
        ]);

        await command.handler("off", ctx);
    });
});
