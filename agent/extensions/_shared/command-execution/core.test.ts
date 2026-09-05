import { describe, expect, it, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
    BashOperations,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
    createCommandExecutionService,
    type CommandExecutionRecord,
} from "./core";
import { SafeExecutionError } from "./failure.ts";
import { GuardSessionApprovals } from "./policy.ts";

type TestOperation =
    | "safe_bash"
    | "think_execute"
    | "think_batch_execute";
type TestRecord = CommandExecutionRecord<TestOperation>;

function tmpDir(): string {
    return mkdtempSync(join(tmpdir(), "think-bash-"));
}

const ctx = {
    cwd: "/workspace",
    hasUI: false,
    ui: {},
} as ExtensionContext;

function setup(options: {
    command?: string;
    guardPolicy?: Record<string, "ask" | "deny" | "allow">;
    enforceNativeTools?: boolean;
    rewriteRules?: Array<{ match: string; rewrite: string }>;
    executeError?: Error;
    signal?: AbortSignal;
} = {}) {
    const telemetry: TestRecord[] = [];
    let rewriteCommand:
        | ((command: string) =>
              | string
              | { command: string; applied: unknown }
              | null)
        | undefined;
    const operations = {
        exec: mock(async () => ({
            output: "ok",
            exitCode: 0,
            cancelled: false,
            truncated: false,
        })),
    } satisfies BashOperations;
    const createOperations = mock(
        (input: {
            stdin?: string;
            rewriteCommand?: typeof rewriteCommand;
        }) => {
            rewriteCommand = input.rewriteCommand;
            return operations;
        },
    );
    const execute = mock(async () => {
        if (options.executeError) throw options.executeError;
        return {
            content: [{ type: "text" as const, text: "ok" }],
            details: undefined,
        };
    });
    const service = createCommandExecutionService<TestOperation>({
        approvals: new GuardSessionApprovals(),
        getAllowedShellCommands: () => [],
        getGuardPolicy: () => options.guardPolicy ?? {},
        getRewriteRules: () => options.rewriteRules ?? [],
        getTelemetryRecorder: () => ({
            record: async (input: TestRecord) => {
                telemetry.push(input);
            },
            flush: async () => undefined,
        }),
        shouldEnforceNativeTools: () =>
            options.enforceNativeTools ?? false,
        createOperations,
        createDefinition: () => ({ execute }),
    });

    return {
        command: options.command ?? "printf ok",
        createOperations,
        execute,
        rewrite: (command: string) => rewriteCommand?.(command),
        service,
        telemetry,
    };
}

describe("safe execution core", () => {
    it("blocks dangerous commands before execution and records the origin", async () => {
        const harness = setup({ command: "sudo printf blocked" });

        await expect(
            harness.service.execute({
                toolCallId: "call-blocked",
                operation: "think_execute",
                command: harness.command,
                ctx,
            }),
        ).rejects.toThrow("group: sudo");

        expect(harness.createOperations).not.toHaveBeenCalled();
        expect(harness.telemetry).toEqual([
            expect.objectContaining({
                operation: "think_execute",
                toolCallId: "call-blocked",
                outcome: "blocked",
                match: expect.objectContaining({ groupId: "sudo" }),
            }),
        ]);
    });

    it("blocks native-tool redirects before execution", async () => {
        const harness = setup({
            command: "grep needle file.txt",
            enforceNativeTools: true,
        });

        await expect(
            harness.service.execute({
                toolCallId: "call-redirect",
                operation: "safe_bash",
                command: harness.command,
                ctx,
            }),
        ).rejects.toThrow("Use native 'grep' tool");

        expect(harness.createOperations).not.toHaveBeenCalled();
        expect(harness.telemetry[0]).toMatchObject({
            operation: "safe_bash",
            decision: "blocked",
            groupId: "native-tool-redirect",
            outcome: "blocked",
        });
    });

    it("applies safe_bash rewrites and records success", async () => {
        const harness = setup({
            command: "printf before",
            rewriteRules: [{ match: "before", rewrite: "after" }],
        });

        const result = await harness.service.execute({
            toolCallId: "call-ok",
            operation: "think_batch_execute",
            command: harness.command,
            stdin: "input",
            ctx,
        });

        expect(result.content).toEqual([{ type: "text", text: "ok" }]);
        expect(harness.rewrite(harness.command)).toMatchObject({
            command: "printf after",
        });
        expect(harness.createOperations).toHaveBeenCalledWith(
            expect.objectContaining({ stdin: "input" }),
        );
        expect(harness.telemetry[0]).toMatchObject({
            operation: "think_batch_execute",
            outcome: "succeeded",
        });
    });

    it("redacts abnormal safe-execution throws while still recording telemetry", async () => {
        const controller = new AbortController();
        controller.abort();
        const failure = setup({ executeError: new Error("spawn failed") });
        const aborted = setup({
            executeError: new Error("aborted"),
            signal: controller.signal,
        });

        await expect(
            failure.service.execute({
                toolCallId: "call-failed",
                operation: "safe_bash",
                command: failure.command,
                ctx,
            }),
        // Abnormal throws are redacted to the public-boundary reason; raw
        // payload remains in the SafeExecutionError.raw field and in
        // telemetry, never in the surfaced message.
        ).rejects.toThrow("Command failed (raw output redacted)");
        await expect(
            aborted.service.execute({
                toolCallId: "call-aborted",
                operation: "safe_bash",
                command: aborted.command,
                signal: controller.signal,
                ctx,
            }),
        ).rejects.toThrow("aborted");

        expect(failure.telemetry[0]).toMatchObject({
            outcome: "failed",
            error: "spawn failed",
        });
        expect(aborted.telemetry[0]).toMatchObject({
            outcome: "aborted",
            error: "aborted",
        });
    });

    it("integrates with the real createBashToolDefinition + shared safe-execution for a failing command", async () => {
        // Real bash from `@earendil-works/pi-coding-agent` (no fakes).
        // Drives a failing command whose stdout must be classified as
        // Drives a failing command whose stdout must be classified as
        // bash_exit, then asserts that the surfaced reason carries
        // only the trusted suffix and that the raw payload is held in
        // the non-enumerable `raw` accessor — never in `message`.
        const { createBashToolDefinition, createLocalBashOperations } =
            await import("@earendil-works/pi-coding-agent");
        const operations = createLocalBashOperations();
        const definition = createBashToolDefinition(tmpDir(), {
            operations,
            // Real bash would otherwise call ctx.sessionManager.* to
            // expose PI_* env vars; we are testing only the failure
            // path and want a minimal ctx.
            exposeSessionEnvironment: false,
        });
        const captured: TestRecord[] = [];
        const service = createCommandExecutionService<TestOperation>({
            approvals: new GuardSessionApprovals(),
            getAllowedShellCommands: () => [],
            getGuardPolicy: () => ({}),
            getRewriteRules: () => [],
            getTelemetryRecorder: () => ({
                record: async (input: TestRecord) => {
                    captured.push(input);
                },
                flush: async () => undefined,
            }),
            shouldEnforceNativeTools: () => false,
            createOperations: () => operations,
            createDefinition: () => definition,
        });
        const error = await service
            .execute({
                toolCallId: "real-bash",
                operation: "think_execute",
                command:
                    "echo REAL_BASH_SECRET_LINE_DO_NOT_LEAK_TO_LLM_AAA BBB CCC; exit 7",
                ctx: {
                    cwd: tmpDir(),
                    hasUI: false,
                    ui: {},
                } as ExtensionContext,
            })
            .catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(SafeExecutionError);
        const safeError = error as SafeExecutionError;
        expect(safeError.getKind()).toBe("bash_exit");
        expect(safeError.message).toBe("Command exited with code 7");
        expect(safeError.message).not.toContain("REAL_BASH_SECRET_LINE");
        // raw is held off the public message; non-enumerable also keeps
        // it out of JSON.stringify.
        expect(safeError.getRaw()).toContain("REAL_BASH_SECRET_LINE");
        const serialized = JSON.stringify(safeError);
        expect(serialized).not.toContain("REAL_BASH_SECRET_LINE");
        expect(serialized).not.toContain("bash_exit");
        // Telemetry may keep the raw payload under the existing
        // safe-bash redaction/storage contract.
        expect(captured[0]?.outcome).toBe("failed");
    });

    it("wraps every safe-execution throw in a SafeExecutionError with a classified reason", async () => {
        const guardHarness = setup({ command: "sudo printf blocked" });
        await expect(
            guardHarness.service.execute({
                toolCallId: "call-guard",
                operation: "think_execute",
                command: guardHarness.command,
                ctx,
            }),
        ).rejects.toBeInstanceOf(SafeExecutionError);

        const redirectHarness = setup({
            command: "grep needle file.txt",
            enforceNativeTools: true,
        });
        await expect(
            redirectHarness.service.execute({
                toolCallId: "call-redirect",
                operation: "safe_bash",
                command: redirectHarness.command,
                ctx,
            }),
        ).rejects.toBeInstanceOf(SafeExecutionError);

        const bashHarness = setup({
            executeError: new Error(
                "RAW_PAYLOAD_DO_NOT_LEAK\n\nCommand exited with code 3",
            ),
        });
        const bashError = await bashHarness.service
            .execute({
                toolCallId: "call-bash",
                operation: "safe_bash",
                command: bashHarness.command,
                ctx,
            })
            .catch((error: unknown) => error);
        expect(bashError).toBeInstanceOf(SafeExecutionError);
        expect((bashError as SafeExecutionError).kind).toBe("bash_exit");
        expect((bashError as SafeExecutionError).message).toBe(
            "Command exited with code 3",
        );
        // Raw payload is captured on `raw`, never on the message.
        expect((bashError as SafeExecutionError).message).not.toContain(
            "RAW_PAYLOAD_DO_NOT_LEAK",
        );
        expect((bashError as SafeExecutionError).raw).toContain(
            "RAW_PAYLOAD_DO_NOT_LEAK",
        );

        const abnormalHarness = setup({
            executeError: new Error("SECRET_ABNORMAL_DO_NOT_LEAK"),
        });
        const abnormalError = await abnormalHarness.service
            .execute({
                toolCallId: "call-abnormal",
                operation: "safe_bash",
                command: abnormalHarness.command,
                ctx,
            })
            .catch((error: unknown) => error);
        expect(abnormalError).toBeInstanceOf(SafeExecutionError);
        expect((abnormalError as SafeExecutionError).kind).toBe("abnormal");
        expect((abnormalError as SafeExecutionError).message).toBe(
            "Command failed (raw output redacted)",
        );
    });
});
