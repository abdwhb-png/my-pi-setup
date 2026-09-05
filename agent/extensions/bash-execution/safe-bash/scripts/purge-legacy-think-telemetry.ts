import { randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import {
    chmod,
    lstat,
    open,
    readdir,
    rename,
    rmdir,
    unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

const MANAGED_DATE = /^\d{4}-\d{2}-\d{2}$/;
const THINK_ORIGINS = new Set(["think_execute", "think_batch_execute"]);

export interface PurgeLegacyThinkOptions {
    apply: boolean;
}

export interface PurgeLegacyThinkSummary {
    apply: boolean;
    filesScanned: number;
    filesChanged: number;
    filesDeleted: number;
    directoriesDeleted: number;
    thinkEventsRemoved: number;
    preservedLines: number;
}

interface FilePlan {
    path: string;
    replacement: string;
    thinkEvents: number;
    preservedLines: number;
    deleteFile: boolean;
}

function hasErrorCode(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}

function isThinkEvent(line: string): boolean {
    if (!line.trim()) return false;
    try {
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- origin is validated before use
        const value = JSON.parse(line);
        return (
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value) &&
            "origin" in value &&
            THINK_ORIGINS.has((value as { origin?: unknown }).origin as string)
        );
    } catch {
        return false;
    }
}

async function planFile(path: string): Promise<FilePlan | null> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const metadata = await handle.stat();
        if (!metadata.isFile()) return null;
        const content = await handle.readFile({ encoding: "utf8" });
        const endedWithNewline = content.endsWith("\n");
        const lines = content.split("\n");
        if (endedWithNewline) lines.pop();

        const kept: string[] = [];
        let thinkEvents = 0;
        let preservedLines = 0;
        for (const line of lines) {
            if (isThinkEvent(line)) {
                thinkEvents += 1;
                continue;
            }
            kept.push(line);
            if (line.trim()) preservedLines += 1;
        }
        if (thinkEvents === 0) {
            return {
                path,
                replacement: content,
                thinkEvents,
                preservedLines,
                deleteFile: false,
            };
        }
        const replacement =
            kept.length === 0
                ? ""
                : `${kept.join("\n")}${endedWithNewline ? "\n" : ""}`;
        return {
            path,
            replacement,
            thinkEvents,
            preservedLines,
            deleteFile: replacement.length === 0,
        };
    } finally {
        await handle.close();
    }
}

async function rewriteAtomically(path: string, content: string): Promise<void> {
    const temporary = join(
        dirname(path),
        `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let created = false;
    try {
        const handle = await open(
            temporary,
            constants.O_CREAT |
                constants.O_EXCL |
                constants.O_WRONLY |
                constants.O_NOFOLLOW,
            0o600,
        );
        created = true;
        try {
            await handle.writeFile(content);
            await handle.chmod(0o600);
            await handle.sync();
        } finally {
            await handle.close();
        }
        await rename(temporary, path);
        created = false;
        await chmod(path, 0o600);
    } finally {
        if (created) await unlink(temporary).catch(() => undefined);
    }
}

function isManagedFile(entry: Dirent): boolean {
    return (
        !entry.isSymbolicLink() &&
        entry.isFile() &&
        entry.name.endsWith(".jsonl")
    );
}

export async function purgeLegacyThinkEvents(
    root: string,
    options: PurgeLegacyThinkOptions,
): Promise<PurgeLegacyThinkSummary> {
    const resolvedRoot = resolve(root);
    const summary: PurgeLegacyThinkSummary = {
        apply: options.apply,
        filesScanned: 0,
        filesChanged: 0,
        filesDeleted: 0,
        directoriesDeleted: 0,
        thinkEventsRemoved: 0,
        preservedLines: 0,
    };

    let rootMetadata;
    try {
        rootMetadata = await lstat(resolvedRoot);
    } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return summary;
        throw error;
    }
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
        throw new Error("Safe-bash telemetry root must be a real directory");
    }

    const dates = (await readdir(resolvedRoot, { withFileTypes: true })).filter(
        (entry) =>
            !entry.isSymbolicLink() &&
            entry.isDirectory() &&
            MANAGED_DATE.test(entry.name),
    );
    for (const date of dates) {
        const directory = resolve(resolvedRoot, date.name);
        if (!directory.startsWith(`${resolvedRoot}${sep}`)) continue;
        const entries = await readdir(directory, { withFileTypes: true });
        const deletedNames = new Set<string>();
        for (const entry of entries.filter(isManagedFile)) {
            const path = join(directory, entry.name);
            const plan = await planFile(path);
            if (!plan) continue;
            summary.filesScanned += 1;
            summary.thinkEventsRemoved += plan.thinkEvents;
            summary.preservedLines += plan.preservedLines;
            if (plan.thinkEvents === 0) continue;
            summary.filesChanged += 1;
            if (plan.deleteFile) {
                summary.filesDeleted += 1;
                deletedNames.add(entry.name);
                if (options.apply) await unlink(path);
            } else if (options.apply) {
                await rewriteAtomically(path, plan.replacement);
            }
        }

        const wouldBeEmpty = entries.every((entry) =>
            deletedNames.has(entry.name),
        );
        if (!wouldBeEmpty) continue;
        if (options.apply) {
            try {
                await rmdir(directory);
            } catch (error) {
                if (!hasErrorCode(error, "ENOTEMPTY")) throw error;
                continue;
            }
        }
        summary.directoriesDeleted += 1;
    }
    return summary;
}

export function formatPurgeSummary(summary: PurgeLegacyThinkSummary): string {
    return [
        `mode=${summary.apply ? "apply" : "dry-run"}`,
        `files_scanned=${summary.filesScanned}`,
        `files_changed=${summary.filesChanged}`,
        `files_deleted=${summary.filesDeleted}`,
        `directories_deleted=${summary.directoriesDeleted}`,
        `think_events_removed=${summary.thinkEventsRemoved}`,
        `preserved_lines=${summary.preservedLines}`,
    ].join(" ");
}

async function main(args: string[]): Promise<void> {
    if (args.includes("--help")) {
        console.log(
            "Usage: bun purge-legacy-think-telemetry.ts [--apply]\nDefault: dry-run. The target is ~/.pi/agent/safe-bash-telemetry.",
        );
        return;
    }
    if (args.length > 1 || (args.length === 1 && args[0] !== "--apply")) {
        throw new Error("Only the explicit --apply option is supported");
    }
    const root = join(homedir(), ".pi", "agent", "safe-bash-telemetry");
    const summary = await purgeLegacyThinkEvents(root, {
        apply: args[0] === "--apply",
    });
    console.log(formatPurgeSummary(summary));
}

if (import.meta.main) {
    await main(process.argv.slice(2));
}
