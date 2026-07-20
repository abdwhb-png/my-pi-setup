import { createHash } from 'node:crypto';
import {
    copyFile,
    lstat,
    mkdir,
    readdir,
    unlink,
    writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ArchiveOriginalInput } from './types';

const MANAGED_ARCHIVE_NAME = /^(\d+)-[a-zA-Z0-9_.-]+-[a-f0-9]{12}\.txt$/;
const DAY_MS = 86_400_000;

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

export function resolveToolResultArchiveRoot(): string {
    return (
        process.env.PI_TOOL_RESULT_ARCHIVE_DIR?.trim() ||
        join(homedir(), '.pi', 'agent', 'tool-result-archive')
    );
}

export async function archiveOriginalToolResult(
    input: ArchiveOriginalInput,
): Promise<string> {
    const archiveRoot = resolveToolResultArchiveRoot();
    const digest = createHash('sha256')
        .update(input.sourcePath ?? input.text)
        .digest('hex')
        .slice(0, 12);
    const safeToolCallId = input.toolCallId.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const safeToolName = input.toolName.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const filePath = join(
        archiveRoot,
        `${Date.now()}-${safeToolName}-${safeToolCallId}-${digest}.txt`,
    );

    await mkdir(archiveRoot, { recursive: true });
    try {
        if (input.sourcePath) {
            await copyFile(input.sourcePath, filePath);
        } else {
            await writeFile(filePath, input.text, 'utf8');
        }
    } catch (error) {
        await unlink(filePath).catch(() => undefined);
        throw error;
    }
    return filePath;
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
            'code' in error &&
            error.code === 'ENOENT'
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
        const match = MANAGED_ARCHIVE_NAME.exec(name);
        if (!match) continue;
        const path = join(options.archiveRoot, name);
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- sequential lstat avoids unbounded file descriptor fan-out
            const stat = await lstat(path);
            if (!stat.isFile()) continue;
            managed.push({
                name,
                path,
                timestamp: Number(match[1]),
                size: stat.size,
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
                await unlink(file.path);
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
            await unlink(oldest.path);
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
