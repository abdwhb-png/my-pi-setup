import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_THINK_IN_CODE_CONFIG } from "../config.ts";
import { ThinkStore, __getRawDatabase } from "../storage/store.ts";
import { HookState } from "./hooks.ts";

let home: string | undefined;
let store: ThinkStore | undefined;
let state: HookState | undefined;

afterEach(async () => {
    state?.shutdown();
    store?.close();
    if (home) await rm(home, { recursive: true, force: true });
    home = undefined;
    state = undefined;
    store = undefined;
});

async function setupState(
    sessionId = "session-1",
    now: () => number = Date.now,
): Promise<HookState> {
    home = await mkdtemp(join(tmpdir(), "think-in-code-hooks-"));
    const storeRoot = join(home, "store");
    await mkdir(storeRoot, { recursive: true });
    store = new ThinkStore({
        config: DEFAULT_THINK_IN_CODE_CONFIG,
        storeRoot,
        canonicalPath: "/workspace/proj",
        now,
    });
    state = new HookState({ store });
    state.start(sessionId);
    return state;
}

function successContent(derivation = "safe derivation") {
    return [
        {
            type: "text",
            text: JSON.stringify({
                status: "success",
                action: "command",
                sourceStatus: "succeeded",
                sourceBytes: 4096,
                resultBytes: Buffer.byteLength(derivation),
                truncated: false,
                archiveIds: ["archive123"],
                indexStatus: "indexed",
            }),
        },
        { type: "text", text: derivation },
    ];
}

describe("HookState", () => {
    it("persists only Think execution receipts", async () => {
        const hookState = await setupState("technical-only");
        hookState.captureToolResult({
            toolName: "bash",
            content: [{ type: "text", text: "general command output" }],
        });
        hookState.captureToolResult({
            toolName: "think_execute",
            content: successContent(),
        });
        hookState.endTurn();

        const rows = __getRawDatabase(store!)
            .query("SELECT kind, payload FROM session_events ORDER BY id")
            .all() as Array<{ kind: string; payload: string }>;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.kind).toBe("think-in-code:execution-receipt");
        expect(rows[0]?.payload).toContain("safe derivation");
        expect(rows[0]?.payload).not.toContain("general command output");
    });

    it("persists and restores a receipt once after compaction", async () => {
        const hookState = await setupState();
        hookState.captureToolResult({
            toolName: "think_execute",
            content: successContent(),
        });
        hookState.endTurn();

        const snapshot = hookState.buildAndPersistSnapshot("session-1");
        expect(snapshot?.byteCount).toBeLessThanOrEqual(2048);
        expect(snapshot?.content).toContain("archive123");
        expect(hookState.hasPendingSnapshot()).toBe(false);

        hookState.markReadyForRestore("session-1", "compaction-entry-1");
        expect(hookState.consumeSnapshot("session-1")?.content).toContain(
            "safe derivation",
        );
        expect(hookState.consumeSnapshot("session-1")).toBeUndefined();
    });

    it("does not create a snapshot without a Think execution", async () => {
        const hookState = await setupState();
        hookState.captureToolResult({
            toolName: "read",
            content: [{ type: "text", text: "project source" }],
        });
        hookState.endTurn();
        expect(hookState.buildAndPersistSnapshot("session-1")).toBeUndefined();
    });

    it("recovers an unconsumed receipt snapshot after reload", async () => {
        const sessionId = "session-reload";
        const hookState = await setupState(sessionId);
        hookState.captureToolResult({
            toolName: "think_execute",
            content: successContent(),
        });
        hookState.endTurn();
        hookState.buildAndPersistSnapshot(sessionId);
        hookState.markReadyForRestore(sessionId, "compaction-entry-2");

        const recovered = new HookState({ store: store! });
        recovered.start(sessionId, hookState.customEntries());
        expect(recovered.consumeSnapshot(sessionId)?.content).toContain(
            "archive123",
        );
        state = recovered;
    });

    it("does not recover an expired snapshot from custom entries", async () => {
        let now = 1_700_000_000_000;
        const sessionId = "session-expired-reload";
        const hookState = await setupState(sessionId, () => now);
        hookState.captureToolResult({
            toolName: "think_execute",
            content: successContent(),
        });
        hookState.endTurn();
        hookState.buildAndPersistSnapshot(sessionId);
        hookState.markReadyForRestore(sessionId, "compaction-entry-expired");
        const entries = hookState.customEntries();

        now += 24 * 60 * 60 * 1000 + 1;
        const recovered = new HookState({ store: store! });
        recovered.start(sessionId, entries);

        expect(recovered.hasPendingSnapshot()).toBe(false);
        state = recovered;
    });

    it("does not build a compaction receipt from expired session events", async () => {
        let now = 1_700_000_000_000;
        const sessionId = "session-expired-events";
        const hookState = await setupState(sessionId, () => now);
        hookState.captureToolResult({
            toolName: "think_execute",
            content: successContent(),
        });
        hookState.endTurn();

        now += 24 * 60 * 60 * 1000 + 1;

        expect(hookState.buildAndPersistSnapshot(sessionId)).toBeUndefined();
    });
});
