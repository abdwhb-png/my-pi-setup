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
    ui: { notify(message: string, level: "info" | "warning" | "error"): void };
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
});
