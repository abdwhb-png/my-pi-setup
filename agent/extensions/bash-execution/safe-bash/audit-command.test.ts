/// <reference types="bun" />

import { describe, expect, it, mock } from "bun:test";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { registerSafeBashAuditCommand } from "./audit-command.ts";
import { DEFAULT_SAFE_BASH_CONFIG } from "./config.ts";
import type { ReadTelemetryOptions } from "./telemetry/storage.ts";
import {
    SAFE_BASH_TELEMETRY_SCHEMA_VERSION,
    type SafeBashTelemetryEvent,
} from "./telemetry/types.ts";

type CommandDefinition = {
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

const telemetryEvent: SafeBashTelemetryEvent = {
    schemaVersion: SAFE_BASH_TELEMETRY_SCHEMA_VERSION,
    eventId: "event-1",
    timestamp: "2026-08-25T12:00:00.000Z",
    sessionId: "session-1",
    origin: "safe_bash",
    toolCallId: "call-1",
    cwd: "/workspace/project",
    project: "/workspace/project",
    sequence: 1,
    decision: "blocked",
    outcome: "blocked",
    command: "rm -rf dist",
    commandLength: 11,
    groupId: "rm",
    patternId: "rm:1",
};

function setup(events: SafeBashTelemetryEvent[]) {
    let command: CommandDefinition | undefined;
    const lifecycle: string[] = [];
    const sendUserMessage = mock((_prompt: string) => {
        lifecycle.push("send");
    });
    const notify = mock((_message: string, _level: string) => undefined);
    const beginAudit = mock(() => {
        lifecycle.push("begin");
    });
    const readTelemetry = mock(
        async (_root: string, _options: ReadTelemetryOptions) => events,
    );
    const pi = {
        registerCommand: (_name: string, definition: CommandDefinition) => {
            command = definition;
        },
        sendUserMessage,
    } as unknown as ExtensionAPI;
    const options = {
        getConfig: () => DEFAULT_SAFE_BASH_CONFIG,
        beginAudit,
        readTelemetry,
        buildPrompt: () => "audit prompt",
    };
    registerSafeBashAuditCommand(pi, options);
    if (!command) throw new Error("audit command was not registered");
    const ctx = {
        cwd: "/workspace/project",
        ui: { notify },
    } as unknown as ExtensionCommandContext;
    return {
        command,
        ctx,
        beginAudit,
        lifecycle,
        notify,
        readTelemetry,
        sendUserMessage,
    };
}

describe("/safe-bash-audit", () => {
    it("reads current-project telemetry and starts recommendation analysis", async () => {
        const {
            command,
            ctx,
            beginAudit,
            lifecycle,
            readTelemetry,
            sendUserMessage,
        } = setup([telemetryEvent]);

        await command.handler("days=7 limit=25", ctx);

        expect(readTelemetry).toHaveBeenCalledTimes(1);
        expect(readTelemetry.mock.calls[0]?.[1]).toMatchObject({
            days: 7,
            limit: 25,
            project: "/workspace/project",
        });
        expect(beginAudit).toHaveBeenCalledTimes(1);
        expect(lifecycle).toEqual(["begin", "send"]);
        expect(sendUserMessage).toHaveBeenCalledWith("audit prompt");
    });

    it("reports no data without starting an LLM turn", async () => {
        const { command, ctx, beginAudit, notify, sendUserMessage } = setup([]);

        await command.handler("", ctx);

        expect(beginAudit).not.toHaveBeenCalled();
        expect(sendUserMessage).not.toHaveBeenCalled();
        expect(notify.mock.calls[0]?.[0]).toContain("No safe-bash telemetry");
    });
});
