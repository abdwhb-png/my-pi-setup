import { afterEach, describe, expect, test } from "bun:test";

import { keyText, keyHint } from "@earendil-works/pi-coding-agent";
import type {
    BashOperations,
    ExtensionAPI,
    ExtensionContext,
    EntryRenderer,
} from "@earendil-works/pi-coding-agent";
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

import {
    claimSandboxRuntime,
    publishSandboxRuntime,
    releaseSandboxRuntime,
    type AnalysisSandboxPort,
} from "../_shared/sandbox-runtime/index.ts";
import bashExecutionExtension from "./index.ts";
import {
    emptyGrants,
    publishShellRuntime,
    releaseShellRuntime,
    type ShellProfile,
} from "../_shared/shell-runtime/index.ts";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

type Hook = (event: unknown, ctx: ExtensionContext) => unknown;

const owners: symbol[] = [];
function publishProfile(owner: symbol, profile: ShellProfile = "default") {
    const mode = profile === "host" ? "host" : "sandbox";
    publishShellRuntime(owner, () => ({ state: "ready", projectRoot: process.cwd(), mode, requestedMode: mode, profile, requestedProfile: profile,
        grants: emptyGrants(), requestedGrants: emptyGrants(), authorityPath: "/unused" }));
}

function executionContext(): ExtensionToolContext {
    return {
        cwd: process.cwd(),
        hasUI: false,
        ui: {},
        sessionManager: {
            getSessionId: () => "bash-execution-test",
            getSessionFile: () => undefined,
        },
    } as ExtensionToolContext;
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
    entryRenderers: Map<string, EntryRenderer>;
} {
    const tools = new Map<string, RegisteredTool>();
    const registrations: string[] = [];
    const hooks = new Map<string, Hook[]>();
    const entryRenderers = new Map<string, EntryRenderer>();
    const pi = {
        registerTool: (tool: RegisteredTool) => {
            registrations.push(tool.name);
            tools.set(tool.name, tool);
        },
        registerCommand: () => undefined,
        appendEntry: () => undefined,
        getSettings: () => ({}),
        registerEntryRenderer: (kind: string, renderer: EntryRenderer) => entryRenderers.set(kind, renderer),
        on: (event: string, hook: Hook) => {
            hooks.set(event, [...(hooks.get(event) ?? []), hook]);
        },
        getActiveTools: () => [...tools.keys()],
        setActiveTools: () => undefined,
        sendUserMessage: () => undefined,
    } as unknown as ExtensionAPI;
    bashExecutionExtension(pi);
    return { tools, registrations, hooks, entryRenderers };
}

afterEach(() => {
    for (const owner of owners.splice(0)) { releaseSandboxRuntime(owner); releaseShellRuntime(owner); }
});

describe("bash-execution ownership", () => {
    test("manual execution metadata renders the host route without changing process output", () => {
        const registered = register();
        const renderer = registered.entryRenderers.get("pi.execution.user-bash.v1");
        expect(renderer).toBeFunction();
        const theme = getThemeByName("dark");
        if (!renderer || !theme) throw new Error("Missing receipt renderer or built-in theme");
        const view = renderer({
            type: "custom", id: "receipt", parentId: null, timestamp: new Date(0).toISOString(),
            customType: "pi.execution.user-bash.v1",
            data: { command: "printf host", execution: {
                status: "unsandboxed", mode: "host", backend: "local", profile: "none", tmpNamespace: "host", phase: "process", outcome: "succeeded", exitCode: 0,
            } },
        }, { expanded: false, keyText, keyHint }, theme);
        expect(view?.render(80).join("\n")).toContain("Host");
        expect(view?.render(80).join("\n")).toContain("exit 0");
    });
    test("manual commands keep a literal s command and Pi's prepared shell prefix", async () => {
        publish({ state: "error" });
        const registered = register();
        const command = "s printf untouched";
        const userBash = registered.hooks.get("user_bash")![0];
        const response = userBash({ command, excludeFromContext: false }, executionContext()) as { operations: BashOperations };
        const chunks: string[] = [];
        const result = await response.operations.exec(`s() { printf '%s' "$*"; }; ${command}`, process.cwd(), {
            onData: chunk => chunks.push(chunk.toString()),
        });
        expect(result.exitCode).toBe(0);
        expect(chunks.join("")).toBe("printf untouched");
    });
    test.each(["enabled", "error", "uninitialized"] as const)(
        "manual commands use native host execution when Sandbox is %s",
        async (state) => {
            let sandboxRuns = 0;
            publish(state === "enabled" ? {
                state,
                createBashOperations: () => ({ exec: async () => {
                    sandboxRuns++;
                    return { exitCode: 93 };
                } }),
                analysis: { run: async () => { throw new Error("unused"); }, shutdown: async () => undefined },
            } : { state });
            const registered = register();
            const userBash = registered.hooks.get("user_bash")![0];
            for (const excludeFromContext of [false, true]) {
                const response = userBash({ command: "printf manual-native", excludeFromContext }, executionContext()) as { operations: BashOperations };
                const chunks: string[] = [];
                const result = await response.operations.exec("printf manual-native", process.cwd(), {
                    onData: chunk => chunks.push(chunk.toString()),
                });
                expect(result.exitCode).toBe(0);
                expect(chunks.join("")).toBe("manual-native");
            }
            expect(sandboxRuns).toBe(0);
        },
    );
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

    test("routes agent bash and safe_bash through Sandbox", async () => {
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
        expect(commands).toEqual([
            "printf bash",
            "printf safe_bash",
        ]);
    });

    test("fails closed before initialization and after an error", async () => {
        for (const state of ["uninitialized", "error"] as const) {
            publish({ state });
            const registered = register();
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
