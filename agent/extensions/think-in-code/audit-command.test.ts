import { describe, expect, it, mock } from "bun:test";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { registerThinkAuditCommand } from "./audit-command.ts";
import { DEFAULT_THINK_IN_CODE_CONFIG } from "./config.ts";
import type { ReadThinkTelemetryOptions } from "./telemetry/storage.ts";
import type { ThinkTelemetryEvent } from "./telemetry/types.ts";

type CommandDefinition = {
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

const telemetryEvent: ThinkTelemetryEvent = {
    schemaVersion: 1,
    eventId: "event-1",
    timestamp: "2026-09-05T12:00:00.000Z",
    sessionId: "session-1",
    origin: "think_execute",
    toolCallId: "call-1",
    cwd: "/workspace/project",
    project: "/workspace/project",
    sequence: 1,
    decision: "blocked",
    outcome: "blocked",
    commandLength: 11,
};

describe("/think-audit", () => {
    it("reads only the current project and starts a recommendation turn", async () => {
        let command: CommandDefinition | undefined;
        const lifecycle: string[] = [];
        const readTelemetry = mock(
            async (
                _root: string,
                _options: ReadThinkTelemetryOptions,
            ) => [telemetryEvent],
        );
        const sendUserMessage = mock((_prompt: string) => {
            lifecycle.push("send");
        });
        const beginAudit = mock(() => lifecycle.push("begin"));
        const pi = {
            registerCommand: (_name: string, definition: CommandDefinition) => {
                command = definition;
            },
            sendUserMessage,
        } as unknown as ExtensionAPI;
        registerThinkAuditCommand(pi, {
            getConfig: () => DEFAULT_THINK_IN_CODE_CONFIG,
            getTelemetryRoot: () => "/private/project/telemetry",
            beginAudit,
            readTelemetry,
            buildPrompt: () => "audit prompt",
        });
        if (!command) throw new Error("think-audit was not registered");
        const ctx = {
            cwd: "/workspace/project",
            ui: { notify: mock(() => undefined) },
        } as unknown as ExtensionCommandContext;

        await command.handler("days=7 limit=25", ctx);

        expect(readTelemetry).toHaveBeenCalledWith(
            "/private/project/telemetry",
            expect.objectContaining({
                days: 7,
                project: "/workspace/project",
            }),
        );
        expect(lifecycle).toEqual(["begin", "send"]);
        expect(sendUserMessage).toHaveBeenCalledWith("audit prompt");
    });
});
