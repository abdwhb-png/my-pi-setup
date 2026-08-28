import { describe, expect, it, mock } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    AUTOPILOT_TELEMETRY_ENTRY,
    AUTOPILOT_TELEMETRY_SCHEMA_VERSION,
    createTelemetryRecorder,
    type AutopilotTelemetryEvent,
} from "./telemetry.ts";

const FORBIDDEN_KEYS = new Set([
    "title",
    "message",
    "prompt",
    "options",
    "answer",
    "input",
    "command",
    "content",
    "details",
]);

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
    if (Array.isArray(value)) {
        for (const item of value) collectKeys(item, keys);
        return keys;
    }
    if (typeof value !== "object" || value === null) return keys;

    for (const [key, item] of Object.entries(value)) {
        keys.add(key);
        collectKeys(item, keys);
    }
    return keys;
}

describe("pi-dangerous-mode Autopilot telemetry", () => {
    it("appends versioned metadata-only session records", () => {
        const appendEntry = mock((_type: string, _data: unknown) => undefined);
        const record = createTelemetryRecorder(
            appendEntry as ExtensionAPI["appendEntry"],
            () => Date.parse("2026-08-24T12:00:00.000Z"),
        );
        const events: AutopilotTelemetryEvent[] = [
            {
                event: "mode_change",
                mode: "autopilot",
                source: "command",
                enabled: true,
            },
            {
                event: "prompt_blocked",
                kind: "select",
                agentActive: true,
            },
            {
                event: "guard_blocked",
                category: "deploy",
                toolName: "deploy_service",
            },
            {
                event: "turn_recorded",
                turnsUsed: 1,
                retriesUsed: 0,
                hadError: false,
            },
            { event: "continuation_queued", reason: "continue" },
            { event: "completed", outcome: "completed" },
            { event: "stopped", reason: "turn_budget" },
        ];

        for (const event of events) record(event);

        expect(AUTOPILOT_TELEMETRY_ENTRY).toBe("pi:autopilot:telemetry");
        expect(AUTOPILOT_TELEMETRY_SCHEMA_VERSION).toBe(1);
        expect(appendEntry).toHaveBeenCalledTimes(events.length);
        for (const [index, event] of events.entries()) {
            const [entryType, data] = appendEntry.mock.calls[index] as [
                string,
                Record<string, unknown>,
            ];
            expect(entryType).toBe(AUTOPILOT_TELEMETRY_ENTRY);
            expect(data).toMatchObject({
                schemaVersion: 1,
                timestamp: "2026-08-24T12:00:00.000Z",
                event: event.event,
            });
            const keys = collectKeys(data);
            for (const forbidden of FORBIDDEN_KEYS) {
                expect(keys.has(forbidden)).toBe(false);
            }
        }
    });

    it("does not let telemetry failures break mode control", () => {
        const appendEntry = mock((_type: string, _data: unknown) => {
            throw new Error("session closed");
        });
        const record = createTelemetryRecorder(
            appendEntry as ExtensionAPI["appendEntry"],
        );

        expect(() =>
            record({
                event: "mode_change",
                mode: "dangerous",
                source: "flag",
                enabled: true,
            }),
        ).not.toThrow();
    });
});
