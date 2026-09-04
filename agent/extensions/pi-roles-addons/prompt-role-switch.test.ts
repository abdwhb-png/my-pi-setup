import { afterEach, describe, expect, it, mock } from "bun:test";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const writeRoleSwitchRequestSpy = mock(() => {});
mock.module("../_shared/pi-roles", () => ({
    readFrontmatter(path: string) {
        const content = readFileSync(path, "utf8");
        const role = /^role:\s*(.+)$/m.exec(content)?.[1];
        return role ? { role } : {};
    },
    writeRoleSwitchRequest: writeRoleSwitchRequestSpy,
}));

const temporaryDirectories: string[] = [];

afterEach(() => {
    writeRoleSwitchRequestSpy.mockClear();
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function createPrompt(name: string, role?: string): SlashCommandInfo {
    const directory = mkdtempSync(join(tmpdir(), "prompt-role-switch-"));
    temporaryDirectories.push(directory);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${name}.md`);
    const roleLine = role ? `role: ${role}\n` : "";
    writeFileSync(path, `---\n${roleLine}---\n\nPrompt body`);

    return {
        name,
        source: "prompt",
        sourceInfo: {
            path,
            source: "prompt",
            scope: "user",
            origin: "top-level",
        },
    };
}

async function createHarness(commands: SlashCommandInfo[]) {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = {
        getCommands: () => commands,
        on: mock((event: string, handler: (...args: any[]) => unknown) => {
            handlers.set(event, handler);
        }),
    };
    const { default: promptRoleSwitch } = await import("./prompt-role-switch.ts");
    promptRoleSwitch(pi as never);

    return { pi, input: handlers.get("input")! };
}

describe("promptRoleSwitch", () => {
    it("uses Pi's registered prompt source path", async () => {
        const command = createPrompt("myplan", "ask");
        const { pi, input } = await createHarness([command]);

        await input(
            { type: "input", text: "/myplan details", source: "interactive" },
            { cwd: "/unrelated/workspace" },
        );

        expect(writeRoleSwitchRequestSpy).toHaveBeenCalledWith(pi, {
            targetRole: "ask",
            reason: "prompt:myplan",
        });
    });

    it("uses the first matching command when names collide", async () => {
        const first = createPrompt("myplan", "plan");
        const second = createPrompt("myplan", "ask");
        const { pi, input } = await createHarness([first, second]);

        await input(
            { type: "input", text: "/myplan", source: "interactive" },
            { cwd: "/unrelated/workspace" },
        );

        expect(writeRoleSwitchRequestSpy).toHaveBeenCalledWith(pi, {
            targetRole: "plan",
            reason: "prompt:myplan",
        });
    });

    it("ignores non-prompt commands and plain input", async () => {
        const extensionCommand: SlashCommandInfo = {
            ...createPrompt("myplan", "ask"),
            source: "extension",
            sourceInfo: {
                path: "/extensions/myplan.ts",
                source: "extension",
                scope: "user",
                origin: "top-level",
            },
        };
        const { input } = await createHarness([extensionCommand]);

        await input(
            { type: "input", text: "/myplan", source: "interactive" },
            { cwd: "/workspace" },
        );
        await input(
            { type: "input", text: "plain input", source: "interactive" },
            { cwd: "/workspace" },
        );

        expect(writeRoleSwitchRequestSpy).not.toHaveBeenCalled();
    });

    it("ignores prompts without role frontmatter", async () => {
        const command = createPrompt("norole");
        const { input } = await createHarness([command]);

        await input(
            { type: "input", text: "/norole", source: "interactive" },
            { cwd: "/workspace" },
        );

        expect(writeRoleSwitchRequestSpy).not.toHaveBeenCalled();
    });
});
