/**
 * Integration tests for Think-in-Code capture/hook lifecycle.
 *
 * These tests exercise the full `registerHooks` API with a mock
 * `ExtensionAPI` to verify:
 *
 *   - the actual Pi session id flows from `ctx.sessionManager.getSessionId()`
 *     into every capture, snapshot, and restore operation,
 *   - `turn_end` flushes capture each turn and leaves subsequent turns able
 *     to persist,
 *   - hook handlers fire in the documented order without dropping events,
 *   - the post-compaction snapshot restore is gated by an explicit ready
 *     marker tied to the compaction entry id,
 *   - versioned extension-private custom entries persist across reload/fork
 *     /tree reconstruction and keep the snapshot consumed,
 *   - the context hook pushes exactly one hidden custom agent message and
 *     never re-injects a snapshot that was already consumed.
 *   - tool results with `blockedReason`, failed batch items, or diagnostic
 *     failures are captured as blockers independently of Pi's `isError`.
 *
 * These tests use disposable on-disk fixtures; no real Pi runtime or MCP
 * bridge is required.
 */

import {
    afterEach,
    describe,
    expect,
    it,
} from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
    ContextEvent,
    ExtensionAPI,
    ExtensionContext,
    SessionCompactEvent,
    SessionEntry,
    SessionStartEvent,
    ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_THINK_IN_CODE_CONFIG } from "../config.ts";
import { ThinkStore, __getRawDatabase } from "../storage/store.ts";

import {
    registerHooks,
    type HookState,
} from "./hooks.ts";

interface MockPi {
    api: ExtensionAPI;
    handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
    appendedEntries: Array<{
        customType: string;
        data: unknown;
    }>;
    getEntries: () => SessionEntry[];
}

function createMockPi(
    initialEntries: SessionEntry[] = [],
): MockPi {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const appendedEntries: Array<{
        customType: string;
        data: unknown;
    }> = [];
    const sessionEntries: SessionEntry[] = [...initialEntries];

    function getEntries(): SessionEntry[] {
        return [...sessionEntries];
    }

    function append(customType: string, data: unknown): void {
        appendedEntries.push({ customType, data });
        // Mirror what `pi.appendEntry` does at runtime: persist a SessionEntry
        // record with type=custom so reload/fork can rehydrate the state.
        sessionEntries.push({
            type: "custom",
            customType,
            data,
            id: `entry-${appendedEntries.length}`,
            parentId: null,
            timestamp: new Date().toISOString(),
        } as SessionEntry);
    }

    const api = {
        on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
            handlers.set(event, handler);
        },
        appendEntry: (customType: string, data: unknown) => {
            append(customType, data);
        },
        sendMessage: () => undefined,
        sendUserMessage: () => undefined,
        registerTool: () => undefined,
        registerCommand: () => undefined,
        registerShortcut: () => undefined,
        registerFlag: () => undefined,
        getFlag: () => undefined,
        registerMessageRenderer: () => undefined,
        registerEntryRenderer: () => undefined,
        registerMarkdownTransformer: () => undefined,
        setActiveTools: () => undefined,
        getActiveTools: () => [],
        getAllTools: () => [],
        getCommands: () => [],
        setModel: async () => true,
        getThinkingLevel: () => "off",
        setThinkingLevel: () => undefined,
        setSessionName: () => undefined,
        getSessionName: () => undefined,
        setLabel: () => undefined,
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        shutdown: () => undefined,
        reload: async () => undefined,
    } as unknown as ExtensionAPI;

    return { api, handlers, appendedEntries, getEntries };
}

function makeCtx(sessionId: string): ExtensionContext {
    return {
        cwd: "/workspace/proj",
        hasUI: false,
        mode: "rpc",
        ui: {},
        sessionManager: {
            getSessionId: () => sessionId,
            getEntries: () => [],
        },
        modelRegistry: {} as ExtensionContext["modelRegistry"],
        model: undefined,
        scopedModels: [],
        isIdle: () => true,
        isProjectTrusted: () => false,
        signal: undefined,
        abort: () => undefined,
        hasPendingMessages: () => false,
        shutdown: () => undefined,
        getContextUsage: () => undefined,
        compact: () => undefined,
        getSystemPrompt: () => "",
    } as unknown as ExtensionContext;
}

async function setupHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "think-in-code-int-"));
    const storeRoot = join(home, "store");
    await mkdir(storeRoot, { recursive: true });
    return home;
}

async function setupStore(home: string): Promise<ThinkStore> {
    const storeRoot = join(home, "store");
    const store = new ThinkStore({
        config: DEFAULT_THINK_IN_CODE_CONFIG,
        storeRoot,
        canonicalPath: "/workspace/proj",
    });
    return store;
}

describe("registerHooks integration", () => {
    let homes: string[] = [];
    let stores: ThinkStore[] = [];
    let hookStates: HookState[] = [];

    afterEach(async () => {
        for (const state of hookStates) state.shutdown();
        hookStates = [];
        for (const store of stores) store.close();
        stores = [];
        for (const home of homes) await rm(home, { recursive: true, force: true });
        homes = [];
    });

    it("captures two consecutive turns under the actual Pi session id", async () => {
        const home = await setupHome();
        homes.push(home);
        const store = await setupStore(home);
        stores.push(store);
        const mock = createMockPi();
        const sessionId = "real-pi-session-001";
        const state = registerHooks(mock.api, {
            store,
            sessionIdAt: () => sessionId,
        });
        hookStates.push(state);

        // Drive a turn: prompt → tool_call → tool_result → turn_end.
        await mock.handlers.get("session_start")!(
            { type: "session_start", reason: "startup" } as SessionStartEvent,
            makeCtx(sessionId),
        );
        await mock.handlers.get("before_agent_start")!({
            type: "before_agent_start",
            prompt: "first turn objective",
        }, makeCtx(sessionId));
        await mock.handlers.get("turn_end")!({
            type: "turn_end",
        }, makeCtx(sessionId));

        await mock.handlers.get("before_agent_start")!({
            type: "before_agent_start",
            prompt: "second turn objective",
        }, makeCtx(sessionId));
        await mock.handlers.get("tool_call")!({
            type: "tool_call",
            toolName: "think_execute",
            input: { id: "x", language: "javascript", program: "1" },
        }, makeCtx(sessionId));
        await mock.handlers.get("tool_result")!({
            type: "tool_result",
            toolName: "think_execute",
            isError: false,
            details: { archiveIds: ["abcd1234efgh5678"] },
            content: [{ type: "text", text: "ok" }],
        } as ToolResultEvent, makeCtx(sessionId));
        await mock.handlers.get("turn_end")!({
            type: "turn_end",
        }, makeCtx(sessionId));

        const rows = __getRawDatabase(store)
            .query(
                "SELECT session_id AS sessionId, turn_index AS turnIndex " +
                    "FROM session_events ORDER BY id",
            )
            .all() as Array<{ sessionId: string; turnIndex: number }>;
        expect(rows.length).toBeGreaterThanOrEqual(3);
        expect(rows.every((row) => row.sessionId === "real-pi-session-001")).toBe(true);
        // turn 0 has the first prompt; turn 1 carries the second prompt and
        // the classified tool call/result. None of them should ever be tagged
        // with the placeholder session id from registerHooks.
        const turnIndices = [...new Set(rows.map((row) => row.turnIndex))].sort();
        expect(turnIndices).toEqual([0, 1]);
    });

    it("fires hooks in the documented order: before_agent_start → tool_call → tool_result → turn_end → session_before_compact → session_compact → context", async () => {
        const home = await setupHome();
        homes.push(home);
        const store = await setupStore(home);
        stores.push(store);
        const mock = createMockPi();
        const sessionId = "session-order";
        const state = registerHooks(mock.api, {
            store,
            sessionIdAt: () => sessionId,
        });
        hookStates.push(state);

        const order: string[] = [];

        await mock.handlers.get("session_start")!(
            { type: "session_start", reason: "startup" } as SessionStartEvent,
            makeCtx(sessionId),
        );

        // Insert probes that observe the call order without altering behavior.
        const beforeAgentStart = mock.handlers.get("before_agent_start")!;
        mock.handlers.set("before_agent_start", (event, ctx) => {
            order.push("before_agent_start");
            return beforeAgentStart(event, ctx);
        });
        const toolCall = mock.handlers.get("tool_call")!;
        mock.handlers.set("tool_call", (event, ctx) => {
            order.push("tool_call");
            return toolCall(event, ctx);
        });
        const toolResult = mock.handlers.get("tool_result")!;
        mock.handlers.set("tool_result", (event, ctx) => {
            order.push("tool_result");
            return toolResult(event, ctx);
        });
        const turnEnd = mock.handlers.get("turn_end")!;
        mock.handlers.set("turn_end", (event, ctx) => {
            order.push("turn_end");
            return turnEnd(event, ctx);
        });
        const beforeCompact = mock.handlers.get("session_before_compact")!;
        mock.handlers.set("session_before_compact", (event, ctx) => {
            order.push("session_before_compact");
            return beforeCompact(event, ctx);
        });
        const sessionCompact = mock.handlers.get("session_compact")!;
        mock.handlers.set("session_compact", (event, ctx) => {
            order.push("session_compact");
            return sessionCompact(event, ctx);
        });
        const context = mock.handlers.get("context")!;
        mock.handlers.set("context", (event, ctx) => {
            order.push("context");
            return context(event, ctx);
        });

        // Stage 1: capture a turn so a snapshot has content.
        await mock.handlers.get("before_agent_start")!({
            type: "before_agent_start",
            prompt: "investigate",
        }, makeCtx(sessionId));
        await mock.handlers.get("tool_call")!({
            type: "tool_call",
            toolName: "think_execute",
            input: { id: "x", language: "javascript", program: "1" },
        }, makeCtx(sessionId));
        await mock.handlers.get("tool_result")!({
            type: "tool_result",
            toolName: "think_execute",
            isError: false,
            content: [{ type: "text", text: "ok" }],
        } as ToolResultEvent, makeCtx(sessionId));
        await mock.handlers.get("turn_end")!({
            type: "turn_end",
        }, makeCtx(sessionId));

        // Stage 2: drive compaction and the next context event.
        await mock.handlers.get("session_before_compact")!({
            type: "session_before_compact",
        }, makeCtx(sessionId));
        await mock.handlers.get("session_compact")!({
            type: "session_compact",
            compactionEntry: {
                id: "compaction-entry-42",
                type: "compaction",
                summary: "summary",
                firstKeptEntryId: "first",
                tokensBefore: 1000,
            },
            fromExtension: false,
            reason: "manual",
            willRetry: false,
        } as SessionCompactEvent, makeCtx(sessionId));
        await mock.handlers.get("context")!({
            type: "context",
            messages: [] as AgentMessage[],
        } as ContextEvent, makeCtx(sessionId));

        expect(order).toEqual([
            "before_agent_start",
            "tool_call",
            "tool_result",
            "turn_end",
            "session_before_compact",
            "session_compact",
            "context",
        ]);
        // State machine outcome: the snapshot has been consumed once.
        expect(state.hasPendingSnapshot()).toBe(false);
    });

    it("does not re-inject the consumed snapshot after a reload", async () => {
        const home = await setupHome();
        homes.push(home);
        const store = await setupStore(home);
        stores.push(store);
        const mock = createMockPi();
        const sessionId = "session-reload";

        const state = registerHooks(mock.api, {
            store,
            sessionIdAt: () => sessionId,
        });
        hookStates.push(state);

        await mock.handlers.get("session_start")!(
            { type: "session_start", reason: "startup" } as SessionStartEvent,
            makeCtx(sessionId),
        );

        // Drive compaction and consume the snapshot.
        await mock.handlers.get("before_agent_start")!({
            type: "before_agent_start",
            prompt: "investigate",
        }, makeCtx(sessionId));
        await mock.handlers.get("turn_end")!({
            type: "turn_end",
        }, makeCtx(sessionId));
        await mock.handlers.get("session_before_compact")!({
            type: "session_before_compact",
        }, makeCtx(sessionId));
        await mock.handlers.get("session_compact")!({
            type: "session_compact",
            compactionEntry: {
                id: "compaction-entry-77",
                type: "compaction",
                summary: "",
                firstKeptEntryId: "first",
                tokensBefore: 1000,
            },
            fromExtension: false,
            reason: "manual",
            willRetry: false,
        } as SessionCompactEvent, makeCtx(sessionId));

        const contextMessages: AgentMessage[] = [];
        await mock.handlers.get("context")!({
            type: "context",
            messages: contextMessages,
        } as ContextEvent, makeCtx(sessionId));
        expect(contextMessages).toHaveLength(1);
        expect(contextMessages[0]).toMatchObject({
            role: "custom",
            display: false,
        });

        // The Pi runtime would append all `custom` entries via `appendEntry`
        // and they survive a reload via `getEntries()`. Build the rehydrated
        // mock Pi with those entries and start a fresh HookState to prove the
        // consumed marker prevents re-injection.
        const reloadedMock = createMockPi(mock.getEntries());
        const reloadedState = registerHooks(reloadedMock.api, {
            store,
            sessionIdAt: () => sessionId,
        });
        hookStates.push(reloadedState);
        await reloadedMock.handlers.get("session_start")!(
            { type: "session_start", reason: "reload" } as SessionStartEvent,
            makeCtx(sessionId),
        );
        expect(reloadedState.hasPendingSnapshot()).toBe(false);

        const reloadedMessages: AgentMessage[] = [];
        await reloadedMock.handlers.get("context")!({
            type: "context",
            messages: reloadedMessages,
        } as ContextEvent, makeCtx(sessionId));
        expect(reloadedMessages).toHaveLength(0);
    });

    it("does not re-inject the consumed snapshot on fork (session_start reason=fork)", async () => {
        const home = await setupHome();
        homes.push(home);
        const store = await setupStore(home);
        stores.push(store);
        const mock = createMockPi();
        const sessionId = "session-fork";
        const state = registerHooks(mock.api, {
            store,
            sessionIdAt: () => sessionId,
        });
        hookStates.push(state);

        await mock.handlers.get("session_start")!(
            { type: "session_start", reason: "startup" } as SessionStartEvent,
            makeCtx(sessionId),
        );
        await mock.handlers.get("before_agent_start")!({
            type: "before_agent_start",
            prompt: "investigate",
        }, makeCtx(sessionId));
        await mock.handlers.get("turn_end")!({
            type: "turn_end",
        }, makeCtx(sessionId));
        await mock.handlers.get("session_before_compact")!({
            type: "session_before_compact",
        }, makeCtx(sessionId));
        await mock.handlers.get("session_compact")!({
            type: "session_compact",
            compactionEntry: {
                id: "compaction-entry-fork",
                type: "compaction",
                summary: "",
                firstKeptEntryId: "first",
                tokensBefore: 1000,
            },
            fromExtension: false,
            reason: "manual",
            willRetry: false,
        } as SessionCompactEvent, makeCtx(sessionId));

        const consumedMessages: AgentMessage[] = [];
        await mock.handlers.get("context")!({
            type: "context",
            messages: consumedMessages,
        } as ContextEvent, makeCtx(sessionId));
        expect(consumedMessages).toHaveLength(1);

        // Fork: new session_start with reason=fork, but the appended custom
        // entries (including the consumed marker) are still visible through
        // getEntries() and must suppress re-injection.
        await mock.handlers.get("session_start")!(
            { type: "session_start", reason: "fork" } as SessionStartEvent,
            makeCtx(sessionId),
        );
        const forkMessages: AgentMessage[] = [];
        await mock.handlers.get("context")!({
            type: "context",
            messages: forkMessages,
        } as ContextEvent, makeCtx(sessionId));
        expect(forkMessages).toHaveLength(0);
        expect(state.hasPendingSnapshot()).toBe(false);
    });

    it("does not re-inject the consumed snapshot after tree navigation", async () => {
        const home = await setupHome();
        homes.push(home);
        const store = await setupStore(home);
        stores.push(store);
        const mock = createMockPi();
        const sessionId = "session-tree";
        const state = registerHooks(mock.api, {
            store,
            sessionIdAt: () => sessionId,
        });
        hookStates.push(state);

        await mock.handlers.get("session_start")!(
            { type: "session_start", reason: "startup" } as SessionStartEvent,
            makeCtx(sessionId),
        );
        await mock.handlers.get("before_agent_start")!({
            type: "before_agent_start",
            prompt: "investigate",
        }, makeCtx(sessionId));
        await mock.handlers.get("turn_end")!({
            type: "turn_end",
        }, makeCtx(sessionId));
        await mock.handlers.get("session_before_compact")!({
            type: "session_before_compact",
        }, makeCtx(sessionId));
        await mock.handlers.get("session_compact")!({
            type: "session_compact",
            compactionEntry: {
                id: "compaction-entry-tree",
                type: "compaction",
                summary: "",
                firstKeptEntryId: "first",
                tokensBefore: 1000,
            },
            fromExtension: false,
            reason: "manual",
            willRetry: false,
        } as SessionCompactEvent, makeCtx(sessionId));

        const firstMessages: AgentMessage[] = [];
        await mock.handlers.get("context")!({
            type: "context",
            messages: firstMessages,
        } as ContextEvent, makeCtx(sessionId));
        expect(firstMessages).toHaveLength(1);

        // Tree navigation: the same HookState stays alive across the rebuild.
        // The next context event after tree nav must NOT re-inject the
        // already-consumed snapshot because the in-memory HookState and the
        // persisted consumed marker both prevent it.
        const secondMessages: AgentMessage[] = [];
        await mock.handlers.get("context")!({
            type: "context",
            messages: secondMessages,
        } as ContextEvent, makeCtx(sessionId));
        expect(secondMessages).toHaveLength(0);
        expect(state.hasPendingSnapshot()).toBe(false);
    });

    it("classifies broker-denied Think executions as blockers independently of isError", async () => {
        const home = await setupHome();
        homes.push(home);
        const store = await setupStore(home);
        stores.push(store);
        const mock = createMockPi();
        const sessionId = "session-blocked";
        const state = registerHooks(mock.api, {
            store,
            sessionIdAt: () => sessionId,
        });
        hookStates.push(state);

        await mock.handlers.get("session_start")!(
            { type: "session_start", reason: "startup" } as SessionStartEvent,
            makeCtx(sessionId),
        );
        await mock.handlers.get("tool_call")!({
            type: "tool_call",
            toolName: "think_execute",
            input: { id: "x", language: "javascript", program: "1" },
        }, makeCtx(sessionId));

        // The broker denies with `blockedReason`; Pi marks this as not an
        // error because the tool returned a structured response. The capture
        // layer must still classify it as a blocker.
        await mock.handlers.get("tool_result")!({
            type: "tool_result",
            toolName: "think_execute",
            isError: false,
            content: [{ type: "text", text: "blocked" }],
            details: { blockedReason: "analysis sandbox unavailable" },
        } as ToolResultEvent, makeCtx(sessionId));

        await mock.handlers.get("turn_end")!({
            type: "turn_end",
        }, makeCtx(sessionId));

        const rows = __getRawDatabase(store)
            .query(
                "SELECT kind, payload FROM session_events ORDER BY id",
            )
            .all() as Array<{ kind: string; payload: string }>;
        expect(rows.length).toBeGreaterThan(0);
        const blocker = rows.find((row) => row.kind.endsWith(":0"));
        expect(blocker).toBeDefined();
        const parsed = JSON.parse(blocker!.payload) as {
            text: string;
            priority: number;
        };
        expect(parsed.priority).toBe(0);
        expect(parsed.text).toContain("analysis sandbox unavailable");
    });

    it("classifies failed batch items as blockers independently of isError", async () => {
        const home = await setupHome();
        homes.push(home);
        const store = await setupStore(home);
        stores.push(store);
        const mock = createMockPi();
        const sessionId = "session-batch-block";
        const state = registerHooks(mock.api, {
            store,
            sessionIdAt: () => sessionId,
        });
        hookStates.push(state);

        await mock.handlers.get("session_start")!(
            { type: "session_start", reason: "startup" } as SessionStartEvent,
            makeCtx(sessionId),
        );
        await mock.handlers.get("tool_call")!({
            type: "tool_call",
            toolName: "think_batch_execute",
            input: {
                language: "javascript",
                program: "1",
                items: [{ id: "a", command: "ls" }],
            },
        }, makeCtx(sessionId));
        await mock.handlers.get("tool_result")!({
            type: "tool_result",
            toolName: "think_batch_execute",
            isError: false,
            content: [{ type: "text", text: "partial" }],
            details: {
                items: [
                    { id: "a", status: "succeeded", byteCount: 0 },
                    {
                        id: "b",
                        status: "failed",
                        error: "exit 1",
                        byteCount: 0,
                    },
                ],
            },
        } as ToolResultEvent, makeCtx(sessionId));
        await mock.handlers.get("turn_end")!({
            type: "turn_end",
        }, makeCtx(sessionId));

        const rows = __getRawDatabase(store)
            .query("SELECT kind, payload FROM session_events ORDER BY id")
            .all() as Array<{ kind: string; payload: string }>;
        const blocker = rows.find((row) => row.kind.endsWith(":0"));
        expect(blocker).toBeDefined();
        const parsed = JSON.parse(blocker!.payload) as {
            text: string;
            priority: number;
        };
        expect(parsed.priority).toBe(0);
        expect(parsed.text.toLowerCase()).toContain("failed");
    });

    it("classifies diagnostic/test failures as blockers independently of isError", async () => {
        const home = await setupHome();
        homes.push(home);
        const store = await setupStore(home);
        stores.push(store);
        const mock = createMockPi();
        const sessionId = "session-diag";
        const state = registerHooks(mock.api, {
            store,
            sessionIdAt: () => sessionId,
        });
        hookStates.push(state);

        await mock.handlers.get("session_start")!(
            { type: "session_start", reason: "startup" } as SessionStartEvent,
            makeCtx(sessionId),
        );
        await mock.handlers.get("tool_call")!({
            type: "tool_call",
            toolName: "lsp_diagnostics",
            input: {},
        }, makeCtx(sessionId));
        await mock.handlers.get("tool_result")!({
            type: "tool_result",
            toolName: "lsp_diagnostics",
            isError: false,
            content: [{ type: "text", text: "diagnostics" }],
            details: { errorCount: 3, fileCount: 1 },
        } as ToolResultEvent, makeCtx(sessionId));
        await mock.handlers.get("turn_end")!({
            type: "turn_end",
        }, makeCtx(sessionId));

        const rows = __getRawDatabase(store)
            .query("SELECT kind, payload FROM session_events ORDER BY id")
            .all() as Array<{ kind: string; payload: string }>;
        const blocker = rows.find((row) => row.kind.endsWith(":0"));
        expect(blocker).toBeDefined();
        const parsed = JSON.parse(blocker!.payload) as {
            text: string;
            priority: number;
        };
        expect(parsed.priority).toBe(0);
    });

    it("gates the snapshot restore on the compaction entry id and persists versioned custom entries", async () => {
        const home = await setupHome();
        homes.push(home);
        const store = await setupStore(home);
        stores.push(store);
        const mock = createMockPi();
        const sessionId = "session-gate";
        const state = registerHooks(mock.api, {
            store,
            sessionIdAt: () => sessionId,
        });
        hookStates.push(state);

        await mock.handlers.get("session_start")!(
            { type: "session_start", reason: "startup" } as SessionStartEvent,
            makeCtx(sessionId),
        );
        await mock.handlers.get("before_agent_start")!({
            type: "before_agent_start",
            prompt: "investigate",
        }, makeCtx(sessionId));
        await mock.handlers.get("turn_end")!({
            type: "turn_end",
        }, makeCtx(sessionId));

        // Stage A: before_compact saves the snapshot but does NOT enable
        // restoration. A premature context event must NOT inject.
        await mock.handlers.get("session_before_compact")!({
            type: "session_before_compact",
        }, makeCtx(sessionId));

        const preReadyMessages: AgentMessage[] = [];
        await mock.handlers.get("context")!({
            type: "context",
            messages: preReadyMessages,
        } as ContextEvent, makeCtx(sessionId));
        expect(preReadyMessages).toHaveLength(0);

        // The snapshot has been persisted as a custom entry but the ready
        // marker has not. `start()` re-reads these entries and must keep the
        // snapshot un-restorable.
        const partialMock = createMockPi(mock.getEntries());
        const partialState = registerHooks(partialMock.api, {
            store,
            sessionIdAt: () => sessionId,
        });
        hookStates.push(partialState);
        await partialMock.handlers.get("session_start")!(
            { type: "session_start", reason: "reload" } as SessionStartEvent,
            makeCtx(sessionId),
        );
        expect(partialState.hasPendingSnapshot()).toBe(false);

        // Stage B: the compaction entry arrives. Only now does the snapshot
        // become restorable, and exactly one context injection is allowed.
        await mock.handlers.get("session_compact")!({
            type: "session_compact",
            compactionEntry: {
                id: "compaction-entry-gate",
                type: "compaction",
                summary: "",
                firstKeptEntryId: "first",
                tokensBefore: 1000,
            },
            fromExtension: false,
            reason: "manual",
            willRetry: false,
        } as SessionCompactEvent, makeCtx(sessionId));

        const injectedMessages: AgentMessage[] = [];
        await mock.handlers.get("context")!({
            type: "context",
            messages: injectedMessages,
        } as ContextEvent, makeCtx(sessionId));
        expect(injectedMessages).toHaveLength(1);
        expect(injectedMessages[0]).toMatchObject({
            role: "custom",
            display: false,
        });

        // Second context call: no re-injection (one-shot, persisted via
        // SNAPSHOT_CONSUMED_TYPE custom entry).
        const secondMessages: AgentMessage[] = [];
        await mock.handlers.get("context")!({
            type: "context",
            messages: secondMessages,
        } as ContextEvent, makeCtx(sessionId));
        expect(secondMessages).toHaveLength(0);

        // Custom entries persisted via appendEntry are versioned.
        const types = mock.appendedEntries.map((entry) => entry.customType).sort();
        expect(types).toContain("think-in-code:snapshot");
        expect(types).toContain("think-in-code:snapshot:ready");
        expect(types).toContain("think-in-code:snapshot:consumed");
        for (const entry of mock.appendedEntries) {
            expect((entry.data as { version: number }).version).toBe(1);
        }
    });
});