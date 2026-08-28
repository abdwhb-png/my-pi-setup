/// <reference types="bun" />

import { describe, expect, it, mock } from "bun:test";
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createBashOperations } from "../_shared/bash/exec.ts";
import {
    claimSandboxExecutionBroker,
    publishSandboxExecutionState,
} from "../_shared/bash/sandbox-execution-broker.ts";
import type { SafeBashRecordInput } from "./telemetry/recorder.ts";

const record = mock(async (_input: SafeBashRecordInput) => undefined);
const flush = mock(async () => undefined);
const createRecorder = mock(() => ({ record, flush }));
const purge = mock(async () => undefined);
let beginAudit: (() => void) | undefined;
let guardPolicy: Record<string, "ask" | "deny" | "allow"> = {};

mock.module("./config.ts", () => ({
    loadSafeBashConfig: () => ({
        mode: "coexist",
        allowedShellCommands: [],
        guardPolicy,
        telemetry: {
            enabled: true,
            directory: "/tmp/safe-bash-telemetry-test",
            retentionDays: 30,
            captureCommand: true,
            maxCommandLength: 10_000,
            auditDays: 30,
            auditLimit: 100,
        },
    }),
}));
mock.module("./telemetry/recorder.ts", () => ({
    createSafeBashTelemetryRecorder: createRecorder,
}));
mock.module("./telemetry/storage.ts", () => ({
    purgeExpiredTelemetry: purge,
    resolveTelemetryRoot: (directory: string) => directory,
}));
mock.module("./audit-command.ts", () => ({
    registerSafeBashAuditCommand: (
        _pi: ExtensionAPI,
        options: { beginAudit: () => void },
    ) => {
        beginAudit = options.beginAudit;
    },
}));

const { default: safeBashExtension } = await import("./index.ts");

type ToolDefinition = {
    execute: (
        id: string,
        params: { command: string; timeout?: number; stdin?: string },
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        ctx: ExtensionContext,
    ) => Promise<unknown>;
};

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;

function setup(options: {
    select?: () => Promise<string | undefined>;
} = {}) {
    const brokerOwner = Symbol("safe-bash-telemetry-test");
    claimSandboxExecutionBroker(brokerOwner);
    publishSandboxExecutionState(brokerOwner, {
        state: "disabled",
        createOperations: (options) => createBashOperations(options),
    });

    let tool: ToolDefinition | undefined;
    const handlers = new Map<string, Handler>();
    const commands = new Map<string, CommandHandler>();
    const pi = {
        registerTool: (definition: ToolDefinition) => {
            tool = definition;
        },
        registerCommand: (
            name: string,
            definition: { handler: CommandHandler },
        ) => {
            commands.set(name, definition.handler);
        },
        on: (event: string, handler: Handler) => {
            handlers.set(event, handler);
        },
        getActiveTools: () => ["bash", "safe_bash"],
        setActiveTools: () => undefined,
    } as unknown as ExtensionAPI;
    safeBashExtension(pi);
    if (!tool) throw new Error("safe_bash was not registered");
    const ctx = {
        cwd: "/tmp",
        hasUI: options.select !== undefined,
        sessionManager: {
            getSessionId: () => "session-1",
            getSessionFile: () => undefined,
        },
        ui: {
            notify: () => undefined,
            select: options.select,
        },
    } as unknown as ExtensionContext;
    return { tool, handlers, commands, ctx };
}

describe("safe_bash telemetry integration", () => {
    it("blocks every tool during recommendation-only audit analysis", async () => {
        const { handlers, ctx } = setup();
        beginAudit?.();

        await expect(
            handlers.get("tool_call")?.({ toolName: "safe_bash" }, ctx),
        ).resolves.toMatchObject({
            block: true,
            reason: expect.stringContaining("recommendation-only"),
        });

        await handlers.get("agent_end")?.({}, ctx);
        await expect(
            handlers.get("tool_call")?.({ toolName: "safe_bash" }, ctx),
        ).resolves.toBeUndefined();
    });

    it("clears exact-command approvals when config reloads", async () => {
        guardPolicy = { "file-delete-api": "ask" };
        const select = mock(async () => "Yes for this session");
        const { tool, handlers, commands, ctx } = setup({ select });
        await handlers.get("session_start")?.({}, ctx);
        const command =
            `python3 -c "import os; False and os.remove('/tmp/never'); print('ok')"`;

        await tool.execute(
            "call-before-reload",
            { command },
            undefined,
            undefined,
            ctx,
        );
        await commands.get("safe-bash")?.("reload", ctx);
        await tool.execute(
            "call-after-reload",
            { command },
            undefined,
            undefined,
            ctx,
        );

        expect(select).toHaveBeenCalledTimes(2);
        guardPolicy = {};
    });

    it("records an allowed danger-group decision before execution", async () => {
        record.mockClear();
        guardPolicy = { "file-delete-api": "allow" };
        const { tool, handlers, ctx } = setup();
        await handlers.get("session_start")?.({}, ctx);

        await tool.execute(
            "call-allowed",
            {
                command:
                    `python3 -c "import os; False and os.remove('/tmp/never'); print('ok')"`,
            },
            undefined,
            undefined,
            ctx,
        );

        expect(record).toHaveBeenCalledTimes(1);
        expect(record.mock.calls[0]?.[0]).toMatchObject({
            toolCallId: "call-allowed",
            decision: "allowed",
            outcome: "succeeded",
            match: { groupId: "file-delete-api" },
        });
        guardPolicy = {};
    });

    it("records blocked and successful attempts without changing execution", async () => {
        record.mockClear();
        guardPolicy = {};
        createRecorder.mockClear();
        const { tool, handlers, ctx } = setup();
        await handlers.get("session_start")?.({}, ctx);

        await expect(
            tool.execute(
                "call-blocked",
                {
                    command:
                        `python3 -c "import shutil; shutil.rmtree('dist')"`,
                },
                undefined,
                undefined,
                ctx,
            ),
        ).rejects.toThrow("file-delete-api");
        await tool.execute(
            "call-ok",
            { command: "printf ok" },
            undefined,
            undefined,
            ctx,
        );

        expect(createRecorder).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledTimes(2);
        expect(record.mock.calls[0]?.[0]).toMatchObject({
            toolCallId: "call-blocked",
            outcome: "blocked",
            match: { groupId: "file-delete-api" },
        });
        expect(record.mock.calls[1]?.[0]).toMatchObject({
            toolCallId: "call-ok",
            outcome: "succeeded",
            match: null,
        });
    });
});
