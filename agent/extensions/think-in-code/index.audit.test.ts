import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { hashProjectPath } from "./config.ts";
import { registerThinkInCode } from "./index.ts";
import { createThinkTelemetryWriter } from "./telemetry/storage.ts";
import type { ThinkTelemetryEvent } from "./telemetry/types.ts";

type EventHandler = (...args: unknown[]) => unknown;
type CommandDefinition = {
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

let fixture: string | undefined;

afterEach(async () => {
    if (fixture) await rm(fixture, { recursive: true, force: true });
    fixture = undefined;
});

describe("think-in-code audit lifecycle", () => {
    it("blocks every tool only for the recommendation turn", async () => {
        fixture = await mkdtemp(join(tmpdir(), "think-audit-index-"));
        const root = join(fixture, "think-in-code");
        const handlers = new Map<string, EventHandler[]>();
        const commands = new Map<string, CommandDefinition>();
        const sendUserMessage = mock((_prompt: string) => undefined);
        const pi = {
            on: (name: string, handler: EventHandler) => {
                const registered = handlers.get(name) ?? [];
                registered.push(handler);
                handlers.set(name, registered);
            },
            registerTool: () => undefined,
            registerCommand: (name: string, command: CommandDefinition) => {
                commands.set(name, command);
            },
            appendEntry: () => undefined,
            sendUserMessage,
        } as unknown as ExtensionAPI;
        registerThinkInCode(pi, { resolveRoot: () => root });

        const context = {
            cwd: fixture,
            hasUI: true,
            ui: { notify: mock(() => undefined) },
            sessionManager: {
                getSessionId: () => "session-1",
                getEntries: () => [],
            },
        } as unknown as ExtensionContext;
        await handlers.get("session_start")?.[0]?.({}, context);

        const canonical = await realpath(fixture);
        const telemetryRoot = join(
            root,
            "projects",
            hashProjectPath(canonical),
            "telemetry",
        );
        const writer = createThinkTelemetryWriter(telemetryRoot, "session-1");
        const event: ThinkTelemetryEvent = {
            schemaVersion: 1,
            eventId: "event-1",
            timestamp: new Date().toISOString(),
            sessionId: "session-1",
            origin: "think_execute",
            toolCallId: "call-1",
            cwd: canonical,
            project: canonical,
            sequence: 1,
            decision: "blocked",
            outcome: "blocked",
            commandLength: 9,
        };
        await writer.append(event);
        await writer.flush();

        const command = commands.get("think-audit");
        if (!command) throw new Error("think-audit was not registered");
        await command.handler("", context as unknown as ExtensionCommandContext);
        expect(sendUserMessage).toHaveBeenCalledTimes(1);

        const gate = handlers.get("tool_call")?.[0];
        if (!gate) throw new Error("tool_call gate was not registered");
        for (const toolName of ["read", "bash", "think_search"]) {
            await expect(gate({ toolName })).resolves.toMatchObject({
                block: true,
            });
        }

        await handlers.get("agent_end")?.[0]?.({});
        await expect(gate({ toolName: "read" })).resolves.toBeUndefined();
        await handlers.get("session_shutdown")?.[0]?.({});
    });
});
