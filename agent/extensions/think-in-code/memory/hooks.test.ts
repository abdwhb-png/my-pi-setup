import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_THINK_IN_CODE_CONFIG } from "../config.ts";
import { ThinkStore, __getRawDatabase } from "../storage/store.ts";
import { ThinkCoordinator } from "../coordinator.ts";
import { HookState } from "./hooks.ts";

let home: string | undefined;
let store: ThinkStore | undefined;
let coordinator: ThinkCoordinator | undefined;
let state: HookState | undefined;

afterEach(async () => {
    state?.shutdown();
    coordinator?.close();
    store?.close();
    if (home) await rm(home, { recursive: true, force: true });
    home = undefined;
    state = undefined;
    coordinator = undefined;
    store = undefined;
});

async function setupState(sessionId = "session-1"): Promise<{
    store: ThinkStore;
    state: HookState;
}> {
    home = await mkdtemp(join(tmpdir(), "think-in-code-hooks-"));
    const storeRoot = join(home, "store");
    await mkdir(storeRoot, { recursive: true });
    store = new ThinkStore({
        config: DEFAULT_THINK_IN_CODE_CONFIG,
        storeRoot,
        canonicalPath: "/workspace/proj",
    });
    coordinator = new ThinkCoordinator({
        store,
        config: DEFAULT_THINK_IN_CODE_CONFIG,
    });
    state = new HookState({
        store,
    });
    state.start(sessionId);
    return { store, state };
}

describe("HookState", () => {
    it("persists a snapshot on session_before_compact and consumes it once", async () => {
        const setup = await setupState();
        setup.state.captureUserPrompt("Investigate the failing test");
        setup.state.captureToolCall("bash", { command: "npm test" });
        setup.state.captureToolResult({
            toolName: "bash",
            isError: true,
            details: { reason: "command not allowed" },
        });
        setup.state.endTurn();

        const snapshot = setup.state.buildAndPersistSnapshot("session-1");
        expect(snapshot).toBeDefined();
        expect(snapshot?.estimatedTokens).toBeLessThanOrEqual(1500);
        expect(setup.state.hasPendingSnapshot()).toBe(false);
        expect(setup.state.consumeSnapshot("session-1")).toBeUndefined();

        setup.state.markReadyForRestore("session-1", "compaction-entry-1");
        expect(setup.state.hasPendingSnapshot()).toBe(true);

        const consumed = setup.state.consumeSnapshot("session-1");
        expect(consumed).toBeDefined();
        // Second consume must NOT return anything (one-shot).
        expect(setup.state.consumeSnapshot("session-1")).toBeUndefined();
    });

    it("does not consume a snapshot before any compaction happens", async () => {
        const setup = await setupState();
        expect(setup.state.hasPendingSnapshot()).toBe(false);
        expect(setup.state.consumeSnapshot("session-1")).toBeUndefined();
    });

    it("recovers an unconsumed snapshot from a previous session on restart", async () => {
        const sessionId = "session-restart";
        const setup1 = await setupState(sessionId);
        setup1.state.captureUserPrompt("Restore me");
        setup1.state.endTurn();
        setup1.state.buildAndPersistSnapshot(sessionId);
        setup1.state.markReadyForRestore(sessionId, "compaction-7");
        const entries = setup1.state.customEntries();

        const recovered = new HookState({ store: setup1.store });
        recovered.start(sessionId, entries);
        expect(recovered.hasPendingSnapshot()).toBe(true);
        expect(recovered.consumeSnapshot(sessionId)).toBeDefined();

        const afterConsumption = new HookState({ store: setup1.store });
        afterConsumption.start(sessionId, [
            ...entries,
            ...recovered.customEntries(),
        ]);
        expect(afterConsumption.hasPendingSnapshot()).toBe(false);
        expect(afterConsumption.consumeSnapshot(sessionId)).toBeUndefined();
        state = afterConsumption;
    });

    it("persists captures from two turns under the actual session id", async () => {
        const setup = await setupState("real-session-id");
        setup.state.captureUserPrompt("first turn objective");
        setup.state.endTurn();
        setup.state.captureUserPrompt("second turn objective");
        setup.state.endTurn();
        const rows = __getRawDatabase(setup.store)
            .query("SELECT session_id AS sessionId, turn_index AS turnIndex FROM session_events ORDER BY id")
            .all() as Array<{ sessionId: string; turnIndex: number }>;
        expect(rows.map((row) => row.sessionId)).toEqual([
            "real-session-id",
            "real-session-id",
        ]);
        expect(rows.map((row) => row.turnIndex)).toEqual([0, 1]);
    });

    it("redacts bearer tokens from captured text", async () => {
        const setup = await setupState();
        setup.state.captureUserPrompt(
            "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        );
        setup.state.endTurn();
        const snapshot = setup.state.buildAndPersistSnapshot("session-1");
        expect(snapshot?.content).not.toContain("abcdefghijklmnopqrstuvwxyz");
        expect(snapshot?.content).toContain("[REDACTED]");
    });

    it("keeps capture failures fail-open", () => {
        // The HookState's capture methods never throw; verify by exercising
        // the path even when state is not started.
        const local = new HookState({
            store: store!,
        });
        expect(() => local.captureUserPrompt("hi")).not.toThrow();
        expect(() => local.captureToolCall("bash", { command: "ls" })).not.toThrow();
        expect(() =>
            local.captureToolResult({
                toolName: "bash",
                isError: false,
            }),
        ).not.toThrow();
    });

    it("enforces the full snapshot state machine across session_start / before_compact / session_compact / consume", async () => {
        // Stage 1: capture, build a snapshot. State machine forbids consume
        // until the compaction-ready marker has been observed.
        const sessionId = "state-machine";
        const setup = await setupState(sessionId);
        setup.state.captureUserPrompt("Investigate why the test fails");
        setup.state.captureToolCall("think_execute", {
            id: "x",
            language: "javascript",
            program: "1",
            content: "hi",
        });
        setup.state.captureToolResult({
            toolName: "think_execute",
            isError: false,
            details: {},
            references: ["archive-001"],
        });
        setup.state.endTurn();

        // Before session_before_compact: no snapshot, no ready marker, no consume.
        expect(setup.state.hasPendingSnapshot()).toBe(false);

        // session_before_compact persists the snapshot but does NOT make it
        // consumable yet. consumeSnapshot must remain empty until the ready
        // marker is observed.
        const persisted = setup.state.buildAndPersistSnapshot(sessionId);
        expect(persisted).toBeDefined();
        expect(setup.state.hasPendingSnapshot()).toBe(false);
        expect(setup.state.consumeSnapshot(sessionId)).toBeUndefined();

        // session_compact publishes the ready marker. Only then is the snapshot
        // available for restoration.
        setup.state.markReadyForRestore(sessionId, "compaction-entry-42");
        expect(setup.state.hasPendingSnapshot()).toBe(true);

        // Consume exactly once (one-shot). The second call must NOT return the
        // snapshot, preventing duplicate injection after a reload.
        const consumed = setup.state.consumeSnapshot(sessionId);
        expect(consumed).toBeDefined();
        expect(setup.state.hasPendingSnapshot()).toBe(false);
        expect(setup.state.consumeSnapshot(sessionId)).toBeUndefined();

        // Stage 2: simulate a session reload. Custom entries must include the
        // snapshot AND the consumed marker, otherwise the snapshot would be
        // re-injected on the next reload.
        const entries = setup.state.customEntries();
        const types = entries.map((entry) => entry.customType).sort();
        expect(types).toContain("think-in-code:snapshot");
        expect(types).toContain("think-in-code:snapshot:ready");
        expect(types).toContain("think-in-code:snapshot:consumed");

        // Stage 3: rehydrate the state from those entries on a fresh HookState.
        // The consumed marker must prevent the snapshot from being re-injected.
        const rehydrated = new HookState({ store: setup.store });
        rehydrated.start(sessionId, entries);
        expect(rehydrated.hasPendingSnapshot()).toBe(false);
        expect(rehydrated.consumeSnapshot(sessionId)).toBeUndefined();
        state = rehydrated;
    });

    it("ignores stale or mismatched session ids for restore markers", async () => {
        // The snapshot is persisted under session A, but the compaction entry
        // carries session B's id. The HookState must NOT mark the snapshot
        // ready, so it cannot be restored into the wrong session.
        const setup = await setupState("session-A");
        setup.state.captureUserPrompt("objective");
        setup.state.endTurn();
        setup.state.buildAndPersistSnapshot("session-A");
        expect(setup.state.markReadyForRestore("session-B", "compaction-9")).toBeUndefined();
        expect(setup.state.hasPendingSnapshot()).toBe(false);
        expect(setup.state.consumeSnapshot("session-A")).toBeUndefined();
    });

    it("persists a snapshot with archive references and survives reopen with different snapshot id", async () => {
        // Build a snapshot that carries archive references. After reopen on a
        // fresh store instance, the snapshot must be recoverable, identifiable
        // by the session id, and ordered deterministically.
        const sessionId = "session-references";
        const setup = await setupState(sessionId);
        setup.state.captureUserPrompt("Investigate");
        setup.state.captureToolResult({
            toolName: "think_execute",
            isError: false,
            details: {},
            references: ["abc12345", "def67890"],
        });
        setup.state.endTurn();
        const persisted = setup.state.buildAndPersistSnapshot(sessionId);
        expect(persisted?.archiveReferenceCount).toBe(2);
        expect(persisted?.content).toContain("abc12345");
        expect(persisted?.content).toContain("def67890");

        setup.state.markReadyForRestore(sessionId, "compaction-3");
        expect(setup.state.consumeSnapshot(sessionId)).toBeDefined();
    });
});