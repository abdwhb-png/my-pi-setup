import { describe, expect, it, mock } from "bun:test";
import type {
    BashOperations,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createCommandExecutionService } from "./core.ts";
import { GuardSessionApprovals } from "./policy.ts";

function context(
    hasUI: boolean,
    select = mock(async () => "Yes for this session"),
): ExtensionContext {
    return {
        cwd: process.cwd(),
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

function service() {
    const operations: BashOperations = {
        exec: async (_command, _cwd, options) => {
            options.onData(Buffer.from("ok"));
            return { exitCode: 0 };
        },
    };
    return createCommandExecutionService<"safe_bash" | "think_execute">({
        approvals: new GuardSessionApprovals(),
        getAllowedShellCommands: () => [],
        getGuardPolicy: () => ({ sudo: "ask" as const }),
        getRewriteRules: () => [],
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
}

describe("command policy isolation", () => {
    it("never shares session approvals between consumers", async () => {
        const safeBash = service();
        const think = service();
        const approvingContext = context(true);

        await safeBash.execute({
            toolCallId: "safe-approved",
            operation: "safe_bash",
            command: "sudo printf safe",
            ctx: approvingContext,
        });
        await expect(
            think.execute({
                toolCallId: "think-must-ask",
                operation: "think_execute",
                command: "sudo printf safe",
                ctx: context(false),
            }),
        ).rejects.toThrow("Permission required for think_execute");

        await think.execute({
            toolCallId: "think-approved",
            operation: "think_execute",
            command: "sudo printf think",
            ctx: approvingContext,
        });
        await expect(
            safeBash.execute({
                toolCallId: "safe-must-ask",
                operation: "safe_bash",
                command: "sudo printf think",
                ctx: context(false),
            }),
        ).rejects.toThrow("Permission required for safe_bash");
    });
});
