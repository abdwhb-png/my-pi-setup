/// <reference types="bun" />

import { describe, expect, it, mock } from "bun:test";

import type { DangerMatch } from "../../../_shared/command-execution/guard.ts";
import { DEFAULT_SAFE_BASH_CONFIG } from "../config.ts";
import { createSafeBashTelemetryRecorder } from "./recorder.ts";
import type { SafeBashTelemetryEvent } from "./types.ts";

const deletionMatch: DangerMatch = {
    groupId: "file-delete-api",
    groupLabel: "interpreter one-liner direct filesystem deletion APIs",
    patternId: "file-delete-api:1",
    pattern: "/shutil\\.rmtree/",
    normalizedCommand: "python3 -c ...",
    message: "Command blocked by safe_bash",
};

describe("safe-bash telemetry recorder", () => {
    it("records a redacted blocked attempt with structured guard evidence", async () => {
        const events: SafeBashTelemetryEvent[] = [];
        const writer = {
            append: mock(async (event: SafeBashTelemetryEvent) => {
                events.push(event);
            }),
            flush: mock(async () => undefined),
        };
        const recorder = createSafeBashTelemetryRecorder({
            config: {
                ...DEFAULT_SAFE_BASH_CONFIG.telemetry,
                maxCommandLength: 40,
            },
            sessionId: "session-1",
            cwd: "/workspace/project",
            writer,
            clock: () => new Date("2026-08-25T12:00:00.000Z"),
            idGenerator: () => "event-1",
        });

        await recorder.record({
            operation: "safe_bash",
            toolCallId: "call-1",
            command:
                "export API_KEY=sk-secretsecret; python3 -c \"import shutil; shutil.rmtree('dist')\"",
            match: deletionMatch,
            outcome: "blocked",
        });

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            schemaVersion: 2,
            origin: "safe_bash",
            eventId: "event-1",
            sessionId: "session-1",
            toolCallId: "call-1",
            project: "/workspace/project",
            decision: "blocked",
            outcome: "blocked",
            command: "[REDACTED]",
            groupId: "file-delete-api",
            patternId: "file-delete-api:1",
        });
        expect(events[0]?.commandLength).toBeGreaterThan(40);
    });

    it("preserves an explicit denial reason with guard evidence", async () => {
        const events: SafeBashTelemetryEvent[] = [];
        const recorder = createSafeBashTelemetryRecorder({
            config: DEFAULT_SAFE_BASH_CONFIG.telemetry,
            sessionId: "session-1",
            cwd: "/workspace/project",
            writer: {
                append: async (event) => {
                    events.push(event);
                },
                flush: async () => undefined,
            },
        });

        await recorder.record({
            operation: "safe_bash",
            toolCallId: "call-denied",
            command: "python3 -c ...",
            match: deletionMatch,
            outcome: "blocked",
            reason: "not during release",
        });

        expect(events[0]).toMatchObject({
            groupId: "file-delete-api",
            patternId: "file-delete-api:1",
            reason: "not during release",
        });
    });

    it("uses an injected session sequence across recorder recreation", async () => {
        const events: SafeBashTelemetryEvent[] = [];
        let sequence = 40;
        const recorder = createSafeBashTelemetryRecorder({
            config: DEFAULT_SAFE_BASH_CONFIG.telemetry,
            sessionId: "session-1",
            cwd: "/workspace/project",
            writer: {
                append: async (event) => {
                    events.push(event);
                },
                flush: async () => undefined,
            },
            sequenceGenerator: () => ++sequence,
        });

        await recorder.record({
            operation: "safe_bash",
            toolCallId: "call-1",
            command: "printf ok",
            match: null,
            outcome: "succeeded",
        });

        expect(events[0]?.sequence).toBe(41);
    });

    it("records non-danger policy blocks without misclassifying them as allowed", async () => {
        const events: SafeBashTelemetryEvent[] = [];
        const recorder = createSafeBashTelemetryRecorder({
            config: DEFAULT_SAFE_BASH_CONFIG.telemetry,
            sessionId: "session-1",
            cwd: "/workspace/project",
            writer: {
                append: async (event) => {
                    events.push(event);
                },
                flush: async () => undefined,
            },
        });

        await recorder.record({
            operation: "safe_bash",
            toolCallId: "call-redirect",
            command: "find . -name '*.ts'",
            match: null,
            decision: "blocked",
            outcome: "blocked",
            groupId: "native-tool-redirect",
            reason: "Use native find tool",
        });

        expect(events[0]).toMatchObject({
            decision: "blocked",
            outcome: "blocked",
            groupId: "native-tool-redirect",
            reason: "Use native find tool",
        });
    });

    it("degrades to a no-op when telemetry writer initialization fails", async () => {
        const onError = mock((_message: string) => undefined);
        const recorder = createSafeBashTelemetryRecorder({
            config: DEFAULT_SAFE_BASH_CONFIG.telemetry,
            sessionId: "../invalid",
            cwd: "/workspace/project",
            onError,
        });

        await recorder.record({
            operation: "safe_bash",
            toolCallId: "call-1",
            command: "printf ok",
            match: null,
            outcome: "succeeded",
        });

        expect(onError).toHaveBeenCalledTimes(1);
    });

    it("records guard policy, scope verdict, and resolved targets", async () => {
        const events: SafeBashTelemetryEvent[] = [];
        const recorder = createSafeBashTelemetryRecorder({
            config: DEFAULT_SAFE_BASH_CONFIG.telemetry,
            sessionId: "session-1",
            cwd: "/workspace/project",
            writer: {
                append: async (event) => {
                    events.push(event);
                },
                flush: async () => undefined,
            },
            clock: () => new Date("2026-08-25T12:00:00.000Z"),
            idGenerator: () => "event-1",
        });

        await recorder.record({
            operation: "safe_bash",
            toolCallId: "call-1",
            command: "rm /etc/hosts",
            match: deletionMatch,
            outcome: "blocked",
            policy: "cwd-only",
            scopeVerdict: "outside",
            targets: ["/etc/hosts", "/etc/passwd"],
        });

        expect(events[0]).toMatchObject({
            policy: "cwd-only",
            scopeVerdict: "outside",
            targets: ["/etc/hosts", "/etc/passwd"],
        });
    });

    it("links a repeated blocked target set to the earlier event", async () => {
        const events: SafeBashTelemetryEvent[] = [];
        let n = 0;
        const recorder = createSafeBashTelemetryRecorder({
            config: DEFAULT_SAFE_BASH_CONFIG.telemetry,
            sessionId: "session-1",
            cwd: "/workspace/project",
            writer: {
                append: async (event) => {
                    events.push(event);
                },
                flush: async () => undefined,
            },
            idGenerator: () => `event-${++n}`,
        });
        const goal = [
            "/workspace/project/autopilot-loop.ts",
            "/workspace/project/guard-policy.ts",
        ];

        // Audit events 558dfd23 → ebf84f73: the same files, a different group
        // and different wording, eight seconds apart.
        await recorder.record({
            operation: "safe_bash",
            toolCallId: "call-1",
            command: "rm autopilot-loop.ts guard-policy.ts",
            match: deletionMatch,
            outcome: "blocked",
            policy: "cwd-only",
            scopeVerdict: "inside",
            targets: goal,
        });
        await recorder.record({
            operation: "safe_bash",
            toolCallId: "call-2",
            command: "python3 - <<'PY' Path('guard-policy.ts').unlink() PY",
            match: deletionMatch,
            outcome: "blocked",
            policy: "cwd-only",
            scopeVerdict: "inside",
            targets: [...goal].reverse(),
        });

        expect(events[0]?.repeatOfEventId).toBeUndefined();
        expect(events[1]?.repeatOfEventId).toBe("event-1");
    });

    it("does not link a different target set", async () => {
        const events: SafeBashTelemetryEvent[] = [];
        let n = 0;
        const recorder = createSafeBashTelemetryRecorder({
            config: DEFAULT_SAFE_BASH_CONFIG.telemetry,
            sessionId: "session-1",
            cwd: "/workspace/project",
            writer: {
                append: async (event) => {
                    events.push(event);
                },
                flush: async () => undefined,
            },
            idGenerator: () => `event-${++n}`,
        });

        for (const [call, target] of [
            ["call-1", "/workspace/project/a.ts"],
            ["call-2", "/workspace/project/b.ts"],
        ] as const) {
            await recorder.record({
                operation: "safe_bash",
                toolCallId: call,
                command: `rm ${target}`,
                match: deletionMatch,
                outcome: "blocked",
                policy: "cwd-only",
                scopeVerdict: "inside",
                targets: [target],
            });
        }

        expect(events[1]?.repeatOfEventId).toBeUndefined();
    });

    it("does not let writer failures alter command behavior", async () => {
        const recorder = createSafeBashTelemetryRecorder({
            config: DEFAULT_SAFE_BASH_CONFIG.telemetry,
            sessionId: "session-1",
            cwd: "/workspace/project",
            writer: {
                append: async () => {
                    throw new Error("disk full");
                },
                flush: async () => undefined,
            },
        });

        await expect(
            recorder.record({
                operation: "safe_bash",
                toolCallId: "call-1",
                command: "printf ok",
                match: null,
                outcome: "succeeded",
            }),
        ).resolves.toBeUndefined();
    });
});
