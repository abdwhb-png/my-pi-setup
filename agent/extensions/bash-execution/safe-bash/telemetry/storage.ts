import {
    createPrivateTelemetryWriter,
    purgeExpiredPrivateTelemetry,
    readRecentPrivateTelemetry,
    resolvePrivateTelemetryRoot,
    type PrivateTelemetryWriter,
} from "../../../_shared/private-telemetry/storage.ts";

import {
    SAFE_BASH_TELEMETRY_SCHEMA_VERSION,
    type SafeBashTelemetryEvent,
} from "./types.ts";

export type SafeBashTelemetryWriter =
    PrivateTelemetryWriter<SafeBashTelemetryEvent>;

export interface ReadTelemetryOptions {
    days: number;
    limit: number;
    project: string;
    now?: Date;
}

export const resolveTelemetryRoot = resolvePrivateTelemetryRoot;

export function createTelemetryWriter(
    root: string,
    sessionId: string,
): SafeBashTelemetryWriter {
    return createPrivateTelemetryWriter({
        root,
        sessionId,
        scopeName: "Safe-bash",
        timestampOf: (event: SafeBashTelemetryEvent) => event.timestamp,
    });
}

function parseTelemetryEvent(value: unknown): SafeBashTelemetryEvent | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
    }
    const event = value as Record<string, unknown>;
    if (
        (event.schemaVersion !== 1 &&
            event.schemaVersion !== SAFE_BASH_TELEMETRY_SCHEMA_VERSION) ||
        typeof event.eventId !== "string" ||
        typeof event.timestamp !== "string" ||
        typeof event.sessionId !== "string" ||
        typeof event.toolCallId !== "string" ||
        typeof event.cwd !== "string" ||
        typeof event.project !== "string" ||
        typeof event.sequence !== "number" ||
        (event.decision !== "allowed" && event.decision !== "blocked") ||
        (event.outcome !== "blocked" &&
            event.outcome !== "succeeded" &&
            event.outcome !== "failed" &&
            event.outcome !== "aborted") ||
        typeof event.commandLength !== "number"
    ) {
        return null;
    }

    if (event.origin !== undefined && event.origin !== "safe_bash") {
        return null;
    }
    if (event.schemaVersion !== 1 && event.origin !== "safe_bash") {
        return null;
    }

    return {
        schemaVersion: SAFE_BASH_TELEMETRY_SCHEMA_VERSION,
        eventId: event.eventId,
        timestamp: event.timestamp,
        sessionId: event.sessionId,
        origin: "safe_bash",
        toolCallId: event.toolCallId,
        cwd: event.cwd,
        project: event.project,
        sequence: event.sequence,
        decision: event.decision,
        outcome: event.outcome,
        commandLength: event.commandLength,
        ...(typeof event.command === "string"
            ? { command: event.command }
            : {}),
        ...(typeof event.groupId === "string"
            ? { groupId: event.groupId }
            : {}),
        ...(typeof event.patternId === "string"
            ? { patternId: event.patternId }
            : {}),
        ...(typeof event.reason === "string" ? { reason: event.reason } : {}),
        ...(typeof event.error === "string" ? { error: event.error } : {}),
    };
}

export function readRecentTelemetry(
    root: string,
    options: ReadTelemetryOptions,
): Promise<SafeBashTelemetryEvent[]> {
    return readRecentPrivateTelemetry({
        root,
        days: options.days,
        project: options.project,
        scopeName: "Safe-bash",
        parseEvent: parseTelemetryEvent,
        projectOf: (event) => event.project,
        timestampOf: (event) => event.timestamp,
        sequenceOf: (event) => event.sequence,
        ...(options.now ? { now: options.now } : {}),
    });
}

export function purgeExpiredTelemetry(
    root: string,
    retentionDays: number,
    now: Date = new Date(),
): Promise<void> {
    return purgeExpiredPrivateTelemetry(root, retentionDays, "Safe-bash", now);
}
