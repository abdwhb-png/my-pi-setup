import { mapHeadroomModel } from "./headroom-models";
// oxlint-disable typescript/no-unsafe-assignment
import type {
    CompressionBackend,
    CompressionBackendRequest,
    CompressionBackendResult,
    FetchLike,
} from "./types";

interface HeadroomBackendOptions {
    baseUrl?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
}

interface HeadroomToolMessage {
    role: "tool";
    tool_call_id: string;
    content: string;
}

interface HeadroomResponse {
    messages: HeadroomToolMessage[];
    tokens_before?: number;
    tokens_after?: number;
    tokens_saved?: number;
    compression_ratio?: number;
    transforms_applied?: string[];
    ccr_hashes?: string[];
}

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_TIMEOUT_MS = 5_000;
const defaultFetch: FetchLike = (input, init) =>
    globalThis.fetch(input, init) as Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
    return (
        Array.isArray(value) && value.every((item) => typeof item === "string")
    );
}

function parseResponse(value: unknown, toolCallId: string): HeadroomResponse {
    if (
        !isRecord(value) ||
        !Array.isArray(value.messages) ||
        value.messages.length !== 1
    ) {
        throw new Error("invalid messages");
    }

    const messages: unknown[] = value.messages;
    const message = messages[0];
    if (
        !isRecord(message) ||
        message.role !== "tool" ||
        message.tool_call_id !== toolCallId ||
        typeof message.content !== "string" ||
        message.content.length === 0
    ) {
        throw new Error("invalid correlated tool message");
    }
    const toolMessage: HeadroomToolMessage = {
        role: "tool",
        tool_call_id: message.tool_call_id,
        content: message.content,
    };

    const numericFields = [
        "tokens_before",
        "tokens_after",
        "tokens_saved",
        "compression_ratio",
    ] as const;
    for (const field of numericFields) {
        if (field in value && !isNonNegativeFiniteNumber(value[field])) {
            throw new Error(`invalid ${field}`);
        }
    }
    if (
        "transforms_applied" in value &&
        !isStringArray(value.transforms_applied)
    ) {
        throw new Error("invalid transforms_applied");
    }
    if ("ccr_hashes" in value && !isStringArray(value.ccr_hashes)) {
        throw new Error("invalid ccr_hashes");
    }

    return {
        messages: [toolMessage],
        ...(isNonNegativeFiniteNumber(value.tokens_before)
            ? { tokens_before: value.tokens_before }
            : {}),
        ...(isNonNegativeFiniteNumber(value.tokens_after)
            ? { tokens_after: value.tokens_after }
            : {}),
        ...(isNonNegativeFiniteNumber(value.tokens_saved)
            ? { tokens_saved: value.tokens_saved }
            : {}),
        ...(isNonNegativeFiniteNumber(value.compression_ratio)
            ? { compression_ratio: value.compression_ratio }
            : {}),
        ...(isStringArray(value.transforms_applied)
            ? { transforms_applied: value.transforms_applied }
            : {}),
        ...(isStringArray(value.ccr_hashes)
            ? { ccr_hashes: value.ccr_hashes }
            : {}),
    };
}

function resultFromResponse(
    response: HeadroomResponse,
    originalOutput: string,
): CompressionBackendResult {
    const message = response.messages[0];
    const metrics = {
        ...(response.tokens_before !== undefined
            ? { tokensBefore: response.tokens_before }
            : {}),
        ...(response.tokens_after !== undefined
            ? { tokensAfter: response.tokens_after }
            : {}),
        ...(response.tokens_saved !== undefined
            ? { tokensSaved: response.tokens_saved }
            : {}),
        ...(response.compression_ratio !== undefined
            ? { compressionRatio: response.compression_ratio }
            : {}),
        ...(response.transforms_applied !== undefined
            ? { transforms: response.transforms_applied }
            : {}),
        ...(response.ccr_hashes !== undefined
            ? { ccrHashes: response.ccr_hashes }
            : {}),
    };

    if (message.content === originalOutput) {
        return { output: null, reason: "no_change", metrics };
    }
    if (message.content.length >= originalOutput.length) {
        return { output: null, reason: "not_shorter", metrics };
    }
    return { output: message.content, metrics };
}

export class HeadroomBackend implements CompressionBackend {
    readonly id = "headroom" as const;

    private readonly baseUrl: string;
    private readonly timeoutMs: number;
    private readonly fetchImpl: FetchLike;

    constructor(options: HeadroomBackendOptions = {}) {
        this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.fetchImpl = options.fetchImpl ?? defaultFetch;
    }

    async compress(
        request: CompressionBackendRequest,
        signal?: AbortSignal,
    ): Promise<CompressionBackendResult> {
        if (signal?.aborted) return { output: null, reason: "aborted" };

        const controller = new AbortController();
        let timedOut = false;
        let callerAborted = false;
        const timeout: ReturnType<typeof setTimeout> = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, this.timeoutMs);
        const forwardAbort = () => {
            callerAborted = true;
            controller.abort();
        };
        signal?.addEventListener("abort", forwardAbort, { once: true });

        try {
            const response: Response = await this.fetchImpl(
                `${this.baseUrl}/v1/compress`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        messages: [
                            {
                                role: "tool",
                                tool_call_id: request.toolCallId,
                                content: request.output,
                            },
                        ],
                        model: mapHeadroomModel(request.model.id),
                        config: { protect_recent: 0 },
                    }),
                    signal: controller.signal,
                },
            );

            if (!response.ok) {
                return { output: null, reason: `http_${response.status}` };
            }

            const text = await response.text();
            let body: unknown;
            try {
                body = JSON.parse(text) as unknown;
            } catch {
                return { output: null, reason: "invalid_json" };
            }

            try {
                return resultFromResponse(
                    parseResponse(body, request.toolCallId),
                    request.output,
                );
            } catch {
                return { output: null, reason: "invalid_response" };
            }
        } catch {
            if (timedOut) return { output: null, reason: "timeout" };
            if (callerAborted) return { output: null, reason: "aborted" };
            return { output: null, reason: "service_error" };
        } finally {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", forwardAbort);
        }
    }
}
