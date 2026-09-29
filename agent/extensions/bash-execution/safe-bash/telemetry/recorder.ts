import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type {
    CommandExecutionRecord,
    CommandExecutionTelemetryRecorder,
} from "../../../_shared/command-execution/core.ts";
import { redactValue } from "../../../_shared/redaction.ts";
import type { SafeBashTelemetryConfig } from "../config.ts";
import {
    createTelemetryWriter,
    resolveTelemetryRoot,
    type SafeBashTelemetryWriter,
} from "./storage.ts";
import {
    SAFE_BASH_TELEMETRY_SCHEMA_VERSION,
    type SafeBashTelemetryEvent,
} from "./types.ts";

export type SafeBashRecordInput = CommandExecutionRecord<"safe_bash">;

export interface SafeBashTelemetryRecorder extends CommandExecutionTelemetryRecorder<"safe_bash"> {}

export interface SafeBashTelemetryRecorderOptions {
    config: SafeBashTelemetryConfig;
    sessionId: string;
    cwd: string;
    writer?: SafeBashTelemetryWriter;
    clock?: () => Date;
    idGenerator?: () => string;
    sequenceGenerator?: () => number;
    onError?: (message: string) => void;
}

/** Cap on resolved targets kept per event. */
const MAX_RECORDED_TARGETS = 8;

/** Cap on remembered blocked goals per session. */
const BLOCKED_GOAL_LIMIT = 200;

/**
 * Key for a blocked goal: the resolved target set, not the command text.
 *
 * Audit events 558dfd23 and ebf84f73 named the same six files through different
 * groups and different spellings, so neither the group nor the wording may be
 * part of the key.
 */
function blockedGoalKey(input: SafeBashRecordInput): string | undefined {
    if (input.outcome !== "blocked") return undefined;
    const targets = input.targets ?? [];
    if (targets.length > 0) return `targets:${targets.toSorted().join("|")}`;
    const command = input.match?.normalizedCommand ?? input.command;
    return command ? `command:${command}` : undefined;
}

function redactString(value: string, maxStringLength: number): string {
    const redacted = redactValue(value, { maxStringLength }).value;
    return typeof redacted === "string" ? redacted : String(redacted);
}

export function createSafeBashTelemetryRecorder(
    options: SafeBashTelemetryRecorderOptions,
): SafeBashTelemetryRecorder {
    if (!options.config.enabled) {
        return {
            record: async () => undefined,
            flush: async () => undefined,
        };
    }

    let errorReported = false;
    const reportError = (): void => {
        if (errorReported) return;
        errorReported = true;
        options.onError?.(
            "safe-bash telemetry write failed; command enforcement was unaffected",
        );
    };

    let writer: SafeBashTelemetryWriter;
    try {
        writer =
            options.writer ??
            createTelemetryWriter(
                resolveTelemetryRoot(options.config.directory),
                options.sessionId,
            );
    } catch {
        reportError();
        return {
            record: async () => undefined,
            flush: async () => undefined,
        };
    }

    const clock = options.clock ?? (() => new Date());
    const idGenerator = options.idGenerator ?? randomUUID;
    const project = resolve(options.cwd);
    let sequence = 0;
    const nextSequence = options.sequenceGenerator ?? (() => ++sequence);
    /** Blocked goal key → the event that last hit it, in insertion order. */
    const blockedGoals = new Map<string, string>();

    return {
        async record(input) {
            const event: SafeBashTelemetryEvent = {
                schemaVersion: SAFE_BASH_TELEMETRY_SCHEMA_VERSION,
                eventId: idGenerator(),
                timestamp: clock().toISOString(),
                sessionId: options.sessionId,
                origin: input.operation,
                toolCallId: input.toolCallId,
                cwd: options.cwd,
                project,
                sequence: nextSequence(),
                decision:
                    input.decision ?? (input.match ? "blocked" : "allowed"),
                outcome: input.outcome,
                commandLength: input.command.length,
            };
            if (options.config.captureCommand) {
                event.command = redactString(
                    input.command,
                    options.config.maxCommandLength,
                );
            }
            if (input.match) {
                event.groupId = input.match.groupId;
                event.patternId = input.match.patternId;
                event.reason = input.reason ?? input.match.message;
            } else {
                if (input.groupId) event.groupId = input.groupId;
                if (input.patternId) event.patternId = input.patternId;
                if (input.reason) event.reason = input.reason;
            }
            if (input.error) {
                event.error = redactString(
                    input.error,
                    options.config.maxCommandLength,
                );
            }
            if (input.policy) event.policy = input.policy;
            if (input.scopeVerdict) event.scopeVerdict = input.scopeVerdict;
            if (input.targets && input.targets.length > 0) {
                event.targets = input.targets
                    .slice(0, MAX_RECORDED_TARGETS)
                    .map((target) =>
                        redactString(target, options.config.maxCommandLength),
                    );
            }
            const goalKey = blockedGoalKey(input);
            if (goalKey) {
                const previous = blockedGoals.get(goalKey);
                if (previous) event.repeatOfEventId = previous;
                // Re-insert so eviction drops the least recently blocked goal.
                blockedGoals.delete(goalKey);
                blockedGoals.set(goalKey, event.eventId);
                if (blockedGoals.size > BLOCKED_GOAL_LIMIT) {
                    const oldest = blockedGoals.keys().next().value;
                    if (oldest !== undefined) blockedGoals.delete(oldest);
                }
            }
            try {
                await writer.append(event);
            } catch {
                reportError();
            }
        },
        async flush() {
            try {
                await writer.flush();
            } catch {
                reportError();
            }
        },
    };
}
