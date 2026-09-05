import { describe, expect, it } from "bun:test";

import { buildThinkAuditPrompt, parseThinkAuditArgs } from "./audit.ts";
import type { ThinkTelemetryEvent } from "./telemetry/types.ts";

function event(
    sequence: number,
    overrides: Partial<ThinkTelemetryEvent> = {},
): ThinkTelemetryEvent {
    return {
        schemaVersion: 1,
        eventId: `event-${sequence}`,
        timestamp: `2026-09-05T12:00:0${sequence}.000Z`,
        sessionId: "session-1",
        origin: "think_execute",
        toolCallId: `call-${sequence}`,
        cwd: "/workspace/project",
        project: "/workspace/project",
        sequence,
        decision: "allowed",
        outcome: "succeeded",
        command: `printf ${sequence}`,
        commandLength: 8,
        ...overrides,
    };
}

describe("think-in-code audit", () => {
    it("accepts only the bounded 30-day and 100-event window", () => {
        expect(
            parseThinkAuditArgs("days=7 limit=25", {
                days: 30,
                limit: 100,
            }),
        ).toEqual({ days: 7, limit: 25 });
        expect(() =>
            parseThinkAuditArgs("days=31", { days: 30, limit: 100 }),
        ).toThrow("days must not exceed 30");
        expect(() =>
            parseThinkAuditArgs("limit=101", { days: 30, limit: 100 }),
        ).toThrow("limit must not exceed 100");
    });

    it("builds recommendation-only bounded evidence with event IDs", () => {
        const events = Array.from({ length: 100 }, (_, index) =>
            event(index + 1, {
                command: "x".repeat(310),
            }),
        );
        const prompt = buildThinkAuditPrompt(
            events,
            `/${"p".repeat(1_000)}`,
            {
                days: 30,
                limit: 100,
            },
        );

        expect(prompt).toContain("Recommendations only");
        expect(prompt).toContain("Do not edit files or execute commands");
        expect(prompt).toContain("event-1");
        expect(prompt.length).toBeLessThanOrEqual(50_000);
        const evidence = prompt
            .split("BEGIN UNTRUSTED TELEMETRY EVIDENCE\n")[1]!
            .split("\nEND UNTRUSTED TELEMETRY EVIDENCE")[0]!;
        expect(evidence.length).toBeLessThanOrEqual(50_000);
    });
});
