import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
    DEFAULT_THINK_IN_CODE_CONFIG,
    hashProjectPath,
} from "./config.ts";
import { registerThinkInCode } from "./index.ts";
import { __getRawDatabase, ThinkStore } from "./storage/store.ts";

type EventHandler = (...args: unknown[]) => unknown;

let fixture: string | undefined;

afterEach(async () => {
    if (fixture) await rm(fixture, { recursive: true, force: true });
    fixture = undefined;
});

function context(cwd: string, sessionId: string): ExtensionContext {
    return {
        cwd,
        hasUI: false,
        ui: {},
        sessionManager: {
            getSessionId: () => sessionId,
            getEntries: () => [],
        },
    } as unknown as ExtensionContext;
}

describe("think-in-code extension lifecycle", () => {
    it("rebinds capture hooks to the current project store on a second session_start", async () => {
        fixture = await mkdtemp(join(tmpdir(), "think-index-lifecycle-"));
        const root = join(fixture, "state");
        const firstProject = join(fixture, "first");
        const secondProject = join(fixture, "second");
        await mkdir(firstProject);
        await mkdir(secondProject);

        const handlers = new Map<string, EventHandler[]>();
        let activeTools = ["think_execute", "think_note", "think_search"];
        const pi = {
            on: (name: string, handler: EventHandler) => {
                handlers.set(name, [...(handlers.get(name) ?? []), handler]);
            },
            registerTool: () => undefined,
            registerCommand: () => undefined,
            appendEntry: () => undefined,
            sendUserMessage: () => undefined,
            getActiveTools: () => activeTools,
            setActiveTools: (names: string[]) => {
                activeTools = [...names];
            },
        } as unknown as ExtensionAPI;
        registerThinkInCode(pi, { resolveRoot: () => root });

        for (const handler of [...(handlers.get("session_start") ?? [])]) {
            await handler({}, context(firstProject, "session-first"));
        }
        for (const handler of [...(handlers.get("session_start") ?? [])]) {
            await handler({}, context(secondProject, "session-second"));
        }
        for (const handler of handlers.get("before_agent_start") ?? []) {
            await handler({ prompt: "captured in the second project" });
        }
        for (const handler of handlers.get("turn_end") ?? []) {
            await handler({});
        }
        for (const handler of handlers.get("session_shutdown") ?? []) {
            await handler({});
        }

        const canonical = await realpath(secondProject);
        const store = new ThinkStore({
            config: DEFAULT_THINK_IN_CODE_CONFIG,
            storeRoot: join(root, "projects", hashProjectPath(canonical)),
            canonicalPath: canonical,
        });
        const rows = __getRawDatabase(store)
            .query("SELECT payload FROM session_events ORDER BY id")
            .all() as Array<{ payload: string }>;
        store.close();

        expect(rows).toHaveLength(1);
        expect(rows[0]?.payload).toContain("captured in the second project");
    });
});
