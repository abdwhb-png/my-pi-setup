import { constants, createReadStream, type Dirent } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

import {
    SAFE_BASH_TELEMETRY_SCHEMA_VERSION,
    type SafeBashTelemetryEvent,
} from "./types.ts";

export interface SafeBashTelemetryWriter {
    append(event: SafeBashTelemetryEvent): Promise<void>;
    flush(): Promise<void>;
}

export interface ReadTelemetryOptions {
    days: number;
    limit: number;
    project: string;
    now?: Date;
}

export function resolveTelemetryRoot(directory: string): string {
    if (directory === "~") return homedir();
    if (directory.startsWith("~/")) {
        return resolve(homedir(), directory.slice(2));
    }
    return resolve(directory);
}

function sanitizeSessionId(sessionId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
        throw new Error("Invalid safe-bash telemetry session id");
    }
    return sessionId;
}

function hasErrorCode(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}

async function assertDirectoryWithoutSymlink(path: string): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
        throw new Error(
            `Safe-bash telemetry directory must not be a symbolic link: ${path}`,
        );
    }
    if (!metadata.isDirectory()) {
        throw new Error(`Safe-bash telemetry path is not a directory: ${path}`);
    }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
    try {
        await assertDirectoryWithoutSymlink(path);
    } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error;
        await mkdir(path, { recursive: true, mode: 0o700 });
        await assertDirectoryWithoutSymlink(path);
    }
    await chmod(path, 0o700);
}

function eventDate(timestamp: string): string {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) {
        throw new Error("Invalid safe-bash telemetry timestamp");
    }
    return date.toISOString().slice(0, 10);
}

export function createTelemetryWriter(
    root: string,
    sessionId: string,
): SafeBashTelemetryWriter {
    const resolvedRoot = resolveTelemetryRoot(root);
    const safeSessionId = sanitizeSessionId(sessionId);
    let chain = Promise.resolve();

    const append = (event: SafeBashTelemetryEvent): Promise<void> => {
        const operation = chain.then(async () => {
            const directory = join(resolvedRoot, eventDate(event.timestamp));
            const file = resolve(directory, `${safeSessionId}.jsonl`);
            if (!file.startsWith(`${resolvedRoot}${sep}`)) {
                throw new Error("Safe-bash telemetry path escaped its root");
            }

            await ensurePrivateDirectory(resolvedRoot);
            await ensurePrivateDirectory(directory);
            const handle = await open(
                file,
                constants.O_APPEND |
                    constants.O_CREAT |
                    constants.O_WRONLY |
                    constants.O_NOFOLLOW,
                0o600,
            );
            try {
                const metadata = await handle.stat();
                if (!metadata.isFile()) {
                    throw new Error(
                        "Safe-bash telemetry target is not a regular file",
                    );
                }
                await handle.writeFile(`${JSON.stringify(event)}\n`);
                await handle.chmod(0o600);
            } finally {
                await handle.close();
            }
        });
        chain = operation.catch(() => undefined);
        return operation;
    };

    return {
        append,
        flush: () => chain,
    };
}

function isTelemetryEvent(value: unknown): value is SafeBashTelemetryEvent {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const event = value as Record<string, unknown>;
    return (
        event.schemaVersion === SAFE_BASH_TELEMETRY_SCHEMA_VERSION &&
        typeof event.eventId === "string" &&
        typeof event.timestamp === "string" &&
        typeof event.sessionId === "string" &&
        typeof event.toolCallId === "string" &&
        typeof event.project === "string" &&
        typeof event.sequence === "number" &&
        (event.decision === "allowed" || event.decision === "blocked") &&
        typeof event.commandLength === "number"
    );
}

function auditDateRange(now: Date, days: number): { from: string; to: string } {
    if (!Number.isInteger(days) || days <= 0) {
        throw new Error("Safe-bash telemetry days must be a positive integer");
    }
    const to = now.toISOString().slice(0, 10);
    const fromDate = new Date(`${to}T00:00:00.000Z`);
    fromDate.setUTCDate(fromDate.getUTCDate() - days + 1);
    return { from: fromDate.toISOString().slice(0, 10), to };
}

async function readTelemetryFile(
    file: string,
    project: string,
): Promise<SafeBashTelemetryEvent[]> {
    const events: SafeBashTelemetryEvent[] = [];
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const metadata = await handle.stat();
        if (!metadata.isFile()) return events;
        const lines = createInterface({
            input: createReadStream(file, {
                encoding: "utf8",
                fd: handle.fd,
                autoClose: false,
            }),
            crlfDelay: Number.POSITIVE_INFINITY,
        });
        for await (const line of lines) {
            if (!line.trim()) continue;
            try {
                // oxlint-disable-next-line typescript/no-unsafe-assignment -- validated by isTelemetryEvent before use
                const event = JSON.parse(line);
                if (isTelemetryEvent(event) && event.project === project) {
                    events.push(event);
                }
            } catch {
                // Telemetry is append-only; tolerate a truncated or malformed line.
            }
        }
        return events;
    } finally {
        await handle.close();
    }
}

export async function readRecentTelemetry(
    root: string,
    options: ReadTelemetryOptions,
): Promise<SafeBashTelemetryEvent[]> {
    const resolvedRoot = resolveTelemetryRoot(root);
    const range = auditDateRange(options.now ?? new Date(), options.days);
    let dateEntries: Dirent[];
    try {
        await assertDirectoryWithoutSymlink(resolvedRoot);
        dateEntries = await readdir(resolvedRoot, { withFileTypes: true });
    } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return [];
        throw error;
    }

    const managedDates = dateEntries.filter(
        (entry) =>
            !entry.isSymbolicLink() &&
            entry.isDirectory() &&
            /^\d{4}-\d{2}-\d{2}$/.test(entry.name) &&
            entry.name >= range.from &&
            entry.name <= range.to,
    );
    const eventGroups = await Promise.all(
        managedDates.map(async (dateEntry) => {
            const directory = join(resolvedRoot, dateEntry.name);
            const fileEntries = await readdir(directory, {
                withFileTypes: true,
            });
            const managedFiles = fileEntries.filter(
                (entry) =>
                    !entry.isSymbolicLink() &&
                    entry.isFile() &&
                    entry.name.endsWith(".jsonl"),
            );
            return Promise.all(
                managedFiles.map((entry) =>
                    readTelemetryFile(
                        join(directory, entry.name),
                        options.project,
                    ),
                ),
            );
        }),
    );
    const events = eventGroups
        .flat(2)
        .toSorted((left, right) =>
            left.timestamp === right.timestamp
                ? left.sequence - right.sequence
                : left.timestamp.localeCompare(right.timestamp),
        );
    return events;
}

async function purgeManagedDirectory(
    resolvedRoot: string,
    entry: Dirent,
): Promise<void> {
    const directory = resolve(resolvedRoot, entry.name);
    if (!directory.startsWith(`${resolvedRoot}${sep}`)) return;
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
    await rm(directory, { recursive: true, force: true });
}

export async function purgeExpiredTelemetry(
    root: string,
    retentionDays: number,
    now: Date = new Date(),
): Promise<void> {
    const resolvedRoot = resolveTelemetryRoot(root);
    const { from } = auditDateRange(now, retentionDays);
    let entries: Dirent[];
    try {
        await assertDirectoryWithoutSymlink(resolvedRoot);
        entries = await readdir(resolvedRoot, { withFileTypes: true });
    } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return;
        throw error;
    }

    const expiredDirectories = entries.filter(
        (entry) =>
            !entry.isSymbolicLink() &&
            entry.isDirectory() &&
            /^\d{4}-\d{2}-\d{2}$/.test(entry.name) &&
            entry.name < from,
    );
    await Promise.all(
        expiredDirectories.map((entry) =>
            purgeManagedDirectory(resolvedRoot, entry),
        ),
    );
}
