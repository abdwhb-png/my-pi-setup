import { basename } from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { getActivePolicy } from "../../_shared/audit-mode";
import type {
    CompressionDetails,
    CompressionFailedReason,
    CompressionSkippedReason,
} from "../../_shared/compression-protocol";
import { buildAggregateHeader } from "./aggregates";
import {
    belowMinTokens,
    countCodePoints,
    countUtf8Bytes,
    estimateTokens,
    fitsTokenBudget,
} from "./token-estimator";
import type {
    ArchiveOriginalInput,
    ToolResultHandlerOptions,
    CompressorModel,
    CompressionBackendId,
    CompressionObservation,
} from "./types";

type CompressionRoute = "edgee" | "cap";

/** Default cap budget (estimated tokens) for large error outputs when capFallbackTokens is not set. */
const DEFAULT_ERROR_CAP_TOKENS = 2700;

/** Default deterministic cap budget (estimated tokens) for path listings that semantic compression corrupts. */
const DEFAULT_FIND_CAP_TOKENS = 2700;

/**
 * §3 AXI — Unified escape hatch note for compressed results.
 *
 * Appears on both cap and Edgee routes when the original is archived.
 * Exposes the total original size so the LLM can judge whether retrieval
 * is worth a follow-up call.
 */
export function buildEscapeHatchNote(
    text: string,
    archivePath: string,
): string {
    const chars = countCodePoints(text);
    const tokens = estimateTokens(text);
    return `\n\n... (compressed, ${chars} chars ≈ ${tokens} tokens) — run read ${archivePath} for full output`;
}

export function chooseCompressionRoute(input: {
    strategy: "edgee" | "benchmark";
    toolName: string;
    text: string;
}): CompressionRoute {
    if (input.toolName === "find") return "cap";
    if (input.strategy !== "benchmark") return "edgee";
    if (input.toolName === "read") return "edgee";
    if (
        input.toolName === "grep" ||
        input.toolName === "bash" ||
        input.toolName === "safe_bash" ||
        input.toolName === "ls" ||
        input.toolName === "find"
    ) {
        return "cap";
    }
    return "edgee";
}

/**
 * Benign backend outcomes: the backend declined to compress but nothing broke.
 * Everything else (service/http/invalid/timeout/aborted) is a real failure.
 */
const BENIGN_BACKEND_REASONS: ReadonlySet<string> = new Set([
    // Native Headroom adapter: identical or non-shorter output is a benign
    // decline, not a backend failure.
    "no_change",
    "not_shorter",
    "unsupported_tool",
    "no_output",
]);

/**
 * Classifies a `CompressionBackendResult.reason` into a policy outcome.
 *
 * Failure reasons produce a `failed` observation so telemetry reflects real
 * backend breakage. Benign no-op reasons (and an absent reason) produce a
 * `skipped` observation and fail-open behavior.
 */
export function classifyBackendReason(
    reason: string | undefined,
): "failed" | "skipped" {
    if (reason === undefined) return "skipped";
    return BENIGN_BACKEND_REASONS.has(reason) ? "skipped" : "failed";
}

/**
 * Exact `CompressionFailedReason` members the adapters may report, plus the
 * template-literal `http_<number>` members. Preserved verbatim.
 */
const SUPPORTED_FAILED_REASONS: ReadonlySet<string> = new Set([
    "service_error",
    "timeout",
    "aborted",
    "http_error",
    "invalid_response",
    "invalid_json",
]);

/**
 * Safely maps an arbitrary backend reason string into a canonical
 * `CompressionFailedReason`. Supported exact reasons (including `http_<n>`)
 * are preserved verbatim; any other string normalizes to the generic
 * `service_error` — impossible reason strings are never preserved through an
 * unsafe cast.
 */
export function normalizeFailedReason(
    reason: string | undefined,
): CompressionFailedReason {
    if (
        reason !== undefined &&
        (SUPPORTED_FAILED_REASONS.has(reason) || /^http_\d+$/.test(reason))
    ) {
        return reason as CompressionFailedReason;
    }
    return "service_error";
}

export function isCompressibleToolName(toolName: string): boolean {
    return (
        toolName === "read" ||
        toolName === "grep" ||
        toolName === "bash" ||
        toolName === "safe_bash" ||
        toolName === "ls" ||
        toolName === "find"
    );
}

/**
 * Maps a tool name to its compression context category.
 * Used by audit-aware compression policy to decide whether to bypass compression.
 *
 * - "search": grep, find, ls
 * - "read": read
 * - "shell": bash, safe_bash
 * - null: tool not subject to audit-controlled compression
 */
export function toolCompressionContext(
    toolName: string,
): "search" | "read" | "shell" | null {
    if (toolName === "grep" || toolName === "find" || toolName === "ls")
        return "search";
    if (toolName === "read") return "read";
    if (toolName === "bash" || toolName === "safe_bash") return "shell";
    return null;
}

function isTextBlock(
    value: object | null | undefined,
): value is { type: "text"; text: string } {
    const block = value as { type?: string; text?: string } | null | undefined;
    return block?.type === "text" && typeof block.text === "string";
}

export function extractCompressibleText(content: object[]): string | null {
    if (!Array.isArray(content) || content.length === 0) return null;
    if (!content.every(isTextBlock)) return null;
    return content.map((block) => block.text).join("\n");
}

function fullOutputPath(details: unknown): string | undefined {
    if (!details || typeof details !== "object" || Array.isArray(details))
        return undefined;
    const value = (details as Record<string, unknown>).fullOutputPath;
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function archiveInput(
    event: ToolResultEvent,
    subject: string | undefined,
    text: string,
): ArchiveOriginalInput {
    const sourcePath = fullOutputPath(event.details);
    return {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        subject,
        input: event.input,
        text,
        ...(sourcePath ? { sourcePath } : {}),
    };
}

function mergedDetails(
    original: unknown,
    compression: CompressionDetails,
): Record<string, unknown> & { compression: CompressionDetails } {
    if (original && typeof original === "object" && !Array.isArray(original)) {
        return { ...(original as Record<string, unknown>), compression };
    }
    return original === undefined
        ? { compression }
        : { originalDetails: original, compression };
}

const HEAD_TAIL_OMISSION_MARKER = "\n... [omitted by head/tail cap] ...\n";

/**
 * Deterministic head/tail capping expressed as an estimated-token budget.
 *
 * Unlike the legacy character-based cap, this:
 *  - never splits a Unicode surrogate pair (cuts on whole lines, iterates by
 *    code point),
 *  - enforces the budget by re-estimating the rendered result and trimming
 *    the heavier side until it fits,
 *  - treats `maxBytes` (UTF-8) as a secondary hard safety guard.
 *
 * Returns the original text unchanged when it already fits both the token
 * budget and the byte guard.
 *
 * Precondition: the budget must exceed the omission marker's own size. When it
 * does not, the only possible result is the marker itself (best effort) and the
 * budget cannot be strictly honored. `maybeCreateArchivedCap` guards this
 * before calling.
 */
export function headTailCapTokens(
    text: string,
    budgetTokens: number,
    maxBytes?: number,
): string {
    if (budgetTokens <= 0) return text;
    if (fitsTokenBudget(text, budgetTokens, maxBytes)) {
        return text;
    }

    const lines = text.split("\n");
    const maxLines = lines.length;
    let headCount = Math.ceil(maxLines / 2);
    let tailCount = maxLines - headCount;

    const build = (head: number, tail: number): string => {
        const headLines = lines.slice(0, head);
        const tailLines = lines.slice(maxLines - tail);
        return [...headLines, HEAD_TAIL_OMISSION_MARKER, ...tailLines].join(
            "\n",
        );
    };

    const overBudget = (candidate: string): boolean =>
        !fitsTokenBudget(candidate, budgetTokens, maxBytes);

    let result = build(headCount, tailCount);
    while (overBudget(result) && (headCount > 0 || tailCount > 0)) {
        if (headCount >= tailCount && headCount > 0) headCount -= 1;
        else if (tailCount > 0) tailCount -= 1;
        else break;
        result = build(headCount, tailCount);
    }
    return result;
}

/**
 * Observation enrichment for the selected backend (Task 10 telemetry).
 *
 * `backend`/`backendVersion` are selected-backend config facts: they are
 * present on every observation once a backend is configured, including
 * policy-only cap/archive paths that never call the engine. Call-only facts
 * (tokenizer, latencyMs, nativeMetrics) are added at the backend-call sites
 * and must never appear on policy paths.
 */
function observationMeta(
    backend: { id: CompressionBackendId } | null | undefined,
    backendVersion: string | undefined,
): Pick<CompressionObservation, "backend" | "backendVersion"> {
    const meta: Pick<CompressionObservation, "backend" | "backendVersion"> = {};
    if (backend) meta.backend = backend.id;
    if (backendVersion) meta.backendVersion = backendVersion;
    return meta;
}

async function maybeCreateArchivedCap(
    text: string,
    event: ToolResultEvent,
    subject: string | undefined,
    options?: ToolResultHandlerOptions,
    aggregatePrefix?: string | null,
    meta?: Pick<
        CompressionObservation,
        "backend" | "backendVersion" | "tokenizer"
    >,
) {
    const targetTokens = options?.capFallbackTokens;
    const maxBytes = options?.maxFallbackBytes;
    if (!targetTokens || targetTokens <= 0 || !options?.archiveOriginal)
        return null;
    if (fitsTokenBudget(text, targetTokens, maxBytes)) {
        return null;
    }
    const archivePath = await options.archiveOriginal(
        archiveInput(event, subject, text),
    );
    if (!archivePath) throw new Error("archive did not return a path");
    const note = buildEscapeHatchNote(text, archivePath);
    const prefix = aggregatePrefix ? `${aggregatePrefix}\n` : "";
    // The omission marker is always present in a trimmed result. If the
    // mandatory overhead (note + prefix + marker) already exceeds the budget
    // or byte guard, capping cannot satisfy its guarantee — fail open.
    const overheadTokens =
        estimateTokens(note) +
        estimateTokens(prefix) +
        estimateTokens(HEAD_TAIL_OMISSION_MARKER);
    const overheadBytes =
        countUtf8Bytes(note) +
        countUtf8Bytes(prefix) +
        countUtf8Bytes(HEAD_TAIL_OMISSION_MARKER);
    if (
        overheadTokens > targetTokens ||
        (maxBytes !== undefined && overheadBytes > maxBytes)
    ) {
        return null;
    }
    const cappedBudget = Math.max(
        1,
        targetTokens - estimateTokens(note) - estimateTokens(prefix),
    );
    const cappedMaxBytes =
        maxBytes === undefined
            ? undefined
            : Math.max(
                  0,
                  maxBytes - countUtf8Bytes(note) - countUtf8Bytes(prefix),
              );
    const capped = headTailCapTokens(text, cappedBudget, cappedMaxBytes);
    const outputText = `${prefix}${capped}${note}`;
    if (estimateTokens(outputText) >= estimateTokens(text)) return null;
    const originalLength = text.length;
    const compressedLength = outputText.length;
    const savedBytes = Math.max(0, originalLength - compressedLength);
    const savedPct =
        originalLength > 0
            ? Math.round((savedBytes / originalLength) * 100)
            : 0;

    options.onObservation?.({
        kind: "compressed",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        originalLength,
        compressedLength,
        originalUtf8Bytes: countUtf8Bytes(text),
        compressedUtf8Bytes: countUtf8Bytes(outputText),
        estimatedTokensBefore: estimateTokens(text),
        estimatedTokensAfter: estimateTokens(outputText),
        subject,
        archivePath,
        ...meta,
    });

    const compression = {
        originalLength,
        compressedLength,
        savedBytes,
        savedPct,
        originalUtf8Bytes: countUtf8Bytes(text),
        compressedUtf8Bytes: countUtf8Bytes(outputText),
        estimatedTokensBefore: estimateTokens(text),
        estimatedTokensAfter: estimateTokens(outputText),
        archivePath,
    } satisfies CompressionDetails;
    return {
        content: [{ type: "text" as const, text: outputText }],
        details: mergedDetails(event.details, compression),
    };
}

export function createToolResultHandler(options?: ToolResultHandlerOptions) {
    const backend = options?.backend;
    const backendVersion = options?.backendVersion;
    const routingStrategy = options?.routingStrategy ?? "edgee";
    const enabled = options?.enabled ?? true;
    const excludedTools = new Set(options?.excludeTools ?? []);
    const aggregates = options?.aggregates ?? true;
    const capErrors = options?.capErrors ?? true;
    const minTokensByGroup = options?.minTokensByGroup ?? {
        shell: 0,
        read: 0,
        search: 0,
    };

    return async (
        event: ToolResultEvent,
        model: CompressorModel,
        signal?: AbortSignal,
    ) => {
        if (!isCompressibleToolName(event.toolName)) return;
        if (!enabled || excludedTools.has(event.toolName)) return;

        // Consult shared audit policy — bypass compression if the active profile
        // disables it for this tool's category.
        const policy = getActivePolicy();
        const ctx = toolCompressionContext(event.toolName);
        if (
            (ctx === "search" && policy["compression.disableForSearch"]) ||
            (ctx === "read" && policy["compression.disableForRead"]) ||
            (ctx === "shell" && policy["compression.disableForShellResults"])
        ) {
            return;
        }

        const subject = summarizeToolSubject(event.toolName, event.input);
        const meta = observationMeta(backend, backendVersion);

        if (event.toolName === "find" && !event.isError) {
            // Non-errored `find` listings bypass the semantic backend and the
            // input threshold, going straight to the deterministic cap.
            // Errored `find` results are intentionally NOT special-cased: they
            // are handled by the generic error path below, so a small `find`
            // error is left intact rather than archived.
            const text = extractCompressibleText(event.content);
            if (!text) return;
            const aggregatePrefix = aggregates
                ? buildAggregateHeader(event.toolName, event.input, text)
                : null;
            try {
                return (
                    (await maybeCreateArchivedCap(
                        text,
                        event,
                        subject,
                        inputCapOptions(event.toolName, options),
                        aggregatePrefix,
                        meta,
                    )) ?? undefined
                );
            } catch {
                return;
            }
        }

        if (!backend) {
            if (options?.backendFailureReason) {
                const text = extractCompressibleText(event.content);
                if (!text) return;
                if (!ctx) return;
                if (belowMinTokens(text, minTokensByGroup[ctx])) return;
                options.onObservation?.({
                    kind: "failed",
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    originalLength: text.length,
                    compressedLength: 0,
                    reason: options.backendFailureReason,
                    subject,
                });
            }
            return;
        }

        // §6 AXI — Cap large error outputs (head/tail + archive, never Edgee)
        if (event.isError) {
            if (!capErrors) return;
            const text = extractCompressibleText(event.content);
            if (!text) return;
            if (!ctx) return;
            if (belowMinTokens(text, minTokensByGroup[ctx])) return;
            const aggregatePrefix = aggregates
                ? buildAggregateHeader(event.toolName, event.input, text)
                : null;
            const errorCapTokens =
                options?.capFallbackTokens ?? DEFAULT_ERROR_CAP_TOKENS;
            try {
                const capped = await maybeCreateArchivedCap(
                    text,
                    event,
                    subject,
                    { ...options, capFallbackTokens: errorCapTokens },
                    aggregatePrefix,
                    meta,
                );
                if (capped) return capped;
            } catch {
                // fail open: return intact
            }
            return;
        }

        const text = extractCompressibleText(event.content);
        if (!text) {
            options?.onObservation?.({
                kind: "skipped",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                originalLength: 0,
                compressedLength: 0,
                reason: "non_text_content",
                subject,
                ...meta,
            });
            return;
        }
        if (!ctx) return;
        if (belowMinTokens(text, minTokensByGroup[ctx])) return;

        const aggregatePrefix = aggregates
            ? buildAggregateHeader(event.toolName, event.input, text)
            : null;

        try {
            if (
                chooseCompressionRoute({
                    strategy: routingStrategy,
                    toolName: event.toolName,
                    text,
                }) === "cap"
            ) {
                const capped = await maybeCreateArchivedCap(
                    text,
                    event,
                    subject,
                    inputCapOptions(event.toolName, options),
                    aggregatePrefix,
                    meta,
                );
                if (capped) return capped;
                return;
            }
        } catch {
            options?.onObservation?.({
                kind: "failed",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                originalLength: text.length,
                compressedLength: 0,
                reason: "service_error",
                subject,
                ...meta,
            });
            return;
        }

        // Latency is measured around the selected backend call only; it is
        // set here so the catch (archive/policy errors and backend throws)
        // can still report it as the elapsed time since the call started.
        const startedAt = performance.now();
        // Call-scoped meta: adds the effective Headroom tokenizer fact only
        // where the backend engine actually ran and returned a result. The
        // catch (throw) path deliberately omits it — the engine may never
        // have processed the request.
        // Headroom does not expose the effective TokenCounter in its response.
        // Do not infer it from the model id: registry factories can fall back
        // to EstimatingTokenCounter at runtime.
        const callMeta = meta;
        let latencyMs: number | undefined;
        try {
            // The original tool name is forwarded verbatim; the selected
            // adapter owns any provider-specific translation.
            const backendRequest = {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                arguments: event.input ?? {},
                output: text,
                model,
            };

            const result = await backend.compress(backendRequest, signal);
            latencyMs = Math.round(performance.now() - startedAt);

            // Backend produced nothing usable. A real backend failure remains
            // the canonical observation even when cap/archive supplies the
            // fail-open content returned to Pi.
            if (!result.output || result.output === text) {
                const outcome = result.output
                    ? "skipped"
                    : classifyBackendReason(result.reason);
                if (outcome === "failed") {
                    options?.onObservation?.({
                        kind: "failed",
                        toolCallId: event.toolCallId,
                        toolName: event.toolName,
                        originalLength: text.length,
                        compressedLength: 0,
                        reason: normalizeFailedReason(result.reason),
                        subject,
                        ...callMeta,
                        latencyMs,
                        ...(result.metrics
                            ? { nativeMetrics: result.metrics }
                            : {}),
                    });
                    const capped = await maybeCreateArchivedCap(
                        text,
                        event,
                        subject,
                        { ...options, onObservation: undefined },
                        aggregatePrefix,
                        meta,
                    );
                    return capped ?? undefined;
                }
                const capped = await maybeCreateArchivedCap(
                    text,
                    event,
                    subject,
                    options,
                    aggregatePrefix,
                    meta,
                );
                if (capped) return capped;
                options?.onObservation?.({
                    kind: "skipped",
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    originalLength: text.length,
                    compressedLength: 0,
                    // Exact benign backend reason, when available.
                    reason: benignSkippedReason(result.reason),
                    subject,
                    ...callMeta,
                    latencyMs,
                    ...(result.metrics
                        ? { nativeMetrics: result.metrics }
                        : {}),
                });
                return;
            }

            const originalLength = text.length;
            const compressedLength = result.output.length;
            if (compressedLength >= originalLength) {
                const capped = await maybeCreateArchivedCap(
                    text,
                    event,
                    subject,
                    options,
                    aggregatePrefix,
                    meta,
                );
                if (capped) return capped;
                options?.onObservation?.({
                    kind: "skipped",
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    originalLength,
                    compressedLength: 0,
                    reason: "not_smaller",
                    subject,
                    ...callMeta,
                    latencyMs,
                    ...(result.metrics
                        ? { nativeMetrics: result.metrics }
                        : {}),
                });
                return;
            }

            const archivePath =
                (await options?.archiveOriginal?.(
                    archiveInput(event, subject, text),
                )) ?? null;
            if (options?.archiveOriginal && !archivePath) {
                throw new Error("archive did not return a path");
            }
            const archiveNote = archivePath
                ? buildEscapeHatchNote(text, archivePath)
                : "";
            const prefix = aggregatePrefix ? `${aggregatePrefix}\n` : "";
            const outputText = `${prefix}${result.output}${archiveNote}`;
            if (outputText.length >= originalLength) {
                options?.onObservation?.({
                    kind: "skipped",
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    originalLength,
                    compressedLength: 0,
                    reason: "not_smaller",
                    subject,
                    ...callMeta,
                    latencyMs,
                    ...(result.metrics
                        ? { nativeMetrics: result.metrics }
                        : {}),
                });
                return;
            }
            const finalCompressedLength = outputText.length;
            const savedBytes = Math.max(
                0,
                originalLength - finalCompressedLength,
            );
            const savedPct =
                originalLength > 0
                    ? Math.round((savedBytes / originalLength) * 100)
                    : 0;

            options?.onObservation?.({
                kind: "compressed",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                originalLength,
                compressedLength: finalCompressedLength,
                originalUtf8Bytes: countUtf8Bytes(text),
                compressedUtf8Bytes: countUtf8Bytes(outputText),
                estimatedTokensBefore: estimateTokens(text),
                estimatedTokensAfter: estimateTokens(outputText),
                subject,
                archivePath: archivePath ?? undefined,
                ...callMeta,
                latencyMs,
                ...(result.metrics ? { nativeMetrics: result.metrics } : {}),
            });
            const compression = {
                originalLength,
                compressedLength: finalCompressedLength,
                savedBytes,
                savedPct,
                originalUtf8Bytes: countUtf8Bytes(text),
                compressedUtf8Bytes: countUtf8Bytes(outputText),
                estimatedTokensBefore: estimateTokens(text),
                estimatedTokensAfter: estimateTokens(outputText),
                ...(archivePath ? { archivePath } : {}),
            } satisfies CompressionDetails;
            return {
                content: [{ type: "text" as const, text: outputText }],
                details: mergedDetails(event.details, compression),
            };
        } catch {
            // A backend throw still gets a measured latency: elapsed time
            // since the call started, never left undefined.
            latencyMs ??= Math.round(performance.now() - startedAt);
            options?.onObservation?.({
                kind: "failed",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                originalLength: text.length,
                compressedLength: 0,
                reason: "service_error",
                subject,
                // Selected-backend config facts only — the engine may never
                // have processed the request, so no tokenizer claim here.
                ...meta,
                latencyMs,
            });
            return;
        }
    };
}

function inputCapOptions(
    toolName: string,
    options: ToolResultHandlerOptions | undefined,
): ToolResultHandlerOptions | undefined {
    if (toolName !== "find" || options?.capFallbackTokens !== undefined) {
        return options;
    }
    return { ...options, capFallbackTokens: DEFAULT_FIND_CAP_TOKENS };
}

/**
 * Maps a backend decline reason to the canonical skipped reason, preserving
 * the exact benign reason when the adapter reports one.
 */
function benignSkippedReason(
    reason: string | undefined,
): CompressionSkippedReason {
    if (reason !== undefined && BENIGN_BACKEND_REASONS.has(reason)) {
        return reason as CompressionSkippedReason;
    }
    return "no_change";
}

export function summarizeToolSubject(
    toolName: string,
    input: object | undefined,
): string | undefined {
    if (!input) return undefined;
    const field = (name: string): unknown => Reflect.get(input, name);
    if (toolName === "read") {
        const path = field("path") ?? field("file_path");
        return typeof path === "string" ? basename(path) : undefined;
    }
    if (toolName === "grep") {
        const path = field("path");
        const pattern = field("pattern");
        if (typeof path === "string") return basename(path);
        return typeof pattern === "string" ? pattern : undefined;
    }
    if (toolName === "ls") {
        const path = field("path");
        return typeof path === "string" ? basename(path) || path : undefined;
    }
    if (toolName === "find") {
        const path = field("path");
        const pattern = field("pattern");
        if (typeof pattern === "string") return pattern;
        return typeof path === "string" ? basename(path) || path : undefined;
    }
    if (toolName === "bash" || toolName === "safe_bash") {
        const command = field("command");
        if (typeof command !== "string") return undefined;
        return command.length > 48 ? `${command.slice(0, 45)}...` : command;
    }
    return undefined;
}
