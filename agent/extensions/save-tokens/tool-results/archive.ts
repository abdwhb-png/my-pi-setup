import { createHash } from "node:crypto";
import {
    chmod,
    copyFile,
    lstat,
    mkdir,
    open,
    readdir,
    unlink,
    writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
    hostExecution,
    unknownExecution,
} from "../../_shared/execution-provenance/index.ts";
import {
    managedOutputArchiveFileName,
    managedOutputArchiveTimestamp,
    resolveToolResultArchiveRoot,
    type ManagedOutputArchiveMetadataV1,
} from "../../_shared/tool-output-archive.ts";
import type { ArchiveOriginalInput } from "./types";

const DAY_MS = 86_400_000;

export {
    managedOutputArchive,
    resolveToolResultArchiveRoot,
} from "../../_shared/tool-output-archive.ts";

export interface ArchivePruneOptions {
    archiveRoot: string;
    maxAgeDays: number;
    maxBytes: number;
    nowMs?: number;
}

export interface ArchivePruneSummary {
    removedFiles: number;
    removedBytes: number;
    remainingBytes: number;
    limitExceeded: boolean;
}

export async function archiveOriginalToolResult(
    input: ArchiveOriginalInput,
): Promise<string> {
    const archiveRoot = resolveToolResultArchiveRoot();
    const digest = createHash("sha256")
        .update(input.sourcePath ?? input.text)
        .digest("hex")
        .slice(0, 12);
    const filePath = join(
        archiveRoot,
        managedOutputArchiveFileName({
            timestamp: Date.now(),
            toolName: input.toolName,
            toolCallId: input.toolCallId,
            digest,
        }),
    );

    await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
    await chmod(archiveRoot, 0o700);
    let ownsText = false;
    let ownsMetadata = false;
    try {
        const reservation = await open(filePath, "wx", 0o600);
        ownsText = true;
        await reservation.close();
        if (input.sourcePath) {
            await copyFile(input.sourcePath, filePath);
            await chmod(filePath, 0o600);
        } else {
            await writeFile(filePath, input.text, {
                encoding: "utf8",
                mode: 0o600,
                flag: "w",
            });
        }
        const metadata = await open(`${filePath}.meta.json`, "wx", 0o600);
        ownsMetadata = true;
        try {
            await metadata.writeFile(
                JSON.stringify({
                    version: 1,
                    kind: "output-text",
                    toolName: input.toolName,
                    sourceExecution:
                        input.sourceExecution ?? unknownExecution(),
                    storage: hostExecution(),
                } satisfies ManagedOutputArchiveMetadataV1),
                "utf8",
            );
        } finally {
            await metadata.close();
        }
    } catch (error) {
        if (ownsText) await unlink(filePath).catch(() => undefined);
        if (ownsMetadata)
            await unlink(`${filePath}.meta.json`).catch(() => undefined);
        throw error;
    }
    return filePath;
}

async function removeArchivePair(path: string): Promise<void> {
    await unlink(`${path}.meta.json`).catch((error) => {
        if (
            !(
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
            )
        )
            throw error;
    });
    await unlink(path);
}

export async function pruneToolResultArchive(
    options: ArchivePruneOptions,
): Promise<ArchivePruneSummary> {
    const nowMs = options.nowMs ?? Date.now();
    const cutoff = nowMs - options.maxAgeDays * DAY_MS;
    let names: string[];
    try {
        names = await readdir(options.archiveRoot);
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
        ) {
            return {
                removedFiles: 0,
                removedBytes: 0,
                remainingBytes: 0,
                limitExceeded: false,
            };
        }
        throw error;
    }

    const managed: Array<{
        name: string;
        path: string;
        timestamp: number;
        size: number;
    }> = [];
    for (const name of names) {
        const timestamp = managedOutputArchiveTimestamp(name);
        if (timestamp === undefined) continue;
        const path = join(options.archiveRoot, name);
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- sequential lstat avoids unbounded file descriptor fan-out
            const stat = await lstat(path);
            if (!stat.isFile()) continue;
            managed.push({
                name,
                path,
                timestamp,
                size:
                    stat.size +
                    (await lstat(`${path}.meta.json`).then(
                        (meta) => (meta.isFile() ? meta.size : 0),
                        () => 0,
                    )),
            });
        } catch {
            // Ignore entries removed concurrently.
        }
    }

    managed.sort(
        (left, right) =>
            left.timestamp - right.timestamp ||
            left.name.localeCompare(right.name),
    );

    let removedFiles = 0;
    let removedBytes = 0;
    const remaining = [] as typeof managed;
    for (const file of managed) {
        if (file.timestamp < cutoff) {
            try {
                // oxlint-disable-next-line eslint/no-await-in-loop -- age pruning is deterministic and best-effort per file
                await removeArchivePair(file.path);
                removedFiles += 1;
                removedBytes += file.size;
            } catch {
                remaining.push(file);
            }
        } else {
            remaining.push(file);
        }
    }

    let remainingBytes = remaining.reduce((sum, file) => sum + file.size, 0);
    while (remainingBytes > options.maxBytes && remaining.length > 1) {
        const oldest = remaining.shift();
        if (!oldest) break;
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- size pruning depends on ordered deletions
            await removeArchivePair(oldest.path);
            removedFiles += 1;
            removedBytes += oldest.size;
            remainingBytes -= oldest.size;
        } catch {
            // A concurrent change should not prevent pruning other files.
        }
    }

    return {
        removedFiles,
        removedBytes,
        remainingBytes,
        limitExceeded: remainingBytes > options.maxBytes,
    };
}
