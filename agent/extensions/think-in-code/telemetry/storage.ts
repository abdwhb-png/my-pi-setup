import {
    createPrivateTelemetryWriter,
    purgeExpiredPrivateTelemetry,
    readRecentPrivateTelemetry,
    type PrivateTelemetryWriter,
} from "../../_shared/private-telemetry/storage.ts";

import {
    THINK_TELEMETRY_SCHEMA_VERSION,
    type ThinkTelemetryEvent,
    type ThinkTelemetryOrigin,
} from "./types.ts";

export type ThinkTelemetryWriter = PrivateTelemetryWriter<ThinkTelemetryEvent>;

export interface ReadThinkTelemetryOptions {
    days: number;
    project: string;
    now?: Date;
}

export function createThinkTelemetryWriter(
    root: string,
    sessionId: string,
): ThinkTelemetryWriter {
    return createPrivateTelemetryWriter({
        root,
        sessionId,
        scopeName: "Think-in-Code",
        timestampOf: (event: ThinkTelemetryEvent) => event.timestamp,
    });
}

function isThinkOrigin(value: unknown): value is ThinkTelemetryOrigin {
    return value === "think_execute" || value === "think_batch_execute";
}

function parseThinkTelemetryEvent(value: unknown): ThinkTelemetryEvent | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
    }
    const event = value as Record<string, unknown>;
    if (
        event.schemaVersion !== THINK_TELEMETRY_SCHEMA_VERSION ||
        typeof event.eventId !== "string" ||
        typeof event.timestamp !== "string" ||
        typeof event.sessionId !== "string" ||
        !isThinkOrigin(event.origin) ||
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

    return {
        schemaVersion: THINK_TELEMETRY_SCHEMA_VERSION,
        eventId: event.eventId,
        timestamp: event.timestamp,
        sessionId: event.sessionId,
        origin: event.origin,
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

export function readRecentThinkTelemetry(
    root: string,
    options: ReadThinkTelemetryOptions,
): Promise<ThinkTelemetryEvent[]> {
    return readRecentPrivateTelemetry({
        root,
        days: options.days,
        project: options.project,
        scopeName: "Think-in-Code",
        parseEvent: parseThinkTelemetryEvent,
        projectOf: (event) => event.project,
        timestampOf: (event) => event.timestamp,
        sequenceOf: (event) => event.sequence,
        ...(options.now ? { now: options.now } : {}),
    });
}

export function purgeExpiredThinkTelemetry(
    root: string,
    retentionDays: number,
    now: Date = new Date(),
): Promise<void> {
    return purgeExpiredPrivateTelemetry(
        root,
        retentionDays,
        "Think-in-Code",
        now,
    );
}
