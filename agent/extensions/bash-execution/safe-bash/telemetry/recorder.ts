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
