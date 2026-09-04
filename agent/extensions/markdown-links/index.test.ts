import { afterEach, describe, expect, it, mock } from "bun:test";
import {
    createEventBus,
    type ExtensionAPI,
    type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestMarkdownLinkTransform } from "../_shared/markdown-links.ts";
import markdownLinksExtension, {
    expandAllowedRoots,
    loadMarkdownLinksConfig,
} from "./index.ts";

const temporaryDirectories: string[] = [];

function makeTempDir(): string {
    const directory = mkdtempSync(join(tmpdir(), "markdown-links-index-"));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function createHarness(commands: SlashCommandInfo[] = []) {
    const handlers = new Map<string, Array<(event: any, context: any) => any>>();
    const commandHandlers = new Map<string, (args: string, context: any) => any>();
    const events = createEventBus();
    const pi = {
        events,
        getCommands: () => commands,
        on: mock((name: string, handler: (event: any, context: any) => any) => {
            const registered = handlers.get(name) ?? [];
            registered.push(handler);
            handlers.set(name, registered);
        }),
        registerCommand: mock(
            (
                name: string,
                command: { handler: (args: string, context: any) => any },
            ) => {
                commandHandlers.set(name, command.handler);
            },
        ),
    };
    markdownLinksExtension(pi as unknown as ExtensionAPI);

    return {
        pi,
        async fire(name: string, event: any, context: any = {}) {
            let result: unknown;
            for (const handler of handlers.get(name) ?? []) {
                result = await handler(event, context);
            }
            return result;
        },
        status: commandHandlers.get("markdown-links:status")!,
    };
}

function promptCommand(name: string, path: string): SlashCommandInfo {
    return {
        name,
        source: "prompt",
        sourceInfo: {
            path,
            source: "prompt",
            scope: "project",
            origin: "top-level",
        },
    };
}

describe("Markdown links configuration", () => {
    it("loads only allowedRoots and lets trusted project settings override global settings", async () => {
        const root = makeTempDir();
        const agentDir = join(root, "agent");
        const cwd = join(root, "project");
        mkdirSync(agentDir);
        mkdirSync(join(cwd, ".pi"), { recursive: true });
        writeFileSync(
            join(agentDir, "settings.json"),
            JSON.stringify({
                markdownLinks: {
                    allowedRoots: ["$agentDir"],
                    scope: "context",
                    maxDepth: 1,
                },
            }),
        );
        writeFileSync(
            join(cwd, ".pi", "settings.json"),
            JSON.stringify({
                markdownLinks: { allowedRoots: ["$cwd", "$sourceDir"] },
            }),
        );

        await expect(
            loadMarkdownLinksConfig(cwd, agentDir, true),
        ).resolves.toEqual({ allowedRoots: ["$cwd", "$sourceDir"] });
        await expect(
            loadMarkdownLinksConfig(cwd, agentDir, false),
        ).resolves.toEqual({ allowedRoots: ["$agentDir"] });
    });

    it("expands source roots and keeps $contextDirs as a backward alias", () => {
        expect(
            expandAllowedRoots({
                patterns: [
                    "$cwd",
                    "$agentDir",
                    "$agentDir/..",
                    "$sourceDir",
                    "$contextDirs",
                    "~/docs",
                ],
                cwd: "/workspace/project",
                agentDir: "/home/user/.pi/agent",
                sourcePath: "/workspace/project/.pi/prompts/debug.md",
                homeDir: "/home/user",
            }),
        ).toEqual([
            "/workspace/project",
            "/home/user/.pi/agent",
            "/home/user/.pi",
            "/workspace/project/.pi/prompts",
            "/workspace/project/.pi/prompts",
            "/home/user/docs",
        ]);
    });
});

describe("markdownLinksExtension", () => {
    it("serves source-aware transformations through the shared event", async () => {
        const root = makeTempDir();
        const sourcePath = join(root, "docs", "guide.md");
        mkdirSync(join(root, "docs"));
        writeFileSync(join(root, "docs", "setup.json"), "{}");
        const harness = createHarness();
        await harness.fire(
            "session_start",
            { type: "session_start", reason: "startup" },
            { cwd: root, isProjectTrusted: () => true },
        );

        const transformed = requestMarkdownLinkTransform(harness.pi.events, {
            sourcePath,
            content: "Read [setup](setup.json)",
            cwd: root,
            sourceKind: "context",
        });

        expect(transformed).toBe(
            `Read [setup](${join(root, "docs", "setup.json")})`,
        );
        expect(transformed).not.toContain("{}");
    });

    it("rewrites complete Markdown read results and leaves partial reads unchanged", async () => {
        const root = makeTempDir();
        const sourcePath = join(root, "README.markdown");
        const targetPath = join(root, "guide.md");
        writeFileSync(targetPath, "guide");
        const harness = createHarness();
        await harness.fire(
            "session_start",
            { type: "session_start", reason: "startup" },
            { cwd: root, isProjectTrusted: () => true },
        );

        const complete = await harness.fire(
            "tool_result",
            {
                type: "tool_result",
                toolName: "read",
                toolCallId: "read-1",
                input: { path: sourcePath },
                content: [{ type: "text", text: "[guide](guide.md)" }],
                details: undefined,
                isError: false,
            },
            { cwd: root },
        );
        const partial = await harness.fire(
            "tool_result",
            {
                type: "tool_result",
                toolName: "read",
                toolCallId: "read-2",
                input: { path: sourcePath, offset: 2 },
                content: [{ type: "text", text: "[guide](guide.md)" }],
                details: undefined,
                isError: false,
            },
            { cwd: root },
        );

        expect(complete).toEqual({
            content: [{ type: "text", text: `[guide](${targetPath})` }],
        });
        expect(partial).toBeUndefined();
    });

    it("rewrites known SYSTEM, APPEND_SYSTEM, and context-file blocks in place", async () => {
        const root = makeTempDir();
        const projectPi = join(root, ".pi");
        mkdirSync(projectPi);
        writeFileSync(join(projectPi, "system-guide.md"), "SYSTEM TARGET");
        writeFileSync(join(projectPi, "append-guide.md"), "APPEND TARGET");
        writeFileSync(join(root, "context-guide.md"), "CONTEXT TARGET");
        const systemPath = join(projectPi, "SYSTEM.md");
        const appendPath = join(projectPi, "APPEND_SYSTEM.md");
        const contextPath = join(root, "AGENTS.md");
        const system = "System [guide](system-guide.md)";
        const append = "Append [guide](append-guide.md)";
        const context = "Context [guide](context-guide.md)";
        writeFileSync(systemPath, system);
        writeFileSync(appendPath, append);
        writeFileSync(contextPath, context);
        const harness = createHarness();
        const extensionContext = {
            cwd: root,
            isProjectTrusted: () => true,
        };
        await harness.fire(
            "session_start",
            { type: "session_start", reason: "startup" },
            extensionContext,
        );

        const result = (await harness.fire(
            "before_agent_start",
            {
                type: "before_agent_start",
                prompt: "User prompt",
                systemPrompt: [
                    system,
                    append,
                    `<project_instructions path="${contextPath}">\n${context}\n</project_instructions>`,
                ].join("\n\n"),
                systemPromptOptions: {
                    cwd: root,
                    customPrompt: system,
                    appendSystemPrompt: append,
                    contextFiles: [{ path: contextPath, content: context }],
                },
            },
            extensionContext,
        )) as { systemPrompt: string };

        expect(result.systemPrompt).toContain(
            `System [guide](${join(projectPi, "system-guide.md")})`,
        );
        expect(result.systemPrompt).toContain(
            `Append [guide](${join(projectPi, "append-guide.md")})`,
        );
        expect(result.systemPrompt).toContain(
            `Context [guide](${join(root, "context-guide.md")})`,
        );
        expect(result.systemPrompt).not.toContain("SYSTEM TARGET");
    });

    it("rewrites only static links from an invoked prompt template", async () => {
        const root = makeTempDir();
        const promptDir = join(root, ".pi", "prompts");
        mkdirSync(promptDir, { recursive: true });
        const sourcePath = join(promptDir, "browser-debug.md");
        const guidePath = join(promptDir, "guide.md");
        writeFileSync(guidePath, "guide");
        writeFileSync(join(promptDir, "argument.md"), "argument");
        writeFileSync(
            sourcePath,
            "---\ndescription: Debug\n---\n\nStatic [guide](guide.md)\n$ARGUMENTS",
        );
        const harness = createHarness([
            promptCommand("browser-debug", sourcePath),
        ]);
        const context = { cwd: root, isProjectTrusted: () => true };
        await harness.fire(
            "session_start",
            { type: "session_start", reason: "startup" },
            context,
        );
        await harness.fire(
            "input",
            {
                type: "input",
                text: "/browser-debug [argument](argument.md)",
                source: "interactive",
            },
            context,
        );
        await harness.fire(
            "before_agent_start",
            {
                type: "before_agent_start",
                prompt: "Static [guide](guide.md)\n[argument](argument.md)",
                systemPrompt: "System",
                systemPromptOptions: { cwd: root },
            },
            context,
        );

        const result = (await harness.fire(
            "message_end",
            {
                type: "message_end",
                message: {
                    role: "user",
                    content: "Static [guide](guide.md)\n[argument](argument.md)",
                    timestamp: 1,
                },
            },
            context,
        )) as { message: { content: string } };

        expect(result.message.content).toBe(
            `Static [guide](${guidePath})\n[argument](argument.md)`,
        );
    });

    it("rewrites only the body of loaded skill messages", async () => {
        const root = makeTempDir();
        const skillDir = join(root, "skill");
        mkdirSync(skillDir);
        const skillPath = join(skillDir, "SKILL.md");
        const guidePath = join(skillDir, "guide.md");
        writeFileSync(guidePath, "guide");
        const harness = createHarness();
        const context = { cwd: root, isProjectTrusted: () => true };
        await harness.fire(
            "session_start",
            { type: "session_start", reason: "startup" },
            context,
        );

        const result = (await harness.fire(
            "message_end",
            {
                type: "message_end",
                message: {
                    role: "user",
                    content: `<skill name="demo" location="${skillPath}">\nRead [guide](guide.md)\n</skill>\n[argument](argument.md)`,
                    timestamp: 1,
                },
            },
            context,
        )) as { message: { content: string } };

        expect(result.message.content).toBe(
            `<skill name="demo" location="${skillPath}">\nRead [guide](${guidePath})\n</skill>\n[argument](argument.md)`,
        );
    });

    it("reports bounded diagnostics without injecting target content", async () => {
        const root = makeTempDir();
        const sourcePath = join(root, "README.md");
        const harness = createHarness();
        const context = { cwd: root, isProjectTrusted: () => true };
        await harness.fire(
            "session_start",
            { type: "session_start", reason: "startup" },
            context,
        );
        requestMarkdownLinkTransform(harness.pi.events, {
            sourcePath,
            content: "[missing](missing.md)",
            cwd: root,
            sourceKind: "context",
        });
        let notice = "";

        await harness.status("", {
            ui: { notify: (message: string) => (notice = message) },
        });

        expect(notice).toContain("rewritten: 0");
        expect(notice).toContain("missing");
        expect(notice).not.toContain("No scan data yet");
    });
});
