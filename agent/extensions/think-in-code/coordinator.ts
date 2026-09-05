/**
 * Think-in-Code coordinator.
 *
 * Owns the policy and orchestration for the three public `think_*` tools:
 *   - think_execute: command | content | archives | file | batch + analyzer
 *   - think_note: explicit bounded text with optional archive provenance
 *   - think_search: bounded snippets + archive IDs (never raw bytes)
 *
 * Raw sources remain in archives and are reanalyzable via archive IDs. The
 * LLM sees only bounded analyzer output, which remains model-controlled and
 * can contain source bytes when a program deliberately copies them.
 *
 * Capture/index failures are fail-open but visible in tool details.
 * Safe-execution and analysis-sandbox failures are fail-closed.
 */

import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { performance } from "node:perf_hooks";

import type {
    AgentToolUpdateCallback,
    ExtensionContext,
    TruncationResult,
} from "@earendil-works/pi-coding-agent";

import type {
    CommandExecutionResult,
    CommandExecutionService,
    CommandExecutionUpdateCallback,
} from "../_shared/command-execution/core.ts";
import {
    isSafeExecutionError,
    toPublicFailure,
} from "../_shared/command-execution/failure.ts";
import {
    toSafeAnalysisId,
    type AnalysisBindingValue,
    type AnalysisResult,
} from "../_shared/sandbox-runtime/analysis-protocol.ts";
import {
    getSandboxAnalysisPort,
    type AnalysisSandboxPort,
} from "../_shared/sandbox-runtime/index.ts";

import {
    createThinkCommandExecution,
    type ThinkCommandOperation,
} from "./command-policy.ts";
import type { ThinkInCodeConfig } from "./config.ts";
import { runRetention } from "./storage/retention.ts";
import type { ThinkStore } from "./storage/store.ts";
import type {
    BatchExecuteItem,
    BatchExecuteSummary,
    BatchItemResult,
    ExecuteFileRequest,
    ExecuteRequest,
    IndexRequest,
    SearchRequest,
    ThinkLanguage,
    ToolExecutionDetails,
} from "./types.ts";

const SCHEMA_VERSION = 1;

export interface CoordinatorDeps {
    store: ThinkStore;
    config: ThinkInCodeConfig;
    commandExecution?: CommandExecutionService<ThinkCommandOperation>;
    getAnalysisPort?: () => AnalysisSandboxPort;
}

/**
 * Streaming progress callback supplied by the registered Pi tool. The
 * coordinator only owns the structural boundary; the `TDetails` is the
 * Think tool's `ToolExecutionDetails` (not the bash tool's details type
 * that safe-execution's update callback is parameterized with), so we
 * declare our own structurally correct alias rather than borrowing from
 * the safe-execution layer.
 */
export type ThinkUpdateCallback = AgentToolUpdateCallback<ToolExecutionDetails>;

export interface CoordinatorRuntime {
    signal?: AbortSignal;
    onUpdate?: ThinkUpdateCallback;
}

/**
 * Render a safe-execution error into the bounded reason that may reach
 * the LLM, capturing the raw message only for capture warnings / telemetry.
 * Never embeds preceding stdout when the bash exit/timeout/aborted shape
 * is recognizable; never embeds arbitrary preceding text otherwise.
 */
function safeFailureReason(error: unknown): string {
    return toPublicFailure(error).reason;
}

/**
 * TruncationResult fields that are safe to surface to Pi via streamed
 * updates. Only scalar metadata — counts, limits, and booleans — may be
 * forwarded. The `content` string is dropped because it carries up to
 * ~50 KiB of the raw truncated stdout/stderr tail (see
 * `@earendil-works/pi-coding-agent/dist/core/tools/truncate.d.ts` and
 * `output-accumulator.js:78-86`); `firstLineExceedsLimit` and `lastLinePartial`
 * are booleans that describe truncation shape, not its content.
 */
const SAFE_TRUNCATION_FIELDS: ReadonlySet<keyof TruncationResult> = new Set([
    "truncated",
    "truncatedBy",
    "totalLines",
    "totalBytes",
    "outputLines",
    "outputBytes",
    "lastLinePartial",
    "firstLineExceedsLimit",
    "maxLines",
    "maxBytes",
]);

/**
 * Reconstruct a truncation object with only safe scalar metadata. Input
 * is type-erased so callers cannot accidentally smuggle a field through
 * by handing us a structurally compatible but semantically different
 * object; every output key is whitelisted explicitly.
 */
function whitelistTruncation(
    // oxlint-disable-next-line typescript/no-restricted-types -- function takes a fully type-erased value passed across the safe-execution boundary; widening to a concrete interface would force unsafe casts.
    input: unknown,
): Partial<TruncationResult> {
    if (typeof input !== "object" || input === null) return {};
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowing an unknown type-erased value to a key-value record so we can iterate the whitelist; TruncationResult keys are validated individually below.
    const source = input as Record<string, unknown>;
    const out: Partial<TruncationResult> = {};
    for (const key of SAFE_TRUNCATION_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            (out as Record<string, unknown>)[key] = source[key];
        }
    }
    return out;
}

/**
 * Analyzer (QuickJS/Python) failure normalizer. Errors here originate
 * from the analysis sandbox; their messages may echo input bindings
 * (`INPUT`, `FILE_CONTENT`, `INPUTS`), raw program context, or even
 * attacker-controlled prefixes such as `"Safe execution unavailable: "`
 * raised from inside a Python `try/except`. Treat all such messages as
 * untrusted — never copy verbatim. Return a bounded, generic reason that
 * preserves only the analyzer language and, when safe, the JS/Python
 * error class name (whitelisted to short identifiers).
 */
function analyzerFailureReason(
    error: unknown,
    language: ThinkLanguage,
): string {
    const languageLabel =
        language === "javascript" || language === "typescript"
            ? "javascript"
            : "python";
    if (error instanceof Error && error.name && error.name !== "Error") {
        const name = error.name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 64);
        if (name) {
            return `Analysis failed (${languageLabel}: ${name})`;
        }
    }
    return `Analysis failed (${languageLabel})`;
}

const MAX_ANALYSIS_INPUT_BYTES = 64 * 1024 * 1024;
const FILE_READ_CHUNK_BYTES = 64 * 1024;

class FileInputError extends Error {}

interface BoundedReadableFile {
    read(
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
    ): Promise<{ bytesRead: number }>;
}

async function readBoundedFile(
    file: BoundedReadableFile,
    expectedSize: number,
    signal?: AbortSignal,
): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const readCeiling = Math.min(
        MAX_ANALYSIS_INPUT_BYTES + 1,
        expectedSize + 1,
    );
    let total = 0;

    while (total < readCeiling) {
        if (signal?.aborted) {
            throw new FileInputError("File read aborted");
        }
        const length = Math.min(FILE_READ_CHUNK_BYTES, readCeiling - total);
        const chunk = Buffer.allocUnsafe(length);
        const { bytesRead } = await file.read(chunk, 0, length, total);
        if (bytesRead === 0) break;
        chunks.push(chunk.subarray(0, bytesRead));
        total += bytesRead;
    }

    if (total > MAX_ANALYSIS_INPUT_BYTES) {
        throw new FileInputError("File exceeds 64 MiB limit");
    }
    if (total !== expectedSize) {
        throw new FileInputError("File changed while reading");
    }
    return Buffer.concat(chunks, total);
}

function fileFailureReason(error: unknown, requestPath: string): string {
    if (error instanceof FileInputError) {
        return error.message;
    }
    const code =
        typeof error === "object" && error !== null && "code" in error
            ? error.code
            : undefined;
    return code === "ENOENT"
        ? `File not found: ${requestPath}`
        : `Unable to read file: ${requestPath}`;
}

export class ThinkCoordinator {
    readonly #store: ThinkStore;
    readonly #config: ThinkInCodeConfig;
    readonly #commandExecution: CommandExecutionService<ThinkCommandOperation>;
    readonly #getAnalysisPort: () => AnalysisSandboxPort;
    #closed = false;

    constructor(deps: CoordinatorDeps) {
        this.#store = deps.store;
        this.#config = deps.config;
        this.#commandExecution =
            deps.commandExecution ??
            createThinkCommandExecution({
                getConfig: () => this.#config,
                getTelemetryRecorder: () => null,
            }).service;
        this.#getAnalysisPort = deps.getAnalysisPort ?? getSandboxAnalysisPort;
    }

    get store(): ThinkStore {
        return this.#store;
    }

    get config(): ThinkInCodeConfig {
        return this.#config;
    }

    /**
     * Run retention idempotently so the store stays under quota on every
     * archive write. Failures are surfaced but do not block the call.
     */
    runRetentionSafe(now: () => number = Date.now): string[] {
        try {
            runRetention(this.#store, this.#config, { now });
            return [];
        } catch (error) {
            return [error instanceof Error ? error.message : String(error)];
        }
    }

    #indexDerivedResult(input: {
        kind: IndexRequest["kind"];
        source: string;
        derivedResult: AnalysisResult | null;
        archiveIds: readonly string[];
        blockedReason?: string;
        indexWarnings: string[];
    }): void {
        if (
            input.blockedReason ||
            !input.derivedResult ||
            input.derivedResult.output.trim().length === 0
        ) {
            return;
        }
        try {
            this.#store.index({
                kind: input.kind,
                source: input.source,
                text: input.derivedResult.output,
                archiveIds: input.archiveIds,
            });
        } catch (error) {
            input.indexWarnings.push(
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    async execute(
        request: ExecuteRequest,
        ctx: ExtensionContext,
        runtime: CoordinatorRuntime = {},
    ): Promise<{
        content: { type: "text"; text: string }[];
        details: ToolExecutionDetails;
    }> {
        this.#assertOpen();
        const startedAt = performance.now();
        const captureWarnings: string[] = [];
        const indexWarnings: string[] = [];
        const archiveIds: string[] = [];
        let sourceBytes = 0;
        let blockedReason: string | undefined;
        let derivedResult: AnalysisResult | null = null;

        const sourceInputs: Array<{
            archiveId?: string;
            byteCount: number;
            data: string;
        }> = [];

        const handleCommand = async (
            command: string,
            timeout?: number,
            stdin?: string,
        ): Promise<void> => {
            const commandExecution = this.#commandExecution;
            try {
                const result: CommandExecutionResult =
                    await commandExecution.execute({
                        toolCallId: request.id,
                        operation: "think_execute",
                        command,
                        timeout,
                        stdin,
                        signal: runtime.signal,
                        onUpdate: sanitizeStreamingUpdate(runtime.onUpdate),
                        ctx,
                    });
                this.#captureCommandInput({
                    data: extractText(result),
                    archiveIds,
                    captureWarnings,
                    sourceInputs,
                    onBytes: (byteCount) => {
                        sourceBytes += byteCount;
                    },
                });
            } catch (error) {
                const rawOutput = rawCommandOutput(error);
                if (rawOutput === null) throw error;
                this.#captureCommandInput({
                    data: rawOutput,
                    archiveIds,
                    captureWarnings,
                    sourceInputs,
                    onBytes: (byteCount) => {
                        sourceBytes += byteCount;
                    },
                });
            }
        };

        // Source/store validation (verifyArchiveId, readArchives, source
        // kind selection) throws with static, caller-input-only messages
        // (e.g. "Invalid archive id: <id>", "Archive not found: <id>",
        // "Unsupported source kind"); preserve those verbatim. The
        // safe-execution normalization only applies to handleCommand,
        // which can carry raw stdout in its error message.
        try {
            if (request.source.kind === "command") {
                try {
                    await handleCommand(
                        request.source.command,
                        request.source.timeout,
                        request.source.stdin,
                    );
                } catch (commandError) {
                    // Typed bash-exit failures are captured in handleCommand
                    // and become analyzer input. Guard, redirect, unavailable,
                    // and unrecognized errors still fail closed.
                    if (rawCommandOutput(commandError) === null) {
                        blockedReason = safeFailureReason(commandError);
                    }
                }
            } else if (request.source.kind === "archives") {
                for (const id of request.source.archiveIds) {
                    if (!verifyArchiveId(id)) {
                        throw new Error(`Invalid archive id: ${id}`);
                    }
                    archiveIds.push(id);
                }
                const loaded = this.#store.readArchives(
                    archiveIds,
                    MAX_ANALYSIS_INPUT_BYTES,
                );
                for (const archive of loaded) {
                    sourceBytes += archive.byteCount;
                    sourceInputs.push({
                        archiveId: archive.id,
                        byteCount: archive.byteCount,
                        data: archive.data,
                    });
                }
            } else if (request.source.kind === "content") {
                const byteCount = Buffer.byteLength(
                    request.source.content,
                    "utf8",
                );
                const archive = this.#archiveSafely({
                    kind: "indexed",
                    data: request.source.content,
                    captureWarnings,
                });
                if (archive) archiveIds.push(archive.id);
                sourceBytes += byteCount;
                sourceInputs.push({
                    archiveId: archive?.id,
                    byteCount,
                    data: request.source.content,
                });
            } else {
                throw new Error("Unsupported source kind");
            }
        } catch (error) {
            blockedReason =
                error instanceof Error ? error.message : String(error);
        }

        if (!blockedReason && sourceInputs.length > 0) {
            try {
                const analysis = this.#getAnalysisPort();
                const archivePayload = sourceInputs.map((input) => ({
                    id: input.archiveId,
                    byteCount: input.byteCount,
                }));
                derivedResult = await analysis.run(
                    {
                        id: toSafeAnalysisId(request.id),
                        language: request.language,
                        program: request.program,
                        bindings: {
                            ...request.bindings,
                            INPUT: sourceInputs
                                .map((input) => input.data)
                                .join(""),
                            ARCHIVES: JSON.stringify(archivePayload),
                            ARCHIVE_IDS: archiveIds.join(","),
                        },
                        limits: request.limits,
                    },
                    runtime.signal,
                );
            } catch (error) {
                // Analyzer failures originate from the analysis sandbox,
                // never from safe execution. Use the bounded analyzer
                // normalizer so raw binding values (`INPUT`,
                // `FILE_CONTENT`) or attacker-controlled messages cannot
                // reach the LLM as content text or details.blockedReason.
                blockedReason = analyzerFailureReason(error, request.language);
            }
        }

        if (derivedResult) {
            const analysisArchive = this.#archiveSafely({
                kind: "analysis-output",
                data: derivedResult.output,
                captureWarnings,
            });
            if (analysisArchive) archiveIds.push(analysisArchive.id);
        }

        this.#indexDerivedResult({
            kind:
                request.source.kind === "command"
                    ? "command-summary"
                    : request.source.kind === "content"
                      ? "document-summary"
                      : "analysis-summary",
            source:
                request.source.kind === "command"
                    ? request.source.command
                    : request.id,
            derivedResult,
            archiveIds,
            blockedReason,
            indexWarnings,
        });

        const derivedBytes = derivedResult
            ? Buffer.byteLength(derivedResult.output, "utf8")
            : 0;
        const responseTruncated = derivedBytes > this.#config.maxResultBytes;
        const truncated =
            (derivedResult?.truncated ?? false) || responseTruncated;
        const text = boundedDerivedText(
            derivedResult,
            this.#config.maxResultBytes,
        );
        const details: ToolExecutionDetails = {
            archiveIds,
            sourceBytes,
            derivedBytes,
            language: request.language,
            runtime: derivedResult?.runtime ?? "none",
            elapsedMs: Math.round(performance.now() - startedAt),
            truncated,
            captureWarnings,
            indexWarnings,
            blockedReason,
        };
        return {
            content: [{ type: "text", text: blockedReason ?? text }],
            details,
        };
    }

    async executeFile(
        request: ExecuteFileRequest,
        ctx: ExtensionContext,
        runtime: CoordinatorRuntime = {},
    ): Promise<{
        content: { type: "text"; text: string }[];
        details: ToolExecutionDetails;
    }> {
        this.#assertOpen();
        const startedAt = performance.now();
        const captureWarnings: string[] = [];
        const indexWarnings: string[] = [];
        const archiveIds: string[] = [];
        let blockedReason: string | undefined;
        let derivedResult: AnalysisResult | null = null;
        let sourceBytes = 0;

        try {
            const resolved = resolvePath(ctx.cwd, request.path);
            const cwdLexical = resolvePath(ctx.cwd, ".");
            const lexicalRelative = relativeTo(cwdLexical, resolved);
            if (
                lexicalRelative.startsWith("..") ||
                lexicalRelative.startsWith("/")
            ) {
                throw new FileInputError(
                    `Path escapes project root: ${request.path}`,
                );
            }
            const cwdCanonical = await realpath(ctx.cwd);
            const file = await open(
                resolved,
                fsConstants.O_RDONLY | fsConstants.O_NONBLOCK,
            );
            try {
                let canonical: string;
                try {
                    canonical = await realpath(`/proc/self/fd/${file.fd}`);
                } catch {
                    throw new FileInputError(
                        `Unable to verify file: ${request.path}`,
                    );
                }
                const relative = relativeTo(cwdCanonical, canonical);
                if (relative.startsWith("..") || relative.startsWith("/")) {
                    throw new FileInputError(
                        `Path escapes project root: ${request.path}`,
                    );
                }
                const stats = await file.stat();
                if (!stats.isFile()) {
                    throw new FileInputError(
                        `Path is not a regular file: ${request.path}`,
                    );
                }
                if (stats.size > MAX_ANALYSIS_INPUT_BYTES) {
                    throw new FileInputError(
                        `File exceeds 64 MiB limit (${stats.size} bytes)`,
                    );
                }
                const bytes = await readBoundedFile(
                    file,
                    stats.size,
                    runtime.signal,
                );
                if (bytes.includes(0)) {
                    throw new FileInputError(
                        `File appears binary: ${request.path}`,
                    );
                }
                let content: string;
                try {
                    content = new TextDecoder("utf-8", { fatal: true }).decode(
                        bytes,
                    );
                } catch {
                    throw new FileInputError(
                        `File is not valid UTF-8: ${request.path}`,
                    );
                }
                sourceBytes = bytes.byteLength;
                const archive = this.#archiveSafely({
                    kind: "file-content",
                    data: content,
                    captureWarnings,
                });
                if (archive) {
                    archiveIds.push(archive.id);
                }
                try {
                    const analysis = this.#getAnalysisPort();
                    derivedResult = await analysis.run(
                        {
                            id: toSafeAnalysisId(request.id),
                            language: request.language,
                            program: request.program,
                            bindings: {
                                ...request.bindings,
                                FILE_CONTENT: content,
                                FILE_PATH: canonical,
                            },
                        },
                        runtime.signal,
                    );
                    const analysisArchive = this.#archiveSafely({
                        kind: "analysis-output",
                        data: derivedResult.output,
                        captureWarnings,
                    });
                    if (analysisArchive) archiveIds.push(analysisArchive.id);
                } catch (analysisError) {
                    // The analyzer may throw with a message that echoes raw
                    // `FILE_CONTENT` (e.g. `throw new Error(FILE_CONTENT)`);
                    // never copy that into content/details or let it exceed
                    // the documented bound. The path validation layer above
                    // is responsible for input shaping and uses static error
                    // messages that only echo the caller's own `request.path`.
                    blockedReason = analyzerFailureReason(
                        analysisError,
                        request.language,
                    );
                }
            } finally {
                await file.close();
            }
        } catch (error) {
            // Only our static validation messages may cross the boundary.
            // OS errors can contain canonical host paths, so map them to a
            // request-path-only public reason.
            blockedReason = fileFailureReason(error, request.path);
        }

        // File programs receive raw FILE_CONTENT and are intentionally
        // arbitrary. Their output cannot be proven derived rather than a
        // copied, transformed, or encoded form of the source, so persisting it
        // automatically would violate the raw-archive boundary. Callers can
        // persist a reviewed conclusion explicitly through `think_note`.

        const text = boundedDerivedText(
            derivedResult,
            this.#config.maxResultBytes,
        );
        const fileDerivedBytes = derivedResult
            ? Buffer.byteLength(derivedResult.output, "utf8")
            : 0;
        const details: ToolExecutionDetails = {
            archiveIds,
            sourceBytes,
            derivedBytes: fileDerivedBytes,
            language: request.language,
            runtime: derivedResult?.runtime ?? "none",
            elapsedMs: Math.round(performance.now() - startedAt),
            truncated:
                (derivedResult?.truncated ?? false) ||
                fileDerivedBytes > this.#config.maxResultBytes,
            captureWarnings,
            indexWarnings,
            blockedReason,
        };
        return {
            content: [{ type: "text", text: blockedReason ?? text }],
            details,
        };
    }

    async batchExecute(
        request: {
            id: string;
            language: ThinkLanguage;
            program: string;
            items: readonly BatchExecuteItem[];
        },
        ctx: ExtensionContext,
        runtime: CoordinatorRuntime = {},
    ): Promise<{
        content: { type: "text"; text: string }[];
        details: ToolExecutionDetails & { items: BatchExecuteSummary["items"] };
    }> {
        this.#assertOpen();
        const startedAt = performance.now();
        const captureWarnings: string[] = [];
        const indexWarnings: string[] = [];
        const itemResults: Array<
            (BatchItemResult & { output?: string }) | undefined
        > = Array.from({ length: request.items.length });
        let derivedResult: AnalysisResult | null = null;
        let blockedReason: string | undefined;

        if (request.items.length === 0) {
            throw new Error("Batch execute requires at least one item");
        }
        if (request.items.length > this.#config.maxBatchCommands) {
            throw new Error(
                `Batch execute exceeds ${this.#config.maxBatchCommands} items`,
            );
        }

        const commandExecution = this.#commandExecution;
        const concurrency = Math.min(
            this.#config.batchConcurrency,
            request.items.length,
        );
        const queue = request.items.map((item, index) => ({ item, index }));
        const workers: Promise<void>[] = [];
        for (let workerIndex = 0; workerIndex < concurrency; workerIndex += 1) {
            workers.push(
                (async () => {
                    while (queue.length > 0) {
                        const next = queue.shift();
                        if (!next) return;
                        try {
                            const result = await commandExecution.execute({
                                toolCallId: `${request.id}:${next.item.id}`,
                                operation: "think_batch_execute",
                                command: next.item.command,
                                timeout: next.item.timeout,
                                stdin: next.item.stdin,
                                signal: runtime.signal,
                                onUpdate: sanitizeStreamingUpdate(
                                    runtime.onUpdate,
                                ),
                                ctx,
                            });
                            const output = extractText(result);
                            const byteCount = Buffer.byteLength(output, "utf8");
                            const archive = this.#archiveSafely({
                                kind: "command-output",
                                data: output,
                                captureWarnings,
                            });
                            itemResults[next.index] = {
                                id: next.item.id,
                                status: "succeeded",
                                archiveId: archive?.id,
                                byteCount,
                                output,
                            };
                        } catch (error) {
                            const rawOutput = rawCommandOutput(error);
                            const byteCount = rawOutput
                                ? Buffer.byteLength(rawOutput, "utf8")
                                : 0;
                            const archive = rawOutput
                                ? this.#archiveSafely({
                                      kind: "command-output",
                                      data: rawOutput,
                                      captureWarnings,
                                  })
                                : null;
                            itemResults[next.index] = {
                                id: next.item.id,
                                status: runtime.signal?.aborted
                                    ? "blocked"
                                    : "failed",
                                archiveId: archive?.id,
                                byteCount,
                                output: rawOutput ?? undefined,
                                error: safeFailureReason(error),
                            };
                        }
                    }
                })(),
            );
        }
        await Promise.all(workers);
        const orderedItems = itemResults.filter(
            (item): item is BatchItemResult & { output?: string } =>
                item !== undefined,
        );
        const archiveIds = orderedItems.flatMap((item) =>
            item.archiveId ? [item.archiveId] : [],
        );
        const sourceBytes = orderedItems.reduce(
            (total, item) => total + item.byteCount,
            0,
        );

        try {
            const analysis = this.#getAnalysisPort();
            derivedResult = await analysis.run(
                {
                    id: toSafeAnalysisId(request.id),
                    language: request.language,
                    program: request.program,
                    bindings: {
                        // Protocol and workers deep-freeze this structured
                        // array before exposing it to model code. `output`
                        // carries raw command bytes only into the isolated
                        // analyzer; public details omit it below.
                        INPUTS: orderedItems.map((item) => {
                            const input: Record<string, AnalysisBindingValue> =
                                {
                                    id: item.id,
                                    status: item.status,
                                };
                            if (item.archiveId !== undefined) {
                                input.archiveId = item.archiveId;
                            }
                            if (item.output !== undefined) {
                                input.output = item.output;
                            }
                            // The per-item error is already sanitized through
                            // safeFailureReason before it crosses the worker
                            // boundary.
                            if (item.error !== undefined) {
                                input.error = item.error;
                            }
                            return input;
                        }),
                    },
                },
                runtime.signal,
            );
            const analysisArchive = this.#archiveSafely({
                kind: "analysis-output",
                data: derivedResult.output,
                captureWarnings,
            });
            if (analysisArchive) archiveIds.push(analysisArchive.id);
        } catch (error) {
            // Analyzer failure (not safe execution) — generic bounded
            // reason, never echo INPUTS binding.
            blockedReason = analyzerFailureReason(error, request.language);
        }

        this.#indexDerivedResult({
            kind: "analysis-summary",
            source: request.id,
            derivedResult,
            archiveIds,
            blockedReason,
            indexWarnings,
        });

        const derivedText = boundedDerivedText(
            derivedResult,
            this.#config.maxResultBytes,
        );
        const derivedBytes = derivedResult
            ? Buffer.byteLength(derivedResult.output, "utf8")
            : 0;
        const details: ToolExecutionDetails & {
            items: BatchExecuteSummary["items"];
        } = {
            archiveIds,
            sourceBytes,
            derivedBytes,
            language: request.language,
            runtime: derivedResult?.runtime ?? "none",
            elapsedMs: Math.round(performance.now() - startedAt),
            truncated:
                (derivedResult?.truncated ?? false) ||
                derivedBytes > this.#config.maxResultBytes,
            captureWarnings,
            indexWarnings,
            blockedReason,
            items: orderedItems.map(({ output: _output, ...item }) => item),
        };
        return {
            content: [
                {
                    type: "text",
                    text: blockedReason ?? derivedText,
                },
            ],
            details,
        };
    }

    index(request: IndexRequest): {
        content: { type: "text"; text: string }[];
        details: ToolExecutionDetails;
    } {
        this.#assertOpen();
        const startedAt = performance.now();
        const captureWarnings: string[] = [];
        const indexWarnings: string[] = [];
        const archiveIds: string[] = [];
        let blockedReason: string | undefined;

        try {
            if (request.text === undefined && !request.archiveIds?.length) {
                throw new Error("Indexing requires either text or archiveIds");
            }
            if (request.archiveIds) {
                for (const id of request.archiveIds) {
                    if (!verifyArchiveId(id)) {
                        throw new Error(`Invalid archive id: ${id}`);
                    }
                    archiveIds.push(id);
                }
            }
            const result = this.#store.index({
                kind: request.kind,
                source: request.source,
                text: request.text ?? `${archiveIds[0]}`,
                archiveIds,
            });
            return {
                content: [
                    {
                        type: "text",
                        text: `indexed document ${result.documentId} (${result.byteCount} bytes)`,
                    },
                ],
                details: {
                    archiveIds,
                    sourceBytes: result.byteCount,
                    derivedBytes: result.byteCount,
                    language: "javascript",
                    runtime: "none",
                    elapsedMs: Math.round(performance.now() - startedAt),
                    truncated: false,
                    captureWarnings,
                    indexWarnings,
                    blockedReason,
                },
            };
        } catch (error) {
            blockedReason =
                error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: "text", text: blockedReason }],
                details: {
                    archiveIds,
                    sourceBytes: 0,
                    derivedBytes: 0,
                    language: "javascript",
                    runtime: "none",
                    elapsedMs: Math.round(performance.now() - startedAt),
                    truncated: false,
                    captureWarnings,
                    indexWarnings,
                    blockedReason,
                },
            };
        }
    }

    search(request: SearchRequest): {
        content: { type: "text"; text: string }[];
        details: ToolExecutionDetails;
    } {
        this.#assertOpen();
        const startedAt = performance.now();
        const limit = Math.min(request.limit ?? 20, 20);
        try {
            const hits = this.#store.search(request.query, limit);
            const summary = hits
                .map((hit, index) => {
                    return [
                        `${index + 1}. document ${hit.documentId} (score=${hit.score.toFixed(3)})`,
                        `   source: ${hit.source}`,
                        `   snippet: ${hit.snippet}`,
                        `   archiveIds: ${hit.archiveIds.join(", ") || "(none)"}`,
                    ].join("\n");
                })
                .join("\n");
            return {
                content: [
                    {
                        type: "text",
                        text: summary || "no matches",
                    },
                ],
                details: {
                    archiveIds: hits.flatMap((hit) => hit.archiveIds),
                    sourceBytes: Buffer.byteLength(summary, "utf8"),
                    derivedBytes: Buffer.byteLength(summary, "utf8"),
                    language: "javascript",
                    runtime: "none",
                    elapsedMs: Math.round(performance.now() - startedAt),
                    truncated: false,
                    captureWarnings: [],
                    indexWarnings: [],
                },
            };
        } catch (error) {
            const reason =
                error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: "text", text: reason }],
                details: {
                    archiveIds: [],
                    sourceBytes: 0,
                    derivedBytes: 0,
                    language: "javascript",
                    runtime: "none",
                    elapsedMs: Math.round(performance.now() - startedAt),
                    truncated: false,
                    captureWarnings: [],
                    indexWarnings: [],
                    blockedReason: reason,
                },
            };
        }
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
    }

    #assertOpen(): void {
        if (this.#closed) {
            throw new Error("Think-in-Code coordinator is closed");
        }
    }

    #captureCommandInput(input: {
        data: string;
        archiveIds: string[];
        captureWarnings: string[];
        sourceInputs: Array<{
            archiveId?: string;
            byteCount: number;
            data: string;
        }>;
        onBytes(byteCount: number): void;
    }): void {
        if (input.data.length === 0) return;
        const byteCount = Buffer.byteLength(input.data, "utf8");
        const archive = this.#archiveSafely({
            kind: "command-output",
            data: input.data,
            captureWarnings: input.captureWarnings,
        });
        if (archive) input.archiveIds.push(archive.id);
        input.onBytes(byteCount);
        input.sourceInputs.push({
            archiveId: archive?.id,
            byteCount,
            data: input.data,
        });
    }

    #archiveSafely(input: {
        kind: "command-output" | "analysis-output" | "file-content" | "indexed";
        data: string;
        captureWarnings: string[];
    }): { id: string; byteCount: number } | null {
        try {
            const archive = this.#store.archive(input);
            const retentionWarnings = this.runRetentionSafe();
            input.captureWarnings.push(...retentionWarnings);
            return { id: archive.id, byteCount: archive.byteCount };
        } catch (error) {
            input.captureWarnings.push(
                error instanceof Error ? error.message : String(error),
            );
            return null;
        }
    }
}

function extractText(result: CommandExecutionResult): string {
    const parts: string[] = [];
    for (const block of result.content) {
        if (block.type === "text") {
            parts.push(block.text);
        }
    }
    return parts.join("");
}

/**
 * Wrap a parent-supplied onUpdate callback so that streaming safe-execution
 * output can never expose raw bytes through Pi's `tool_execution_update`
 * `partialResult.content[].text`. Raw command stdout/stderr is archived, never
 * streamed; only a bounded shape (empty content + safe truncation metadata)
 * reaches the parent callback.
 *
 * `details.fullOutputPath` is intentionally dropped because it points to a
 * temp file holding the full raw stdout — the path itself is metadata that
 * would let the agent locate raw bytes on disk and has no TUI consumer for
 * the Think tools. The remaining `truncation` metadata is forwarded so the
 * "tool is still running" partial signal and elapsed-time rendering keep
 * working.
 *
 * Aborting is preserved independently via `runtime.signal`; the wrapped
 * callback itself only forwards sanitized updates.
 */
function sanitizeStreamingUpdate(
    parent: ThinkUpdateCallback | undefined,
): CommandExecutionUpdateCallback | undefined {
    if (!parent) return undefined;
    return (partialResult) => {
        const safe = partialResult as {
            content?: readonly unknown[];
            details?: {
                truncation?: unknown;
                fullOutputPath?: unknown;
            };
        };
        const sanitizedTruncation = whitelistTruncation(
            safe.details?.truncation,
        );
        // Build the parent-facing payload with only whitelisted scalar
        // metadata — never any string field that could carry raw stdout.
        // fullOutputPath is intentionally dropped (it points to a temp
        // file holding the full raw stdout).
        if (Object.keys(sanitizedTruncation).length === 0) {
            parent({
                content: [],
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion
                details: {} as ToolExecutionDetails,
            });
            return;
        }
        parent({
            content: [],
            // SAFETY: only whitelisted scalar truncation metadata reaches this
            // structural Pi tool-details boundary.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            details: {
                truncation: sanitizedTruncation,
            } as unknown as ToolExecutionDetails,
        });
    };
}

/**
 * Raw command bytes are trusted only when safe-execution branded the error as
 * a bash process outcome. Guard/redirect/unavailable paths never become
 * analyzer input, preserving their fail-closed behavior.
 */
function rawCommandOutput(error: unknown): string | null {
    if (!isSafeExecutionError(error)) return null;
    const kind = error.getKind();
    if (
        kind !== "bash_exit" &&
        kind !== "bash_timeout" &&
        kind !== "bash_aborted"
    ) {
        return null;
    }
    return error.getRaw();
}

function boundedDerivedText(
    result: AnalysisResult | null,
    maxBytes: number,
): string {
    if (!result) return "";
    const out = result.output;
    if (Buffer.byteLength(out, "utf8") <= maxBytes) return out;
    let truncated = Buffer.from(out, "utf8")
        .subarray(0, maxBytes)
        .toString("utf8");
    while (truncated.endsWith("�")) truncated = truncated.slice(0, -1);
    return truncated;
}

function relativeTo(base: string, target: string): string {
    if (target.startsWith(base + "/")) {
        return target.slice(base.length + 1);
    }
    return target;
}

function verifyArchiveId(id: string): boolean {
    return /^[A-Za-z0-9_-]{8,128}$/.test(id);
}

export const __test = {
    SCHEMA_VERSION,
    verifyArchiveId,
    boundedDerivedText,
    fileFailureReason,
    readBoundedFile,
};
