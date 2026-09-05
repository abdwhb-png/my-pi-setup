/// <reference types="bun" />

import { describe, expect, it } from "bun:test";

import {
    buildSafeBashAuditPrompt,
    parseSafeBashAuditArgs,
} from "./audit.ts";
import {
    SAFE_BASH_TELEMETRY_SCHEMA_VERSION,
    type SafeBashTelemetryEvent,
} from "./telemetry/types.ts";

function event(
    sequence: number,
    overrides: Partial<SafeBashTelemetryEvent> = {},
): SafeBashTelemetryEvent {
    return {
        schemaVersion: SAFE_BASH_TELEMETRY_SCHEMA_VERSION,
        eventId: `event-${sequence}`,
        timestamp: `2026-08-25T12:00:0${sequence}.000Z`,
        sessionId: "session-1",
        toolCallId: `call-${sequence}`,
        cwd: "/workspace/project",
        project: "/workspace/project",
        sequence,
        decision: "allowed",
        outcome: "succeeded",
        command: `printf ${sequence}`,
        commandLength: 8,
        ...overrides,
        origin: overrides.origin ?? "safe_bash",
    };
}

describe("safe-bash audit", () => {
    it("parses bounded days and limit overrides", () => {
        expect(
            parseSafeBashAuditArgs("days=7 limit=25", {
                days: 30,
                limit: 100,
            }),
        ).toEqual({ days: 7, limit: 25 });
        expect(() =>
            parseSafeBashAuditArgs("days=0", { days: 30, limit: 100 }),
        ).toThrow("positive integer");
        expect(() =>
            parseSafeBashAuditArgs("unknown=1", { days: 30, limit: 100 }),
        ).toThrow("Unknown");
        expect(() =>
            parseSafeBashAuditArgs("", { days: 366, limit: 100 }),
        ).toThrow("days must not exceed 365");
        expect(() =>
            parseSafeBashAuditArgs("", { days: 30, limit: 501 }),
        ).toThrow("limit must not exceed 500");
    });

    it("builds bounded recommendation-only evidence with suspicious events first", () => {
        const prompt = buildSafeBashAuditPrompt(
            [
                event(1),
                event(2, {
                    decision: "blocked",
                    outcome: "blocked",
                    command: "rm -rf dist",
                    groupId: "rm",
                    patternId: "rm:1",
                }),
                event(3, {
                    command:
                        "python3 -c \"import shutil; shutil.rmtree('dist')\"",
                }),
            ],
            "/workspace/project",
            { days: 30, limit: 100 },
        );

        expect(prompt).toContain("event-2");
        expect(prompt).toContain("event-3");
        expect(prompt.indexOf("event-2")).toBeLessThan(
            prompt.indexOf("event-1"),
        );
        expect(prompt).toContain("Recommendations only");
        expect(prompt).toContain("Do not edit files or execute commands");
        expect(prompt).toContain("BEGIN UNTRUSTED TELEMETRY EVIDENCE");
        expect(prompt).toContain("END UNTRUSTED TELEMETRY EVIDENCE");
        expect(prompt).toContain("distinguish confirmed blocks from suspected bypasses");
        expect(prompt.length).toBeLessThan(60_000);
    });
});
