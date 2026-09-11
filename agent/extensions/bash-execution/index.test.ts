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
import { emptyGrants, type ShellProfile } from "../sandbox/capabilities/authority.ts";
import { publishShellRuntime, releaseShellRuntime } from "../sandbox/capabilities/runtime.ts";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];
type Hook = (event: unknown, ctx: ExtensionContext) => unknown;

const owners: symbol[] = [];
function publishProfile(owner: symbol, profile: ShellProfile = "default") {
    const mode = profile === "host" ? "host" : "sandbox";
    publishShellRuntime(owner, () => ({ state: "ready", projectRoot: process.cwd(), mode, requestedMode: mode, profile, requestedProfile: profile,
        grants: emptyGrants(), requestedGrants: emptyGrants(), authorityPath: "/unused" }));
}

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
    publishProfile(owner);
    publishSandboxRuntime(
        owner,
        state.state === "enabled"
            ? {
                  ...state,
                  createThinkBashOperations: state.createBashOperations,
                  analysis: { state: "ready", service: state.analysis },
              }
            : state,
    );
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
        appendEntry: () => undefined,
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
    for (const owner of owners.splice(0)) { releaseSandboxRuntime(owner); releaseShellRuntime(owner); }
});

describe("bash-execution ownership", () => {
    test("Bash and safe_bash wait for the new sandbox policy", async () => {
        const owner = Symbol("reconfiguration");
        owners.push(owner);
        claimSandboxRuntime(owner);
        publishProfile(owner);
        let runs = 0;
        const snapshot = {
            state: "enabled" as const,
            createBashOperations: () => ({ exec: async () => { runs++; return { exitCode: 0 }; } }),
            createThinkBashOperations: () => { throw new Error("wrong profile"); },
            analysis: { state: "ready" as const, service: { run: async () => { throw new Error("wrong tool"); }, shutdown: async () => undefined } },
        };
        publishSandboxRuntime(owner, snapshot);
        const registered = register();
        publishSandboxRuntime(owner, { state: "reconfiguring" });
        const pending = Promise.all([
            ...["bash", "safe_bash"].map((name) => registered.tools.get(name)!.execute(`${name}-waiting`, { command: "true" }, undefined, undefined, executionContext())),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(runs).toBe(0);
        publishSandboxRuntime(owner, { ...snapshot });
        await pending;
        expect(runs).toBe(2);
    });

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

    test("routes ! and !! to the explicitly granted host profile while Think's engine remains enabled", async () => {
        publish({ state: "enabled", createBashOperations: () => ({ exec: async () => ({ exitCode: 0 }) }), analysis: { run: async () => ({ output: "", stderr: "", runtime: "quickjs", durationMs: 0, truncated: false }), shutdown: async () => undefined } });
        publishProfile(owners.at(-1)!, "host");
        const registered = register();
        const userBash = registered.hooks.get("user_bash")?.[0];
        const response = userBash?.({ command: "printf local-fallback" }, {} as ExtensionContext) as {
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

        const hiddenResponse = userBash?.(
            { command: "printf hidden-host", excludeFromContext: true },
            {} as ExtensionContext,
        ) as { operations: BashOperations };
        const hiddenChunks: string[] = [];
        await hiddenResponse.operations.exec(
            "printf hidden-host",
            process.cwd(),
            { onData: (chunk) => hiddenChunks.push(chunk.toString()) },
        );
        expect(hiddenChunks.join("")).toBe("hidden-host");

    });

    test("routes bash and safe_bash through Sandbox, and !s and !!s explicitly through Sandbox", async () => {
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
        const response = userBash?.({ command: "s printf user_bash" }, context) as {
            operations: BashOperations;
        };
        await response.operations.exec("s printf user_bash", process.cwd(), {
            onData: () => undefined,
        });
        const hiddenResponse = userBash?.({ command: "s printf hidden", excludeFromContext: true }, context) as {
            operations: BashOperations;
        };
        await hiddenResponse.operations.exec("s printf hidden", process.cwd(), {
            onData: () => undefined,
        });

        expect(commands).toEqual([
            "printf bash",
            "printf safe_bash",
            "printf user_bash",
            "printf hidden",
        ]);
    });

    test("fails closed before initialization and after an error", async () => {
        for (const state of ["uninitialized", "error"] as const) {
            publish({ state });
            const registered = register();
            const userBash = registered.hooks.get("user_bash")?.[0];
            const response = userBash?.({ command: "s true" }, {} as ExtensionContext) as {
                operations: BashOperations;
            };
            await expect(
                response.operations.exec("s true", process.cwd(), {
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

    test("rejects !s without a command without falling back to the host", async () => {
        publish({ state: "disabled" });
        const registered = register();
        const userBash = registered.hooks.get("user_bash")?.[0];
        const response = userBash?.({ command: "s" }, executionContext()) as {
            operations: BashOperations;
        };

        await expect(
            response.operations.exec("s", process.cwd(), { onData() {} }),
        ).rejects.toThrow("Usage: !s <command>");
    });

    test("refreshes the shell authority before dispatching !s", async () => {
        let sandboxRuns = 0;
        publish({
            state: "enabled",
            createBashOperations: () => ({
                exec: async () => {
                    sandboxRuns += 1;
                    return { exitCode: 0 };
                },
            }),
            analysis: {
                run: async () => ({ output: "", stderr: "", runtime: "quickjs", durationMs: 0, truncated: false }),
                shutdown: async () => undefined,
            },
        });
        let prepared = 0;
        publishShellRuntime(
            owners.at(-1)!,
            () => ({
                state: "ready" as const,
                mode: "sandbox" as const,
                requestedMode: "sandbox" as const,
                profile: "default" as const,
                requestedProfile: "default" as const,
                projectRoot: process.cwd(),
                grants: emptyGrants(),
                requestedGrants: emptyGrants(),
                authorityPath: "/unused",
            }),
            async () => {
                prepared += 1;
                throw new Error("invalid active sandbox config");
            },
        );
        const registered = register();
        const userBash = registered.hooks.get("user_bash")?.[0];
        const response = userBash?.({ command: "s printf blocked" }, executionContext()) as {
            operations: BashOperations;
        };

        await expect(
            response.operations.exec("s printf blocked", process.cwd(), {
                onData: () => undefined,
            }),
        ).rejects.toThrow("invalid active sandbox config");
        expect(prepared).toBe(1);
        expect(sandboxRuns).toBe(0);
    });
});
