import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
    ExtensionAPI,
    ExtensionContext,
    ToolDefinition,
} from "@earendil-works/pi-coding-agent";

mock.module("@plannotator/pi-extension/config.js", () => ({
    loadPlannotatorConfig: () => ({ config: { planFileDir: "pi-plans" } }),
    resolvePlanFileDir: () => "pi-plans",
}));

const { default: registerPlans } = await import("./index.ts");

type Command = {
    handler: (args: string, ctx: unknown) => Promise<void>;
};

function registerExtension(): {
    tools: Map<string, ToolDefinition>;
    commands: Map<string, Command>;
} {
    const tools = new Map<string, ToolDefinition>();
    const commands = new Map<string, Command>();
    registerPlans({
        registerTool(tool: ToolDefinition) {
            tools.set(tool.name, tool);
        },
        registerCommand(name: string, command: Command) {
            commands.set(name, command);
        },
    } as unknown as ExtensionAPI);
    return { tools, commands };
}

function context(
    cwd: string,
    sessionId: string,
    messages: string[],
): ExtensionContext {
    return {
        cwd,
        hasUI: true,
        ui: {
            notify(message: string) {
                messages.push(message);
            },
        },
        sessionManager: {
            getSessionId: () => sessionId,
            getSessionDir: () => cwd,
            getEntries: () => [],
        },
    } as unknown as ExtensionContext;
}

describe("/show-saved-plans", () => {
    const dirs: string[] = [];

    afterEach(() => {
        for (const dir of dirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("lists session_plan and write_plan entries from only the active session", async () => {
        const cwd = mkdtempSync(join(tmpdir(), "plans-command-"));
        dirs.push(cwd);
        const messages: string[] = [];
        const { tools, commands } = registerExtension();
        const active = context(cwd, "active-session", messages);
        const other = context(cwd, "other-session", messages);
        const sessionPlan = tools.get("session_plan");
        const writePlan = tools.get("write_plan");
        const command = commands.get("show-saved-plans");

        expect(sessionPlan).toBeDefined();
        expect(writePlan).toBeDefined();
        expect(command).toBeDefined();
        if (!sessionPlan || !writePlan || !command) return;

        await sessionPlan.execute(
            "save-session-plan",
            { action: "save", topic: "active topic", content: "# Active topic" },
            undefined,
            undefined,
            active,
        );
        await sessionPlan.execute(
            "save-session-plan-again",
            { action: "save", topic: "active topic", content: "# Active topic v2" },
            undefined,
            undefined,
            active,
        );
        await writePlan.execute(
            "write-pi-plan",
            { path: "active.md", content: "# Active" },
            undefined,
            undefined,
            active,
        );
        await sessionPlan.execute(
            "save-other-plan",
            { action: "save", topic: "other topic", content: "# Other topic" },
            undefined,
            undefined,
            other,
        );

        await command.handler("", active);

        const message = messages.at(-1) ?? "";
        expect(message).toContain("active topic");
        expect(message).toContain("v2");
        expect(message.match(/active topic/g)).toHaveLength(1);
        expect(message).toContain("pi-plans/active.md");
        expect(message).not.toContain("other topic");
    });
});
