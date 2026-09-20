import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
    hostExecution,
    parseExecutionProvenance,
    unknownExecution,
} from "./execution-provenance/index.ts";
import type { ExecutionProvenance } from "./execution-provenance/types.ts";

const MANAGED_ARCHIVE_NAME = /^(\d+)-[a-zA-Z0-9_.-]+-[a-f0-9]{12}\.txt$/;

export interface ManagedOutputArchiveMetadataV1 {
    version: 1;
    kind: "output-text";
    toolName: string;
    sourceExecution: ExecutionProvenance;
    storage: ExecutionProvenance;
}

export interface ManagedOutputArchive {
    kind: "output-text";
    path: string;
    sourceExecution: ExecutionProvenance;
    sourceMetadata: "valid" | "missing" | "invalid" | "unavailable";
    storage: ExecutionProvenance;
}

export interface ManagedOutputArchiveNameInput {
    timestamp: number;
    toolName: string;
    toolCallId: string;
    digest: string;
}

function safeNamePart(value: string): string {
    return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function managedOutputArchiveFileName(
    input: ManagedOutputArchiveNameInput,
): string {
    if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0) {
        throw new Error("Archive timestamp must be a non-negative integer");
    }
    if (!/^[a-f0-9]{12}$/.test(input.digest)) {
        throw new Error(
            "Archive digest must contain 12 lowercase hex characters",
        );
    }
    return `${input.timestamp}-${safeNamePart(input.toolName)}-${safeNamePart(input.toolCallId)}-${input.digest}.txt`;
}

export function managedOutputArchiveTimestamp(
    name: string,
): number | undefined {
    const match = MANAGED_ARCHIVE_NAME.exec(name);
    if (!match) return undefined;
    const timestamp = Number(match[1]);
    return Number.isSafeInteger(timestamp) ? timestamp : undefined;
}

export function resolveToolResultArchiveRoot(): string {
    return (
        process.env.PI_TOOL_RESULT_ARCHIVE_DIR?.trim() ||
        join(homedir(), ".pi", "agent", "tool-result-archive")
    );
}

/** Recognize only existing regular files in the configured archive directory. */
export async function managedOutputArchive(
    path: string,
): Promise<ManagedOutputArchive | undefined> {
    const candidate = resolve(path);
    if (managedOutputArchiveTimestamp(basename(candidate)) === undefined)
        return;
    try {
        const root = await realpath(resolveToolResultArchiveRoot());
        if (
            dirname(await realpath(candidate)) !== root ||
            !(await lstat(candidate)).isFile()
        ) {
            return;
        }
        let sourceExecution = unknownExecution();
        let sourceMetadata: ManagedOutputArchive["sourceMetadata"] = "invalid";
        try {
            const stat = await lstat(`${candidate}.meta.json`);
            if (!stat.isFile() || stat.size > 65_536) {
                throw new Error("Invalid archive metadata file");
            }
            const metadata: unknown = JSON.parse(
                await readFile(`${candidate}.meta.json`, "utf8"),
            );
            const parsed =
                metadata &&
                typeof metadata === "object" &&
                "version" in metadata &&
                metadata.version === 1 &&
                "kind" in metadata &&
                metadata.kind === "output-text" &&
                "sourceExecution" in metadata
                    ? parseExecutionProvenance(metadata.sourceExecution)
                    : undefined;
            if (parsed) {
                sourceExecution = parsed;
                sourceMetadata = "valid";
            }
        } catch (error) {
            sourceMetadata =
                error instanceof SyntaxError
                    ? "invalid"
                    : error instanceof Error &&
                        "code" in error &&
                        error.code === "ENOENT"
                      ? "missing"
                      : "unavailable";
        }
        return {
            kind: "output-text",
            path: candidate,
            sourceExecution,
            sourceMetadata,
            storage: hostExecution(),
        };
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
        ) {
            return;
        }
        throw error;
    }
}
