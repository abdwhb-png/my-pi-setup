import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
    BashOperations,
    BashToolDetails,
    ExtensionAPI,
    ExtensionContext,
    ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { registerSafeBash } from "../../bash-execution/safe-bash/index.ts";
import {
    DEFAULT_THINK_IN_CODE_CONFIG,
    type ThinkInCodeConfig,
} from "../../think-in-code/config.ts";
import { createThinkCommandExecution } from "../../think-in-code/command-policy.ts";
import { bashWithStdinSchema } from "./exec.ts";

type EventHandler = (...args: unknown[]) => unknown;
type SafeBashTool = ToolDefinition<
    typeof bashWithStdinSchema,
    BashToolDetails | undefined
>;

let fixture: string | undefined;

afterEach(async () => {
    if (fixture) await rm(fixture, { recursive: true, force: true });
    fixture = undefined;
});

function context(
    cwd: string,
    hasUI: boolean,
    select = mock(async () => "Yes for this session"),
): ExtensionContext {
    return {
        cwd,
        hasUI,
        ui: {
            select,
            input: mock(async () => undefined),
            notify: mock(() => undefined),
        },
        sessionManager: {
            getSessionId: () => "policy-isolation",
            getSessionFile: () => undefined,
        },
    } as unknown as ExtensionContext;
}

describe("Safe Bash and Think policy isolation", () => {
    it("never shares session approvals between the two consumers", async () => {
        fixture = await mkdtemp(join(tmpdir(), "command-policy-isolation-"));
        await mkdir(join(fixture, ".pi"));
        await writeFile(
            join(fixture, ".pi", "settings.json"),
            JSON.stringify({
                safeBash: {
                    mode: "coexist",
                    guardPolicy: { sudo: "ask" },
                    telemetry: {
                        enabled: false,
                        directory: join(fixture, "safe-telemetry"),
                    },
                },
            }),
        );

        const handlers = new Map<string, EventHandler[]>();
        const tools = new Map<string, SafeBashTool>();
        const operations: BashOperations = {
            exec: async (_command, _cwd, options) => {
                options.onData(Buffer.from("ok"));
                return { exitCode: 0 };
            },
        };
        const pi = {
            registerTool: (tool: SafeBashTool) => tools.set(tool.name, tool),
            registerCommand: () => undefined,
            on: (name: string, handler: EventHandler) => {
                handlers.set(name, [...(handlers.get(name) ?? []), handler]);
            },
            getActiveTools: () => ["bash", "safe_bash"],
            setActiveTools: () => undefined,
        } as unknown as ExtensionAPI;
        registerSafeBash(pi, { createOperations: () => operations });
        const approvingContext = context(fixture, true);
        await handlers.get("session_start")?.[0]?.({}, approvingContext);

        const thinkConfig: ThinkInCodeConfig = {
            ...DEFAULT_THINK_IN_CODE_CONFIG,
            commandPolicy: {
                guardPolicy: { sudo: "ask" },
                allowedShellCommands: [],
                rewrites: [],
            },
        };
        const think = createThinkCommandExecution({
            getConfig: () => thinkConfig,
            getTelemetryRecorder: () => null,
            shouldEnforceNativeTools: () => false,
            createOperations: () => operations,
            createDefinition: () => ({
                execute: async () => ({
                    content: [{ type: "text" as const, text: "ok" }],
                    details: undefined,
                }),
            }),
        });
        const safeBash = tools.get("safe_bash");
        if (!safeBash) throw new Error("safe_bash was not registered");

        await safeBash.execute(
            "safe-approved",
            { command: "sudo printf safe" },
            undefined,
            undefined,
            approvingContext,
        );
        await expect(
            think.service.execute({
                toolCallId: "think-must-ask",
                operation: "think_execute",
                command: "sudo printf safe",
                ctx: context(fixture, false),
            }),
        ).rejects.toThrow("Permission required for think_execute");

        await think.service.execute({
            toolCallId: "think-approved",
            operation: "think_execute",
            command: "sudo printf think",
            ctx: approvingContext,
        });
        await expect(
            safeBash.execute(
                "safe-must-ask",
                { command: "sudo printf think" },
                undefined,
                undefined,
                context(fixture, false),
            ),
        ).rejects.toThrow("Permission required for safe_bash");

        await handlers.get("session_shutdown")?.[0]?.({});
    });
});
