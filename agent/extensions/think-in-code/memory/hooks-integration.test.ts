import { afterEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
    ContextEvent,
    ExtensionAPI,
    ExtensionContext,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_THINK_IN_CODE_CONFIG } from "../config.ts";
import { ThinkStore, __getRawDatabase } from "../storage/store.ts";
import { registerHooks, type HookState } from "./hooks.ts";

type EventHandler = (event: any, ctx: ExtensionContext) => unknown;

function makeContext(sessionId: string, entries: SessionEntry[] = []) {
    return {
        cwd: "/workspace/proj",
        hasUI: false,
        ui: {},
        sessionManager: {
            getSessionId: () => sessionId,
            getEntries: () => entries,
        },
    } as unknown as ExtensionContext;
}

function successContent() {
    return [
        {
            type: "text",
            text: JSON.stringify({
                status: "success",
                action: "file",
                sourceStatus: "succeeded",
                sourceBytes: 8192,
                resultBytes: 18,
                truncated: false,
                archiveIds: ["artifact123"],
            }),
        },
        { type: "text", text: "bounded derivation" },
    ];
}

describe("registerHooks receipt lifecycle", () => {
    let home: string | undefined;
    let store: ThinkStore | undefined;
    let state: HookState | undefined;

    afterEach(async () => {
        state?.shutdown();
        store?.close();
        if (home) await rm(home, { recursive: true, force: true });
    });

    async function setup(activeTools = [
        "think_execute",
        "think_artifact_search",
    ]) {
        home = await mkdtemp(join(tmpdir(), "think-hooks-integration-"));
        await mkdir(join(home, "store"), { recursive: true });
        store = new ThinkStore({
            config: DEFAULT_THINK_IN_CODE_CONFIG,
            storeRoot: join(home, "store"),
            canonicalPath: "/workspace/proj",
        });
        const handlers = new Map<string, EventHandler>();
        const entries: SessionEntry[] = [];
        const pi = {
            on: (name: string, handler: EventHandler) => handlers.set(name, handler),
            appendEntry: (customType: string, data: unknown) => {
                entries.push({
                    type: "custom",
                    customType,
                    data,
                    id: `entry-${entries.length}`,
                    parentId: null,
                    timestamp: new Date().toISOString(),
                } as SessionEntry);
            },
            getActiveTools: () => activeTools,
        } as unknown as ExtensionAPI;
        state = registerHooks(pi, {
            store,
            sessionIdAt: (ctx) => ctx.sessionManager.getSessionId() ?? "unknown",
        });
        return { handlers, entries };
    }

    it("injects only execution and artifact-search guidance", async () => {
        const { handlers } = await setup();
        const result = (await handlers.get("before_agent_start")?.(
            { prompt: "remember this preference", systemPrompt: "Base" },
            makeContext("session"),
        )) as { systemPrompt: string };

        expect(result.systemPrompt).toContain("think_execute");
        expect(result.systemPrompt).toContain("think_artifact_search");
        expect(result.systemPrompt).not.toContain("think_note");
        expect(result.systemPrompt).not.toContain("remember this preference");
    });

    it("does not register a general tool-call capture hook", async () => {
        const { handlers } = await setup();
        expect(handlers.has("tool_call")).toBe(false);
    });

    it("captures no prompt or unrelated tool result", async () => {
        const { handlers } = await setup();
        const ctx = makeContext("session");
        await handlers.get("session_start")?.({}, ctx);
        await handlers.get("before_agent_start")?.(
            { prompt: "private preference", systemPrompt: "Base" },
            ctx,
        );
        await handlers.get("tool_result")?.(
            {
                toolName: "bash",
                content: [{ type: "text", text: "general output" }],
            },
            ctx,
        );
        await handlers.get("turn_end")?.({}, ctx);

        const count = __getRawDatabase(store!)
            .query<{ count: number }, []>(
                "SELECT COUNT(*) AS count FROM session_events",
            )
            .get()?.count;
        expect(count).toBe(0);
    });

    it("injects one hidden bounded receipt after compaction", async () => {
        const { handlers } = await setup();
        const ctx = makeContext("session");
        await handlers.get("session_start")?.({}, ctx);
        await handlers.get("tool_result")?.(
            { toolName: "think_execute", content: successContent() },
            ctx,
        );
        await handlers.get("turn_end")?.({}, ctx);
        await handlers.get("session_before_compact")?.({}, ctx);
        await handlers.get("session_compact")?.(
            { compactionEntry: { id: "compact-1" } },
            ctx,
        );

        const messages: AgentMessage[] = [];
        await handlers.get("context")?.(
            { type: "context", messages } as ContextEvent,
            ctx,
        );
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
            role: "custom",
            customType: "think-in-code:snapshot",
            display: false,
        });
        const restoredContent = Reflect.get(messages[0] ?? {}, "content");
        expect(Buffer.byteLength(String(restoredContent))).toBeLessThanOrEqual(
            2048,
        );
        expect(String(restoredContent)).toContain("artifact123");

        const second: AgentMessage[] = [];
        await handlers.get("context")?.(
            { type: "context", messages: second } as ContextEvent,
            ctx,
        );
        expect(second).toEqual([]);
    });
});
