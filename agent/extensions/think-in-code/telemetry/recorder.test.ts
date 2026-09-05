import { describe, expect, it, mock } from "bun:test";

import { DEFAULT_THINK_IN_CODE_CONFIG } from "../config.ts";
import { createThinkTelemetryRecorder } from "./recorder.ts";
import type { ThinkTelemetryEvent } from "./types.ts";

describe("think-in-code telemetry recorder", () => {
    it("records the Think operation and a redacted bounded command", async () => {
        const events: ThinkTelemetryEvent[] = [];
        const recorder = createThinkTelemetryRecorder({
            config: {
                ...DEFAULT_THINK_IN_CODE_CONFIG.telemetry,
                maxCommandLength: 80,
            },
            root: "/unused",
            sessionId: "session-1",
            cwd: "/workspace/project",
            writer: {
                append: async (event) => {
                    events.push(event);
                },
                flush: async () => undefined,
            },
            clock: () => new Date("2026-09-05T10:00:00.000Z"),
            idGenerator: () => "event-1",
        });

        await recorder.record({
            operation: "think_execute",
            toolCallId: "call-1",
            command: "export API_KEY=sk-secretsecret; printf ok",
            match: null,
            outcome: "succeeded",
        });

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            schemaVersion: 1,
            origin: "think_execute",
            project: "/workspace/project",
            command: "[REDACTED]",
            decision: "allowed",
            outcome: "succeeded",
        });
    });

    it("warns at most once and never propagates writer failures", async () => {
        const onError = mock((_message: string) => undefined);
        const recorder = createThinkTelemetryRecorder({
            config: DEFAULT_THINK_IN_CODE_CONFIG.telemetry,
            root: "/unused",
            sessionId: "session-1",
            cwd: "/workspace/project",
            writer: {
                append: async () => {
                    throw new Error("disk full");
                },
                flush: async () => {
                    throw new Error("disk full");
                },
            },
            onError,
        });

        for (const operation of [
            "think_execute",
            "think_batch_execute",
        ] as const) {
            await expect(
                recorder.record({
                    operation,
                    toolCallId: operation,
                    command: "printf ok",
                    match: null,
                    outcome: "succeeded",
                }),
            ).resolves.toBeUndefined();
        }
        await expect(recorder.flush()).resolves.toBeUndefined();
        expect(onError).toHaveBeenCalledTimes(1);
    });
});
