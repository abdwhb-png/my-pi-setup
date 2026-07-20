import { basename } from 'node:path';
import type { ToolResultEvent } from '@earendil-works/pi-coding-agent';
import { getActivePolicy } from '../../_shared/audit-mode';
import type { CompressionDetails } from '../../_shared/compression-protocol';
import { getLocalCompressorConfig } from '../config-runtime';
import type {
    ArchiveOriginalInput,
    CompressRequest,
    CompressResponse,
    ToolResultHandlerOptions,
} from './types';

type CompressionRoute = 'edgee' | 'cap';

export function chooseCompressionRoute(input: {
    strategy: 'edgee' | 'benchmark';
    toolName: string;
    text: string;
}): CompressionRoute {
    if (input.strategy !== 'benchmark') return 'edgee';
    if (input.toolName === 'read') return 'edgee';
    if (
        input.toolName === 'grep' ||
        input.toolName === 'bash' ||
        input.toolName === 'safe_bash' ||
        input.toolName === 'ls' ||
        input.toolName === 'find'
    ) {
        return 'cap';
    }
    return 'edgee';
}

function normalizeToolName(toolName: string): string {
    if (toolName === 'safe_bash') return 'bash';
    if (toolName === 'ls' || toolName === 'find') return 'glob';
    return toolName;
}

export function isCompressibleToolName(toolName: string): boolean {
    return (
        toolName === 'read' ||
        toolName === 'grep' ||
        toolName === 'bash' ||
        toolName === 'safe_bash' ||
        toolName === 'ls' ||
        toolName === 'find'
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
): 'search' | 'read' | 'shell' | null {
    if (toolName === 'grep' || toolName === 'find' || toolName === 'ls')
        return 'search';
    if (toolName === 'read') return 'read';
    if (toolName === 'bash' || toolName === 'safe_bash') return 'shell';
    return null;
}

function isTextBlock(
    value: object | null | undefined,
): value is { type: 'text'; text: string } {
    const block = value as { type?: string; text?: string } | null | undefined;
    return block?.type === 'text' && typeof block.text === 'string';
}

export function extractCompressibleText(content: object[]): string | null {
    if (!Array.isArray(content) || content.length === 0) return null;
    if (!content.every(isTextBlock)) return null;
    return content.map((block) => block.text).join('\n');
}

function fullOutputPath(details: unknown): string | undefined {
    if (!details || typeof details !== 'object' || Array.isArray(details))
        return undefined;
    const value = (details as Record<string, unknown>).fullOutputPath;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
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
    if (original && typeof original === 'object' && !Array.isArray(original)) {
        return { ...(original as Record<string, unknown>), compression };
    }
    return original === undefined
        ? { compression }
        : { originalDetails: original, compression };
}

function headTailCap(text: string, targetLength: number): string {
    if (text.length <= targetLength) return text;
    const marker = `\n... [${text.length - targetLength} chars omitted by head/tail cap] ...\n`;
    const room = Math.max(0, targetLength - marker.length);
    const head = Math.floor(room / 2);
    const tail = room - head;
    return text.slice(0, head) + marker + text.slice(text.length - tail);
}

function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        // oxlint-disable-next-line typescript/no-unsafe-assignment
        const timer: ReturnType<typeof setTimeout> = setTimeout(
            () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
            timeoutMs,
        );
        const abort = () => {
            clearTimeout(timer);
            reject(new Error('Aborted'));
        };
        signal?.addEventListener('abort', abort, { once: true });
        promise.then(
            (value) => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                reject(error);
            },
        );
    });
}

async function requestCompression(
    payload: CompressRequest,
    options: Required<
        Pick<ToolResultHandlerOptions, 'fetchImpl' | 'baseUrl' | 'timeoutMs'>
    >,
    signal?: AbortSignal,
): Promise<CompressResponse> {
    const response = await withTimeout(
        options.fetchImpl(`${options.baseUrl.replace(/\/$/, '')}/compress`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal,
        }),
        options.timeoutMs,
        signal,
    );

    if (!response.ok) {
        throw new Error(
            `compression service failed with status ${response.status}`,
        );
    }

    const json = (await response.json()) as {
        compressed_output?: string | null;
    };
    return { compressed_output: json.compressed_output };
}

async function maybeCreateArchivedCap(
    text: string,
    event: ToolResultEvent,
    subject: string | undefined,
    options?: ToolResultHandlerOptions,
) {
    const targetBytes = options?.capFallbackBytes;
    if (
        !targetBytes ||
        targetBytes <= 0 ||
        text.length <= targetBytes ||
        !options?.archiveOriginal
    )
        return null;
    const archivePath = await options.archiveOriginal(
        archiveInput(event, subject, text),
    );
    if (!archivePath) throw new Error('archive did not return a path');
    const note = `\n\nFull original tool result saved: ${archivePath}`;
    const capped = headTailCap(text, Math.max(0, targetBytes - note.length));
    const outputText = `${capped}${note}`;
    if (outputText.length >= text.length) return null;
    const originalLength = text.length;
    const compressedLength = outputText.length;
    const savedBytes = Math.max(0, originalLength - compressedLength);
    const savedPct =
        originalLength > 0
            ? Math.round((savedBytes / originalLength) * 100)
            : 0;

    options.onObservation?.({
        kind: 'compressed',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        originalLength,
        compressedLength,
        subject,
        archivePath,
    });

    const compression = {
        originalLength,
        compressedLength,
        savedBytes,
        savedPct,
        archivePath,
    } satisfies CompressionDetails;
    return {
        content: [{ type: 'text' as const, text: outputText }],
        details: mergedDetails(event.details, compression),
    };
}

export function createToolResultHandler(options?: ToolResultHandlerOptions) {
    const env = getLocalCompressorConfig();
    const fetchImpl = options?.fetchImpl ?? fetch;
    const baseUrl = options?.baseUrl ?? env.baseUrl;
    const agent = options?.agent ?? env.agent;
    const timeoutMs = options?.timeoutMs ?? env.timeoutMs;
    const routingStrategy = options?.routingStrategy ?? env.routingStrategy;
    const enabled = options?.enabled ?? env.enabled;
    const excludedTools = new Set(options?.excludeTools ?? env.excludeTools);
    const legacyMinBytes = options?.minBytes;
    const minBytesByGroup =
        options?.minBytesByGroup ??
        (legacyMinBytes === undefined
            ? env.minBytesByGroup
            : {
                  shell: legacyMinBytes,
                  read: legacyMinBytes,
                  search: legacyMinBytes,
              });

    return async (event: ToolResultEvent, signal?: AbortSignal) => {
        if (event.isError) return;
        if (!isCompressibleToolName(event.toolName)) return;
        if (!enabled || excludedTools.has(event.toolName)) return;

        // Consult shared audit policy — bypass compression if the active profile
        // disables it for this tool's category.
        const policy = getActivePolicy();
        const ctx = toolCompressionContext(event.toolName);
        if (
            (ctx === 'search' && policy['compression.disableForSearch']) ||
            (ctx === 'read' && policy['compression.disableForRead']) ||
            (ctx === 'shell' && policy['compression.disableForShellResults'])
        ) {
            return;
        }

        const subject = summarizeToolSubject(event.toolName, event.input);

        const text = extractCompressibleText(event.content);
        if (!text) {
            options?.onObservation?.({
                kind: 'skipped',
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                originalLength: 0,
                compressedLength: 0,
                reason: 'non_text_content',
                subject,
            });
            return;
        }
        if (!ctx) return;
        if (Buffer.byteLength(text, 'utf8') < minBytesByGroup[ctx]) return;

        try {
            if (
                chooseCompressionRoute({
                    strategy: routingStrategy,
                    toolName: event.toolName,
                    text,
                }) === 'cap'
            ) {
                const capped = await maybeCreateArchivedCap(
                    text,
                    event,
                    subject,
                    options,
                );
                if (capped) return capped;
            }
        } catch {
            options?.onObservation?.({
                kind: 'failed',
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                originalLength: text.length,
                compressedLength: 0,
                reason: 'service_error',
                subject,
            });
            return;
        }

        const payload: CompressRequest = {
            tool_name: normalizeToolName(event.toolName),
            arguments: JSON.stringify(event.input ?? {}),
            output: text,
            agent,
        };

        try {
            const result = await requestCompression(
                payload,
                { fetchImpl, baseUrl, timeoutMs },
                signal,
            );
            if (
                !result.compressed_output ||
                result.compressed_output === text
            ) {
                const capped = await maybeCreateArchivedCap(
                    text,
                    event,
                    subject,
                    options,
                );
                if (capped) return capped;
                options?.onObservation?.({
                    kind: 'skipped',
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    originalLength: text.length,
                    compressedLength: 0,
                    reason: 'no_change',
                    subject,
                });
                return;
            }

            const originalLength = text.length;
            const compressedLength = result.compressed_output.length;
            if (compressedLength >= originalLength) {
                const capped = await maybeCreateArchivedCap(
                    text,
                    event,
                    subject,
                    options,
                );
                if (capped) return capped;
                options?.onObservation?.({
                    kind: 'skipped',
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    originalLength,
                    compressedLength: 0,
                    reason: 'not_smaller',
                    subject,
                });
                return;
            }

            const savedBytes = Math.max(0, originalLength - compressedLength);
            const savedPct =
                originalLength > 0
                    ? Math.round((savedBytes / originalLength) * 100)
                    : 0;
            const archivePath =
                (await options?.archiveOriginal?.(
                    archiveInput(event, subject, text),
                )) ?? null;
            if (options?.archiveOriginal && !archivePath) {
                throw new Error('archive did not return a path');
            }
            const archiveNote = archivePath
                ? `\n\nFull original tool result saved: ${archivePath}`
                : '';
            const outputText = `${result.compressed_output}${archiveNote}`;
            if (outputText.length >= originalLength) {
                options?.onObservation?.({
                    kind: 'skipped',
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    originalLength,
                    compressedLength: 0,
                    reason: 'not_smaller',
                    subject,
                });
                return;
            }

            options?.onObservation?.({
                kind: 'compressed',
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                originalLength,
                compressedLength,
                subject,
                archivePath: archivePath ?? undefined,
            });
            const compression = {
                originalLength,
                compressedLength,
                savedBytes,
                savedPct,
                ...(archivePath ? { archivePath } : {}),
            } satisfies CompressionDetails;
            return {
                content: [{ type: 'text' as const, text: outputText }],
                details: mergedDetails(event.details, compression),
            };
        } catch {
            options?.onObservation?.({
                kind: 'failed',
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                originalLength: text.length,
                compressedLength: 0,
                reason: 'service_error',
                subject,
            });
            return;
        }
    };
}

export function summarizeToolSubject(
    toolName: string,
    input: object | undefined,
): string | undefined {
    if (!input) return undefined;
    const record = input as Record<
        string,
        object | string | number | boolean | undefined
    >;
    if (toolName === 'read') {
        const path = record.path ?? record.file_path;
        return typeof path === 'string' ? basename(path) : undefined;
    }
    if (toolName === 'grep') {
        const path = record.path;
        const pattern = record.pattern;
        if (typeof path === 'string') return basename(path);
        return typeof pattern === 'string' ? pattern : undefined;
    }
    if (toolName === 'ls') {
        const path = record.path;
        return typeof path === 'string' ? basename(path) || path : undefined;
    }
    if (toolName === 'find') {
        const path = record.path;
        const pattern = record.pattern;
        if (typeof pattern === 'string') return pattern;
        return typeof path === 'string' ? basename(path) || path : undefined;
    }
    if (toolName === 'bash' || toolName === 'safe_bash') {
        const command = record.command;
        if (typeof command !== 'string') return undefined;
        return command.length > 48 ? `${command.slice(0, 45)}...` : command;
    }
    return undefined;
}
