import { describe, expect, it } from "bun:test";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import {
    findInvokedSlashCommand,
    parseSlashCommandInvocation,
} from "./slash-command-source.ts";

function command(
    name: string,
    source: SlashCommandInfo["source"],
    path: string,
): SlashCommandInfo {
    return {
        name,
        source,
        sourceInfo: {
            path,
            source,
            scope: "user",
            origin: "top-level",
        },
    };
}

describe("parseSlashCommandInvocation", () => {
    it("parses a Pi slash command and preserves its arguments", () => {
        expect(
            parseSlashCommandInvocation(
                "/browser-debug inspect the checkout\nwith details",
            ),
        ).toEqual({
            name: "browser-debug",
            args: "inspect the checkout\nwith details",
        });
    });

    it("rejects plain text and leading whitespace", () => {
        expect(parseSlashCommandInvocation("browser-debug")).toBeNull();
        expect(parseSlashCommandInvocation(" /browser-debug")).toBeNull();
    });
});

describe("findInvokedSlashCommand", () => {
    const commands = [
        command("browser-debug", "prompt", "/global/browser-debug.md"),
        command("browser-debug", "prompt", "/project/browser-debug.md"),
        command("skill:diagnose", "skill", "/skills/diagnose/SKILL.md"),
        command("browser-debug", "extension", "/extensions/browser-debug.ts"),
    ];

    it("returns Pi's first registered matching prompt", () => {
        expect(
            findInvokedSlashCommand(
                commands,
                "/browser-debug inspect",
                ["prompt"],
            ),
        ).toBe(commands[0]);
    });

    it("can resolve a skill command", () => {
        expect(
            findInvokedSlashCommand(
                commands,
                "/skill:diagnose now",
                ["skill"],
            ),
        ).toBe(commands[2]);
    });

    it("respects source filters and unknown commands", () => {
        expect(
            findInvokedSlashCommand(commands, "/browser-debug", ["skill"]),
        ).toBeUndefined();
        expect(
            findInvokedSlashCommand(commands, "/missing", ["prompt"]),
        ).toBeUndefined();
    });
});
