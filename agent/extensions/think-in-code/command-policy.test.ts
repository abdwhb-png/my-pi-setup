import { afterEach, describe, expect, mock, test } from "bun:test";

import type {
    BashOperations,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
    claimSandboxRuntime,
    publishSandboxRuntime,
    releaseSandboxRuntime,
} from "../_shared/sandbox-runtime/index.ts";
import {
    DEFAULT_THINK_IN_CODE_CONFIG,
    type ThinkInCodeConfig,
} from "./config.ts";
import { createThinkCommandExecution } from "./command-policy.ts";

const ctx = {
    cwd: "/workspace",
    hasUI: false,
    ui: {},
    sessionManager: {
        getSessionId: () => "think-policy-session",
        getSessionFile: () => undefined,
    },
} as ExtensionContext;

const owners: symbol[] = [];

afterEach(() => {
    for (const owner of owners.splice(0)) releaseSandboxRuntime(owner);
});

function config(
    commandPolicy: ThinkInCodeConfig["commandPolicy"],
): ThinkInCodeConfig {
    return { ...DEFAULT_THINK_IN_CODE_CONFIG, commandPolicy };
}

describe("Think command policy", () => {
    test("uses only thinkInCode.commandPolicy", async () => {
        const execute = mock(async () => ({
            content: [{ type: "text" as const, text: "ok" }],
            details: undefined,
        }));
        const operations = { exec: mock(async () => ({ exitCode: 0 })) };
        const runtime = createThinkCommandExecution({
            getConfig: () =>
                config({
                    guardPolicy: { sudo: "allow" },
                    allowedShellCommands: [],
                    rewrites: [],
                }),
            createOperations: () => operations,
            createDefinition: () => ({ execute }),
            getTelemetryRecorder: () => null,
            shouldEnforceNativeTools: () => false,
        });

        await expect(
            runtime.service.execute({
                toolCallId: "think-allowed",
                operation: "think_execute",
                command: "sudo printf ok",
                ctx,
            }),
        ).resolves.toMatchObject({ content: [{ text: "ok" }] });
        expect(execute).toHaveBeenCalledTimes(1);
    });

    test("fails closed when sandbox is explicitly disabled", async () => {
        const owner = Symbol("think-disabled-runtime");
        owners.push(owner);
        claimSandboxRuntime(owner);
        publishSandboxRuntime(owner, { state: "disabled" });
        const runtime = createThinkCommandExecution({
            getConfig: () => DEFAULT_THINK_IN_CODE_CONFIG,
            getTelemetryRecorder: () => null,
            shouldEnforceNativeTools: () => false,
        });

        await expect(
            runtime.service.execute({
                toolCallId: "think-disabled",
                operation: "think_execute",
                command: "printf blocked",
                ctx,
            }),
        ).rejects.toThrow("Sandbox execution unavailable: disabled");
    });

    test("uses enabled runtime operations and fails closed for every unavailable state", async () => {
        const operations: BashOperations = {
            exec: async (command, _cwd, options) => {
                options.onData(Buffer.from(`sandbox:${command}`));
                return { exitCode: 0 };
            },
        };
        for (const state of [
            "enabled",
            "uninitialized",
            "error",
        ] as const) {
            const owner = Symbol(`think-${state}-runtime`);
            owners.push(owner);
            claimSandboxRuntime(owner);
            publishSandboxRuntime(
                owner,
                state === "enabled"
                    ? {
                          state,
                          createBashOperations: () => operations,
                          analysis: {
                              run: async () => ({
                                  output: "unused",
                                  stderr: "",
                                  runtime: "quickjs",
                                  durationMs: 0,
                                  truncated: false,
                              }),
                              shutdown: async () => undefined,
                          },
                      }
                    : { state },
            );
            const runtime = createThinkCommandExecution({
                getConfig: () => DEFAULT_THINK_IN_CODE_CONFIG,
                getTelemetryRecorder: () => null,
                shouldEnforceNativeTools: () => false,
            });

            for (const operation of [
                "think_execute",
                "think_batch_execute",
            ] as const) {
                const execution = runtime.service.execute({
                    toolCallId: `${operation}-${state}`,
                    operation,
                    command: "printf ok",
                    ctx,
                });
                if (state === "enabled") {
                    await expect(execution).resolves.toMatchObject({
                        content: [{ text: "sandbox:printf ok" }],
                    });
                } else {
                    await expect(execution).rejects.toThrow(
                        state === "error"
                            ? "Sandbox execution unavailable: initialization failed"
                            : "Sandbox execution unavailable: uninitialized",
                    );
                }
            }
        }
    });

    test("uses the operation-specific Think rewrite profile", async () => {
        let rewrite:
            | ((command: string) =>
                  | string
                  | { command: string; applied: unknown }
                  | null)
            | undefined;
        const createOperations = mock(
            (options: { rewriteCommand?: typeof rewrite }): BashOperations => {
                rewrite = options.rewriteCommand;
                return { exec: async () => ({ exitCode: 0 }) };
            },
        );
        const runtime = createThinkCommandExecution({
            getConfig: () =>
                config({
                    guardPolicy: {},
                    allowedShellCommands: [],
                    rewrites: [
                        {
                            match: "before",
                            rewrite: "after",
                            tools: ["think_execute"],
                        },
                    ],
                }),
            createOperations,
            createDefinition: () => ({
                execute: async () => ({
                    content: [{ type: "text" as const, text: "ok" }],
                    details: undefined,
                }),
            }),
            getTelemetryRecorder: () => null,
            shouldEnforceNativeTools: () => false,
        });

        await runtime.service.execute({
            toolCallId: "think-rewrite",
            operation: "think_execute",
            command: "printf before",
            ctx,
        });

        expect(rewrite?.("printf before")).toMatchObject({
            command: "printf after",
        });
    });
});
