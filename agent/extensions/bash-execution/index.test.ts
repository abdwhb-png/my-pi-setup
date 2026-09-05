import { afterEach, describe, expect, test } from "bun:test";

import type {
    BashOperations,
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
    claimSandboxRuntime,
    publishSandboxRuntime,
    releaseSandboxRuntime,
    type AnalysisSandboxPort,
} from "../_shared/sandbox-runtime/index.ts";
import bashExecutionExtension from "./index.ts";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];
type Hook = (event: unknown, ctx: ExtensionContext) => unknown;

const owners: symbol[] = [];

function executionContext(): ExtensionContext {
    return {
        cwd: process.cwd(),
        hasUI: false,
        ui: {},
        sessionManager: {
            getSessionId: () => "bash-execution-test",
            getSessionFile: () => undefined,
        },
    } as ExtensionContext;
}

function publish(
    state:
        | { state: "uninitialized" }
        | { state: "disabled" }
        | { state: "error" }
        | {
              state: "enabled";
              createBashOperations: () => BashOperations;
              analysis: AnalysisSandboxPort;
          },
): void {
    const owner = Symbol("bash-execution-test-runtime");
    owners.push(owner);
    claimSandboxRuntime(owner);
    publishSandboxRuntime(owner, state);
}

function register(): {
    tools: Map<string, RegisteredTool>;
    registrations: string[];
    hooks: Map<string, Hook[]>;
} {
    const tools = new Map<string, RegisteredTool>();
    const registrations: string[] = [];
    const hooks = new Map<string, Hook[]>();
    const pi = {
        registerTool: (tool: RegisteredTool) => {
            registrations.push(tool.name);
            tools.set(tool.name, tool);
        },
        registerCommand: () => undefined,
        on: (event: string, hook: Hook) => {
            hooks.set(event, [...(hooks.get(event) ?? []), hook]);
        },
        getActiveTools: () => [...tools.keys()],
        setActiveTools: () => undefined,
        sendUserMessage: () => undefined,
    } as unknown as ExtensionAPI;
    bashExecutionExtension(pi);
    return { tools, registrations, hooks };
}

afterEach(() => {
    for (const owner of owners.splice(0)) releaseSandboxRuntime(owner);
});

describe("bash-execution ownership", () => {
    test("registers bash and safe_bash plus the user_bash hook", () => {
        publish({ state: "disabled" });
        const registered = register();

        expect([...registered.tools.keys()].toSorted()).toEqual([
            "bash",
            "safe_bash",
        ]);
        expect(registered.registrations).toEqual(["bash", "safe_bash"]);
        expect(
            registered.registrations.filter((name) => name === "bash"),
        ).toHaveLength(1);
        expect(registered.hooks.get("user_bash")).toHaveLength(1);
    });

    test("uses local operations only when sandbox is explicitly disabled", async () => {
        publish({ state: "disabled" });
        const registered = register();
        const userBash = registered.hooks.get("user_bash")?.[0];
        const response = userBash?.({}, {} as ExtensionContext) as {
            operations: BashOperations;
        };
        const chunks: string[] = [];

        const result = await response.operations.exec(
            "printf local-fallback",
            process.cwd(),
            { onData: (chunk) => chunks.push(chunk.toString()) },
        );

        expect(result.exitCode).toBe(0);
        expect(chunks.join("")).toBe("local-fallback");

        const context = executionContext();
        for (const toolName of ["bash", "safe_bash"] as const) {
            const tool = registered.tools.get(toolName)!;
            const toolResult = await tool.execute(
                `${toolName}-disabled`,
                { command: `printf ${toolName}` },
                undefined,
                undefined,
                context,
            );
            expect(toolResult.content[0]).toMatchObject({
                type: "text",
                text: expect.stringContaining(toolName),
            });
        }
    });

    test("routes bash, safe_bash, and user_bash through one enabled runtime", async () => {
        const commands: string[] = [];
        const operations: BashOperations = {
            exec: async (command, _cwd, options) => {
                commands.push(command);
                options.onData(Buffer.from(`sandbox:${command}`));
                return { exitCode: 0 };
            },
        };
        publish({
            state: "enabled",
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
        });
        const registered = register();
        const context = executionContext();

        for (const toolName of ["bash", "safe_bash"] as const) {
            await registered.tools.get(toolName)!.execute(
                `${toolName}-enabled`,
                { command: `printf ${toolName}` },
                undefined,
                undefined,
                context,
            );
        }
        const userBash = registered.hooks.get("user_bash")?.[0];
        const response = userBash?.({}, context) as {
            operations: BashOperations;
        };
        await response.operations.exec("printf user_bash", process.cwd(), {
            onData: () => undefined,
        });

        expect(commands).toEqual([
            "printf bash",
            "printf safe_bash",
            "printf user_bash",
        ]);
    });

    test("fails closed before initialization and after an error", async () => {
        for (const state of ["uninitialized", "error"] as const) {
            publish({ state });
            const registered = register();
            const userBash = registered.hooks.get("user_bash")?.[0];
            const response = userBash?.({}, {} as ExtensionContext) as {
                operations: BashOperations;
            };
            await expect(
                response.operations.exec("true", process.cwd(), {
                    onData: () => undefined,
                }),
            ).rejects.toThrow(
                state === "error"
                    ? "Sandbox execution unavailable: initialization failed"
                    : "Sandbox execution unavailable: uninitialized",
            );
            for (const toolName of ["bash", "safe_bash"] as const) {
                await expect(
                    registered.tools.get(toolName)!.execute(
                        `${toolName}-${state}`,
                        { command: "true" },
                        undefined,
                        undefined,
                        executionContext(),
                    ),
                ).rejects.toThrow(
                    state === "error"
                        ? "Sandbox execution unavailable: initialization failed"
                        : "Sandbox execution unavailable: uninitialized",
                );
            }
        }
    });
});
