import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import dangerousModeExtension from "./index.ts";
import {
    setUiPromptGuardCompatibility,
    setUnattendedOverride,
} from "./runtime-state.ts";

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
    handlers: Map<
        string,
        Array<(event: unknown, ctx?: unknown) => unknown>
    >;
} {
    const commands = new Map<string, Command>();
    const flags: string[] = [];
    const handlers = new Map<
        string,
        Array<(event: unknown, ctx?: unknown) => unknown>
    >();
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
        on(event: string, handler: (event: unknown, ctx?: unknown) => unknown) {
            const registered = handlers.get(event) ?? [];
            registered.push(handler);
            handlers.set(event, registered);
        },
        events: { on: () => () => {}, emit() {} },
    } as unknown as ExtensionAPI);
    return { commands, flags, handlers };
}

describe("pi-dangerous-mode extension", () => {
    it("registers the public UI prompt guard", () => {
        const fixture = setup();

        expect(fixture.handlers.has("ui_prompt_before")).toBe(true);
    });

    it("refuses Unattended when the public prompt API is incompatible", async () => {
        const fixture = setup();
        const notifications: Array<[string, string]> = [];
        setUiPromptGuardCompatibility(false);

        await fixture.commands.get("unattended")!.handler("on", {
            cwd: "/test",
            hasUI: true,
            ui: {
                notify(message, level) {
                    notifications.push([message, level]);
                },
            },
        });

        expect(notifications).toContainEqual([
            "Unattended cannot be enabled: configuration, runner, or public UI prompt guard is incompatible.",
            "error",
        ]);
    });

    it("stops blocking idle custom UI when the active session shuts down", async () => {
        const fixture = setup();
        expect(setUnattendedOverride(true)).toBe(true);

        for (const handler of fixture.handlers.get("agent_start") ?? []) {
            await handler({ type: "agent_start" });
        }
        const guard = fixture.handlers.get("ui_prompt_before")?.[0];
        expect(guard).toBeDefined();
        if (!guard) return;

        await expect(
            Promise.resolve(
                guard({
                    type: "ui_prompt_before",
                    reason: "ui_prompt",
                    kind: "custom",
                }),
            ),
        ).resolves.toMatchObject({ block: true });

        for (const handler of fixture.handlers.get("session_shutdown") ?? []) {
            await handler(
                { type: "session_shutdown" },
                { hasUI: false, ui: { setWidget() {} } },
            );
        }

        await expect(
            Promise.resolve(
                guard({
                    type: "ui_prompt_before",
                    reason: "ui_prompt",
                    kind: "custom",
                }),
            ),
        ).resolves.toBeUndefined();
        setUnattendedOverride(false);
    });

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
