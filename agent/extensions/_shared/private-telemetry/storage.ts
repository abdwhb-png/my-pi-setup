import { constants, createReadStream, type Dirent } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

export interface PrivateTelemetryWriter<Event> {
    append(event: Event): Promise<void>;
    flush(): Promise<void>;
}

export interface PrivateTelemetryWriterOptions<Event> {
    root: string;
    sessionId: string;
    scopeName: string;
    timestampOf(event: Event): string;
}

export interface ReadPrivateTelemetryOptions<Event> {
    root: string;
    days: number;
    project: string;
    scopeName: string;
    parseEvent(value: unknown): Event | null;
    projectOf(event: Event): string;
    timestampOf(event: Event): string;
    sequenceOf(event: Event): number;
    now?: Date;
}

export function resolvePrivateTelemetryRoot(directory: string): string {
    if (directory === "~") return homedir();
    if (directory.startsWith("~/")) {
        return resolve(homedir(), directory.slice(2));
    }
    return resolve(directory);
}

function sanitizeSessionId(sessionId: string, scopeName: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
        throw new Error(`Invalid ${scopeName} telemetry session id`);
    }
    return sessionId;
}

function hasErrorCode(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}

async function assertDirectoryWithoutSymlink(
    path: string,
    scopeName: string,
): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
        throw new Error(
            `${scopeName} telemetry directory must not be a symbolic link: ${path}`,
        );
    }
    if (!metadata.isDirectory()) {
        throw new Error(
            `${scopeName} telemetry path is not a directory: ${path}`,
        );
    }
}

async function ensurePrivateDirectory(
    path: string,
    scopeName: string,
): Promise<void> {
    try {
        await assertDirectoryWithoutSymlink(path, scopeName);
    } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error;
        await mkdir(path, { recursive: true, mode: 0o700 });
        await assertDirectoryWithoutSymlink(path, scopeName);
    }
    await chmod(path, 0o700);
}

function eventDate(timestamp: string, scopeName: string): string {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) {
        throw new Error(`Invalid ${scopeName} telemetry timestamp`);
    }
    return date.toISOString().slice(0, 10);
}

export function createPrivateTelemetryWriter<Event>(
    options: PrivateTelemetryWriterOptions<Event>,
): PrivateTelemetryWriter<Event> {
    const resolvedRoot = resolvePrivateTelemetryRoot(options.root);
    const sessionId = sanitizeSessionId(options.sessionId, options.scopeName);
    let chain = Promise.resolve();

    const append = (event: Event): Promise<void> => {
        const operation = chain.then(async () => {
            const directory = join(
                resolvedRoot,
                eventDate(options.timestampOf(event), options.scopeName),
            );
            const file = resolve(directory, `${sessionId}.jsonl`);
            if (!file.startsWith(`${resolvedRoot}${sep}`)) {
                throw new Error(
                    `${options.scopeName} telemetry path escaped its root`,
                );
            }

            await ensurePrivateDirectory(resolvedRoot, options.scopeName);
            await ensurePrivateDirectory(directory, options.scopeName);
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
                        `${options.scopeName} telemetry target is not a regular file`,
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

    return { append, flush: () => chain };
}

function auditDateRange(
    now: Date,
    days: number,
    scopeName: string,
): { from: string; to: string } {
    if (!Number.isInteger(days) || days <= 0) {
        throw new Error(
            `${scopeName} telemetry days must be a positive integer`,
        );
    }
    const to = now.toISOString().slice(0, 10);
    const fromDate = new Date(`${to}T00:00:00.000Z`);
    fromDate.setUTCDate(fromDate.getUTCDate() - days + 1);
    return { from: fromDate.toISOString().slice(0, 10), to };
}

async function readTelemetryFile<Event>(
    file: string,
    options: ReadPrivateTelemetryOptions<Event>,
): Promise<Event[]> {
    const events: Event[] = [];
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
                // oxlint-disable-next-line typescript/no-unsafe-assignment -- parseEvent validates unknown JSON before use
                const event = options.parseEvent(JSON.parse(line));
                if (event && options.projectOf(event) === options.project) {
                    events.push(event);
                }
            } catch {
                // Append-only logs may end with a truncated or malformed line.
            }
        }
        return events;
    } finally {
        await handle.close();
    }
}

export async function readRecentPrivateTelemetry<Event>(
    options: ReadPrivateTelemetryOptions<Event>,
): Promise<Event[]> {
    const resolvedRoot = resolvePrivateTelemetryRoot(options.root);
    const range = auditDateRange(
        options.now ?? new Date(),
        options.days,
        options.scopeName,
    );
    let dateEntries: Dirent[];
    try {
        await assertDirectoryWithoutSymlink(resolvedRoot, options.scopeName);
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
                    readTelemetryFile(join(directory, entry.name), options),
                ),
            );
        }),
    );
    return eventGroups.flat(2).toSorted((left, right) => {
        const leftTimestamp = options.timestampOf(left);
        const rightTimestamp = options.timestampOf(right);
        return leftTimestamp === rightTimestamp
            ? options.sequenceOf(left) - options.sequenceOf(right)
            : leftTimestamp.localeCompare(rightTimestamp);
    });
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

export async function purgeExpiredPrivateTelemetry(
    root: string,
    retentionDays: number,
    scopeName: string,
    now: Date = new Date(),
): Promise<void> {
    const resolvedRoot = resolvePrivateTelemetryRoot(root);
    const { from } = auditDateRange(now, retentionDays, scopeName);
    let entries: Dirent[];
    try {
        await assertDirectoryWithoutSymlink(resolvedRoot, scopeName);
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
