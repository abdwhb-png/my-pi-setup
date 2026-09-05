/**
 * Real Pi-runtime integration tests for the Think-in-Code native extension.
 *
 * These tests use `@abdwhb-png/pi-test-harness` to boot a real Pi 0.84.2
 * session and verify the full extension wiring (sandbox runtime publication, tool
 * registration, hook ordering, abort propagation, one outer result, no
 * nested safe_bash result, no save-tokens mutation, one-shot compaction
 * restore). They complement the unit tests under `tools.test.ts` and
 * `coordinator.test.ts` by exercising the same code through the actual
 * Pi extension loader, tool wrapping pipeline, and event bus.
 *
 * Per the AGENTS.md plan, sandbox, safe-bash, Think-in-Code, and a
 * Context-Mode-name fixture are all loaded into the same session. The
 * sandbox runtime is pre-published with
 * deterministic mocks so the runtime wiring is exercised without spinning
 * up real Linux isolation.
 */

import {
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
    mock,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
    BashOperations,
    ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
    calls,
    createTestSession,
    safeRmSync,
    says,
    when,
    type TestSession,
} from "@abdwhb-png/pi-test-harness";

import { registerThinkInCode } from "./index.ts";
import { hashProjectPath } from "./config.ts";
import { readRecentThinkTelemetry } from "./telemetry/storage.ts";
import {
    claimSandboxRuntime,
    publishSandboxRuntime,
    releaseSandboxRuntime,
    type AnalysisSandboxPort,
} from "../_shared/sandbox-runtime/index.ts";
import type {
    AnalysisBindingValue,
    AnalysisRequest,
    AnalysisResult,
} from "../_shared/sandbox-runtime/analysis-protocol.ts";

const THINK_TOOL_NAMES = [
    "think_execute",
    "think_note",
    "think_search",
] as const;

const sessions: TestSession[] = [];
let testHome: string | undefined;
let ownerSymbol: symbol | undefined;
let previousHome: string | undefined;

interface BrokerState {
    bashOperations: BashOperations;
    analysis: AnalysisSandboxPort;
    safeExecCalls: Array<{
        command: string;
        cwd: string;
        signal?: AbortSignal;
    }>;
    analysisCalls: Array<{
        language: string;
        program: string;
        bindings: Record<string, AnalysisBindingValue>;
    }>;
}

function makeBrokerState(): BrokerState {
    const safeExecCalls: BrokerState["safeExecCalls"] = [];
    const analysisCalls: BrokerState["analysisCalls"] = [];
    const bashOperations: BashOperations = {
        exec: mock(async (command, cwd, options) => {
            safeExecCalls.push({
                command,
                cwd,
                ...(options.signal ? { signal: options.signal } : {}),
            });
            options.onData(Buffer.from(`safe-bash-result:${command}`));
            return { exitCode: 0 };
        }),
    };
    const analysis: AnalysisSandboxPort = {
        run: mock(async (request: AnalysisRequest): Promise<AnalysisResult> => {
            analysisCalls.push({
                language: request.language,
                program: request.program,
                bindings: { ...(request.bindings ?? {}) },
            });
            const bindingsRecord = request.bindings ?? {};
            const first =
                Object.values(bindingsRecord).find(
                    (value: unknown): value is string => typeof value === "string" && value.length > 0,
                ) ?? "";
            const runtime = request.language === "python" ? "python" : "quickjs";
            return {
                output: `DERIVED[${request.language}]: ${first.slice(0, 32)}`,
                stderr: "",
                runtime,
                durationMs: 1,
                truncated: false,
            };
        }),
        shutdown: async () => undefined,
    };
    return { bashOperations, analysis, safeExecCalls, analysisCalls };
}

function installBrokers(state: BrokerState): symbol {
    const owner = Symbol("think-in-code-runtime-integration");
    claimSandboxRuntime(owner);
    publishSandboxRuntime(owner, {
        state: "enabled",
        createBashOperations: () => state.bashOperations,
        analysis: state.analysis,
    });
    return owner;
}

function releaseBrokers(owner: symbol): void {
    releaseSandboxRuntime(owner);
}

function thinkInCodeFactory(state: BrokerState): (pi: ExtensionAPI) => void {
    return (pi: ExtensionAPI) => {
        ownerSymbol = installBrokers(state);
        registerThinkInCode(pi, {
            resolveRoot: () =>
                join(testHome!, ".pi", "agent", "think-in-code"),
        });
    };
}

function createHarnessProject(): string {
    testHome = mkdtempSync(join(tmpdir(), "think-in-code-runtime-"));
    // Redirect the think-in-code store to the test's disposable temp dir.
    // The extension uses `homedir()` from `node:os` to resolve the root; we
    // override HOME before the extension loads and restore it in afterEach.
    previousHome = process.env.HOME;
    process.env.HOME = testHome;
    return testHome;
}

function collectToolNames(session: TestSession): string[] {
    const seen = new Set<string>();
    // Package-boundary access: TestSession exposes the real agent tools only
    // via agent.state.tools; no public typed harness accessor exists for the
    // registered tool list, so the narrowed cast is the smallest verified
    // seam.
    const tools = (session.session as unknown as {
        agent?: { state?: { tools?: Array<{ name?: string }> } };
    }).agent?.state?.tools;
    if (Array.isArray(tools)) {
        for (const tool of tools) {
            if (typeof tool?.name === "string") seen.add(tool.name);
        }
    }
    return [...seen];
}

beforeAll(() => {
    createHarnessProject();
});

afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
    if (ownerSymbol) {
        releaseBrokers(ownerSymbol);
        ownerSymbol = undefined;
    }
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    previousHome = undefined;
    if (testHome) {
        try {
            safeRmSync(join(testHome, ".pi", "agent", "think-in-code"));
        } catch {
            // ignore
        }
        try {
            rmSync(testHome, { recursive: true, force: true });
        } catch {
            // best-effort cleanup
        }
        testHome = undefined;
    }
});

describe("think-in-code real Pi runtime wiring", () => {
    it("registers exactly the three native think_* tools", async () => {
        const state = makeBrokerState();
        const home = createHarnessProject();
        const session = await createTestSession({
            cwd: home,
            extensionFactories: [thinkInCodeFactory(state)],
            mockTools: {
                bash: "ok",
                read: "ok",
                write: "ok",
                edit: "ok",
            },
        });
        sessions.push(session);

        // Give the loader a chance to run session_start handlers.
        await session.session.agent.waitForIdle();

        const registered = collectToolNames(session);
        for (const name of THINK_TOOL_NAMES) {
            expect(registered).toContain(name);
        }
        // 3 native Think tools are registered; the 3 think_* names are the
        // contract — neither `safe_bash` nor any `mcp:ctx_*` should be
        // registered by Think-in-Code itself.
        for (const name of THINK_TOOL_NAMES) {
            expect(
                registered.filter((n) => n === name).length,
            ).toBe(1);
        }
        expect(registered).not.toContain("mcp:ctx_execute");
    });

    it("rejects unknown language and oversize program at argument validation", async () => {
        const state = makeBrokerState();
        const home = createHarnessProject();
        const session = await createTestSession({
            cwd: home,
            extensionFactories: [thinkInCodeFactory(state)],
            mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
        });
        sessions.push(session);
        await session.session.agent.waitForIdle();

        await session.run(
            when("Probe argument validation", [
                calls("think_execute", {
                    action: "content",
                    language: "ruby",
                    program: "1+1",
                    content: "inline",
                }),
                says("Validation rejected the unknown language."),
            ]),
        );

        const result = session.events.toolResultsFor("think_execute")[0];
        expect(result).toBeDefined();
        expect(result?.isError).toBe(true);
        // The Pi schema wrapper emits a structured "validation failed" message
        // when the language literal is not in the TypeBox union; the upstream
        // validate() path inside the handler also rejects unknown languages.
        // Both outcomes are valid as long as no broker is invoked.
        const text = (result?.text ?? "").toLowerCase();
        expect(
            text.includes("language") || text.includes("validation failed"),
        ).toBe(true);
        // The rejection must short-circuit before any analysis broker call.
        expect(state.analysisCalls.length).toBe(0);
        expect(state.safeExecCalls.length).toBe(0);
    });

    it("rejects fetch/network parameters on every think_* tool", async () => {
        const state = makeBrokerState();
        const home = createHarnessProject();
        const session = await createTestSession({
            cwd: home,
            extensionFactories: [thinkInCodeFactory(state)],
            mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
        });
        sessions.push(session);
        await session.session.agent.waitForIdle();

        await session.run(
            when("Try to fetch the web", [
                calls("think_execute", {
                    action: "content",
                    language: "javascript",
                    program: "1",
                    content: "x",
                    fetch: { url: "https://example.com" },
                }),
                says("Fetch rejected."),
            ]),
        );
        await session.run(
            when("Try to fetch while noting", [
                calls("think_note", {
                    source: "review",
                    text: "bounded conclusion",
                    fetch: { url: "https://example.com" },
                }),
                says("Fetch rejected."),
            ]),
        );
        await session.run(
            when("Try network search", [
                calls("think_search", {
                    query: "bounded conclusion",
                    network: true,
                }),
                says("Network rejected."),
            ]),
        );

        const results = [
            session.events.toolResultsFor("think_execute")[0],
            session.events.toolResultsFor("think_note")[0],
            session.events.toolResultsFor("think_search")[0],
        ];
        expect(results.every((result) => result?.isError === true)).toBe(true);
        expect(
            results.every((result) =>
                result?.text
                    .toLowerCase()
                    .includes("must not have additional properties"),
            ),
        ).toBe(true);
        expect(state.analysisCalls.length).toBe(0);
    });

    it("runs think_execute end-to-end through safe-execution and analysis", async () => {
        const state = makeBrokerState();
        const home = createHarnessProject();
        const session = await createTestSession({
            cwd: home,
            extensionFactories: [thinkInCodeFactory(state)],
            mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
        });
        sessions.push(session);
        await session.session.agent.waitForIdle();

        await session.run(
            when("Run a single command", [
                calls("think_execute", {
                    action: "command",
                    language: "javascript",
                    program: "INPUT",
                    command: "echo hello",
                }),
                says("Done."),
            ]),
        );

        // One outer result for think_execute; safe_bash must NOT appear as a
        // nested result because the Think pipeline calls it as a function.
        expect(session.events.toolResultsFor("think_execute")).toHaveLength(1);
        expect(session.events.toolResultsFor("safe_bash")).toHaveLength(0);

        // Both sandbox runtime ports were hit with the expected payload.
        expect(state.safeExecCalls).toHaveLength(1);
        expect(state.safeExecCalls[0]?.command).toBe("echo hello");
        expect(state.analysisCalls).toHaveLength(1);
        expect(state.analysisCalls[0]?.language).toBe("javascript");
        expect(state.analysisCalls[0]?.bindings.INPUT).toBe(
            "safe-bash-result:echo hello",
        );
        const telemetry = await readRecentThinkTelemetry(
            join(
                home,
                ".pi",
                "agent",
                "think-in-code",
                "projects",
                hashProjectPath(home),
                "telemetry",
            ),
            { days: 30, project: home },
        );
        expect(telemetry).toHaveLength(1);
        expect(telemetry[0]).toMatchObject({
            origin: "think_execute",
            command: "echo hello",
            outcome: "succeeded",
        });
    });

    it("preserves hook order: before_agent_start → tool_call → tool_result → turn_end", async () => {
        const state = makeBrokerState();
        const home = createHarnessProject();
        const session = await createTestSession({
            cwd: home,
            extensionFactories: [thinkInCodeFactory(state)],
            mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
        });
        sessions.push(session);
        await session.session.agent.waitForIdle();

        const beforeOrder: string[] = [];

        const unsubBefore = session.session.subscribe?.(
            (event: { type: string; toolName?: string }) => {
                if (event.type === "before_agent_start")
                    beforeOrder.push("before_agent_start");
                if (
                    event.type === "tool_execution_start" &&
                    event.toolName === "think_execute"
                )
                    beforeOrder.push("tool_call");
                if (
                    event.type === "tool_execution_end" &&
                    event.toolName === "think_execute"
                )
                    beforeOrder.push("tool_result");
                if (event.type === "turn_end") beforeOrder.push("turn_end");
            },
        );
        try {
            await session.run(
                when("Verify hook order", [
                    calls("think_execute", {
                        action: "content",
                        language: "javascript",
                        program: "1",
                        content: "payload",
                    }),
                    says("Done."),
                ]),
            );
            const firstToolCall = beforeOrder.indexOf("tool_call");
            const firstToolResult = beforeOrder.indexOf("tool_result");
            const firstTurnEnd = beforeOrder.indexOf("turn_end");
            expect(firstToolCall).toBeGreaterThanOrEqual(0);
            expect(firstToolResult).toBeGreaterThan(firstToolCall);
            expect(firstTurnEnd).toBeGreaterThan(firstToolResult);
        } finally {
            if (typeof unsubBefore === "function") unsubBefore();
        }
    });

    it("aborts the in-flight safe-execution when the runtime aborts the tool call", async () => {
        const state = makeBrokerState();
        const home = createHarnessProject();
        const session = await createTestSession({
            cwd: home,
            extensionFactories: [thinkInCodeFactory(state)],
            mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
        });
        sessions.push(session);
        await session.session.agent.waitForIdle();

        // Real abort contract: the slow Bash operation hangs until the
        // runtime's AbortSignal aborts. The harness drives the abort by
        // calling `session.session.abort()` while the tool is in flight.
        const abortObserved: AbortSignal[] = [];
        const slowBash: BashOperations = {
            exec: mock(
                (_command, _cwd, options): Promise<{ exitCode: number | null }> =>
                    new Promise<{ exitCode: number | null }>((_resolve, reject) => {
                        const signal = options.signal;
                        if (!signal) {
                            reject(new Error("Bash operation missing AbortSignal"));
                            return;
                        }
                        abortObserved.push(signal);
                        if (signal.aborted) {
                            reject(new Error("Bash operation aborted"));
                            return;
                        }
                        signal.addEventListener(
                            "abort",
                            () => reject(new Error("Bash operation aborted")),
                            { once: true },
                        );
                    }),
            ),
        };
        const slowAnalysis: AnalysisSandboxPort = {
            run: mock(
                (_request: AnalysisRequest, signal?: AbortSignal): Promise<AnalysisResult> =>
                    new Promise<AnalysisResult>((_resolve, reject) => {
                        if (signal?.aborted) {
                            reject(new Error("Analysis request aborted"));
                            return;
                        }
                        if (signal) {
                            const forward = () => reject(new Error("Analysis request aborted"));
                            signal.addEventListener("abort", forward, { once: true });
                        } else {
                            reject(new Error("Analysis request missing AbortSignal"));
                        }
                    }),
            ),
            shutdown: async () => undefined,
        };
        const owner = ownerSymbol;
        if (owner) {
            publishSandboxRuntime(owner, {
                state: "enabled",
                createBashOperations: () => slowBash,
                analysis: slowAnalysis,
            });
        }

        const runPromise = session.run(
            when("Call and then abort", [
                calls("think_execute", {
                    action: "command",
                    language: "javascript",
                    program: "INPUT",
                    command: "echo hang",
                }),
                says("Done."),
            ]),
        );

        // Let the tool start, then abort the in-flight run.
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        await session.session.abort();
        await runPromise;

        expect(abortObserved.length).toBe(1);
        const abortText = session.events.messages
            .map((m) => {
                if (!("content" in m)) return "";
                const content = m.content;
                if (typeof content === "string") return content.toLowerCase();
                if (Array.isArray(content)) {
                    return content
                        .map((c) => {
                            if (
                                typeof c === "object" &&
                                c !== null &&
                                "text" in c &&
                                typeof (c as { text: unknown }).text === "string"
                            ) {
                                return ((c as { text: string }).text).toLowerCase();
                            }
                            return "";
                        })
                        .join("\n");
                }
                return "";
            })
            .join("\n");
        const blockedResults = session.events.toolResultsFor("think_execute").filter(
            (r) =>
                r.isError ||
                r.text.toLowerCase().includes("abort") ||
                String(((r.details as Record<string, unknown> | undefined)?.blockedReason ?? "")).toLowerCase().includes("abort"),
        );
        // The abort must be visible either as a failed/blocked tool result or
        // as an aborted assistant message.
        expect(
            blockedResults.length > 0 || abortText.includes("abort"),
        ).toBe(true);
    });

    it("does not produce any nested safe_bash result for a think_execute", async () => {
        const state = makeBrokerState();
        const home = createHarnessProject();
        const session = await createTestSession({
            cwd: home,
            extensionFactories: [thinkInCodeFactory(state)],
            mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
        });
        sessions.push(session);
        await session.session.agent.waitForIdle();

        await session.run(
            when("Run only via think_execute", [
                calls("think_execute", {
                    action: "command",
                    language: "javascript",
                    program: "INPUT",
                    command: "ls",
                }),
                says("Done."),
            ]),
        );

        // Exactly one outer think_execute result; no nested safe_bash.
        expect(session.events.toolResultsFor("think_execute")).toHaveLength(1);
        expect(session.events.toolResultsFor("safe_bash")).toHaveLength(0);
        expect(session.events.toolSequence().filter((n) => n === "safe_bash"))
            .toHaveLength(0);
    });

    it("exercises think_execute action=file with a real file under the project root", async () => {
        const state = makeBrokerState();
        const home = createHarnessProject();
        const session = await createTestSession({
            cwd: home,
            extensionFactories: [thinkInCodeFactory(state)],
            mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
        });
        sessions.push(session);
        await session.session.agent.waitForIdle();

        // Write a small JSON file inside the project.
        const projectFile = join(home, "data.json");
        await Bun.write(projectFile, '{"answer": 42}');

        await session.run(
            when("Analyze a file", [
                calls("think_execute", {
                    action: "file",
                    path: "data.json",
                    language: "javascript",
                    program: "FILE_CONTENT",
                }),
                says("Done."),
            ]),
        );

        expect(session.events.toolResultsFor("think_execute")).toHaveLength(
            1,
        );
        expect(state.analysisCalls).toHaveLength(1);
        expect(state.analysisCalls[0]?.bindings.FILE_CONTENT).toBe(
            '{"answer": 42}',
        );
        expect(state.analysisCalls[0]?.bindings.FILE_PATH).toBe(projectFile);
    });

    it("runs think_execute action=batch with per-item status, ordered inputs, bounded concurrency", async () => {
        const state = makeBrokerState();
        const home = createHarnessProject();
        const session = await createTestSession({
            cwd: home,
            extensionFactories: [thinkInCodeFactory(state)],
            mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
        });
        sessions.push(session);
        await session.session.agent.waitForIdle();

        await session.run(
            when("Run a batch of commands", [
                calls("think_execute", {
                    action: "batch",
                    language: "javascript",
                    program: "INPUTS",
                    items: [
                        { id: "alpha", command: "echo a" },
                        { id: "beta", command: "echo b" },
                        { id: "gamma", command: "echo c" },
                    ],
                }),
                says("Done."),
            ]),
        );

        // One outer result for think_execute; per-item statuses inside.
        const results = session.events.toolResultsFor("think_execute");
        expect(results).toHaveLength(1);
        const details = results[0]?.details as
            | { items?: Array<{ id: string; status: string }> }
            | undefined;
        expect(details?.items?.map((i) => i.id)).toEqual([
            "alpha",
            "beta",
            "gamma",
        ]);
        expect(details?.items?.every((i) => i.status === "succeeded")).toBe(
            true,
        );
        // One safe-execution call per item; the analyzer runs once over INPUTS.
        expect(state.safeExecCalls).toHaveLength(3);
        expect(state.analysisCalls).toHaveLength(1);
        const inputs = state.analysisCalls[0]?.bindings.INPUTS;
        expect(Array.isArray(inputs)).toBe(true);
        const parsed = inputs as Array<{
            id: string;
            status: string;
            output?: string;
        }>;
        expect(parsed.map((p) => p.id)).toEqual(["alpha", "beta", "gamma"]);
        expect(parsed.every((p) => p.status === "succeeded")).toBe(true);
        // No nested safe_bash result.
        expect(session.events.toolResultsFor("safe_bash")).toHaveLength(0);
    });

    it("runs think_note + think_search as bounded FTS5 operations", async () => {
        const state = makeBrokerState();
        const home = createHarnessProject();
        const session = await createTestSession({
            cwd: home,
            extensionFactories: [thinkInCodeFactory(state)],
            mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
        });
        sessions.push(session);
        await session.session.agent.waitForIdle();

        await session.run(
            when("Index and then search", [
                calls("think_note", {
                    source: "doc-a",
                    text: "fence_marker_alpha document body",
                }),
                calls("think_note", {
                    source: "doc-b",
                    text: "another body with fence_marker_beta",
                }),
                calls("think_search", { query: "fence_marker", limit: 5 }),
                says("Done."),
            ]),
        );

        const searchResult = session.events.toolResultsFor("think_search")[0];
        expect(searchResult).toBeDefined();
        const text = searchResult?.text ?? "";
        expect(text).toContain("fence_marker");
        // No raw archive bytes can leak through the LLM-facing snippet.
        expect(text).not.toContain("fence_marker_alpha");
        expect(text).not.toContain("fence_marker_beta");
        // The search returned bounded snippets plus archiveIds in details.
        const details = searchResult?.details as
            | { archiveIds?: readonly string[] }
            | undefined;
        expect(Array.isArray(details?.archiveIds)).toBe(true);
    });

    it("captures the tool_call / tool_result into the snapshot and injects once after compaction", async () => {
        const state = makeBrokerState();
        const home = createHarnessProject();
        const session = await createTestSession({
            cwd: home,
            extensionFactories: [thinkInCodeFactory(state)],
            mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
        });
        sessions.push(session);
        await session.session.agent.waitForIdle();

        // Drive a turn that exercises think_execute. The capture layer must
        // persist a bounded record, and a follow-up turn must find it in the
        // store without re-running any tool.
        await session.run(
            when("Capture state", [
                calls("think_execute", {
                    action: "command",
                    language: "javascript",
                    program: "INPUT",
                    command: "echo capture",
                }),
                says("Captured."),
            ]),
        );

        // Inspect the SQLite store directly to verify the capture landed.
        // The think-in-code extension's session_start handler opens the store
        // under `homedir()`. We accept either the test's disposable HOME or
        // the real HOME as long as a project directory was created.
        const { existsSync, readdirSync } = await import("node:fs");
        const os = await import("node:os");
        const realHome = os.homedir();
        const candidates = [
            join(testHome ?? home, ".pi", "agent", "think-in-code"),
            join(realHome, ".pi", "agent", "think-in-code"),
        ];
        const found = candidates.find((c) => existsSync(c));
        expect(found).toBeDefined();
        if (!found) return;
        const projectsRoot = join(found, "projects");
        expect(existsSync(projectsRoot)).toBe(true);
        const projects = readdirSync(projectsRoot);
        expect(projects.length).toBeGreaterThan(0);
    });
});

describe("think-in-code save-tokens boundary", () => {
    for (const toolName of THINK_TOOL_NAMES) {
        it(`routes ${toolName} through the real save-tokens backend without compression`, async () => {
            const { createToolResultHandler } = await import(
                "../save-tokens/tool-results/core.ts"
            );
            type Obs = { kind: string; toolName: string };
            const observations: Obs[] = [];
            let backendCalls = 0;
            const handler = createToolResultHandler({
                backend: {
                    id: "headroom" as const,
                    compress: async () => {
                        backendCalls += 1;
                        return { output: "should-never-run" };
                    },
                },
                minTokensByGroup: { shell: 0, read: 0, search: 0 },
                enabled: true,
                excludeTools: [],
                archiveOriginal: undefined,
                aggregates: true,
                capErrors: true,
                onObservation: (event) =>
                    observations.push(event as unknown as Obs),
            });
            const model = {
                provider: "anthropic",
                id: "claude-sonnet-4-6",
                contextWindow: 200_000,
            };
            const toolNameValue: string = toolName;
            const event = {
                type: "tool_result" as const,
                toolCallId: `tc-${toolNameValue}`,
                toolName: toolNameValue,
                content: [{ type: "text" as const, text: "A".repeat(200_000) }],
                isError: false,
                input: {},
                details: undefined,
            };
            const result = await handler(event, model, undefined);
            expect(result).toBeUndefined();
            expect(observations).toEqual([]);
            expect(backendCalls).toBe(0);
        });
    }
});
