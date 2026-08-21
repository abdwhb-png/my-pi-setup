// oxlint-disable typescript/no-redundant-type-constituents, typescript/no-unsafe-assignment
import type {
    CompressionBackend,
    CompressionBackendRequest,
    CompressionBackendResult,
    FetchLike,
} from "../types";

export interface EdgeeBackendConfig {
    baseUrl: string;
    timeoutMs: number;
    agent?: string;
}

const DEFAULT_AGENT = "claude";
const SUPPORTED_TOOL_NAMES = new Set(["bash", "read", "grep"]);

type EdgeeResponse = {
    compressed_output?: string | null;
    details?: EdgeeDetails;
};

type EdgeeDetails = {
    tokensBefore?: number;
    tokensAfter?: number;
    tokensSaved?: number;
    tokens_before?: number;
    tokens_after?: number;
    tokens_saved?: number;
    transforms?: string[];
};

function edgeeToolName(toolName: string): string | null {
    if (toolName === "safe_bash") return "bash";
    return SUPPORTED_TOOL_NAMES.has(toolName) ? toolName : null;
}

function asDetails(value: object | undefined): EdgeeDetails | undefined {
    if (!value || Array.isArray(value)) return undefined;
    const details = value as Partial<EdgeeDetails>;
    return details;
}

function numberValue(
    details: EdgeeDetails,
    first: keyof EdgeeDetails,
    second: keyof EdgeeDetails,
): number | undefined {
    for (const key of [first, second]) {
        const value = details[key];
        if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return undefined;
}

function responseMetrics(
    details: object | undefined,
): CompressionBackendResult["metrics"] | undefined {
    const record = asDetails(details);
    if (!record) return undefined;

    const tokensBefore = numberValue(record, "tokensBefore", "tokens_before");
    const tokensAfter = numberValue(record, "tokensAfter", "tokens_after");
    const tokensSaved = numberValue(record, "tokensSaved", "tokens_saved");
    const transforms = record.transforms;

    if (
        tokensBefore === undefined &&
        tokensAfter === undefined &&
        tokensSaved === undefined &&
        transforms === undefined
    ) {
        return undefined;
    }

    return {
        ...(tokensBefore === undefined ? {} : { tokensBefore }),
        ...(tokensAfter === undefined ? {} : { tokensAfter }),
        ...(tokensSaved === undefined ? {} : { tokensSaved }),
        ...(transforms === undefined ? {} : { transforms }),
    };
}

function timeoutError(timeoutMs: number): Error {
    return new Error(`Timed out after ${timeoutMs}ms`);
}

function parseJsonObject(text: string): object | null {
    try {
        const parsed: object = JSON.parse(text);
        return parsed && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export class EdgeeBackend implements CompressionBackend {
    readonly id = "edgee" as const;

    private readonly config: Required<EdgeeBackendConfig>;
    private readonly fetchImpl: FetchLike;

    constructor(config: EdgeeBackendConfig, fetchImpl?: FetchLike) {
        this.config = {
            baseUrl: config.baseUrl,
            timeoutMs: config.timeoutMs,
            agent: config.agent ?? DEFAULT_AGENT,
        };
        this.fetchImpl = fetchImpl ?? globalThis.fetch;
    }

    async compress(
        request: CompressionBackendRequest,
        signal?: AbortSignal,
    ): Promise<CompressionBackendResult> {
        const toolName = edgeeToolName(request.toolName);
        if (!toolName) return { output: null, reason: "unsupported_tool" };
        if (signal?.aborted) return { output: null, reason: "aborted" };

        const controller = new AbortController();
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const abortFromCaller = () => controller.abort();
        signal?.addEventListener("abort", abortFromCaller, { once: true });

        try {
            const fetchRequest: [string, RequestInit] = [
                `${this.config.baseUrl.replace(/\/$/, "")}/compress`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        tool_name: toolName,
                        arguments: JSON.stringify(request.arguments),
                        output: request.output,
                        agent: this.config.agent,
                    }),
                    signal: controller.signal,
                },
            ];
            const fetchPromise = this.fetchImpl(
                fetchRequest[0],
                fetchRequest[1],
            );
            const response = await new Promise<Response>((resolve, reject) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    controller.abort();
                    reject(timeoutError(this.config.timeoutMs));
                }, this.config.timeoutMs);
                fetchPromise.then(resolve, reject);
            });

            if (!response.ok) return { output: null, reason: "http_error" };

            const parsed = parseJsonObject(await response.text());
            if (!parsed) {
                return { output: null, reason: "invalid_response" };
            }
            const payload = parsed as EdgeeResponse;

            if (!Object.hasOwn(payload, "compressed_output")) {
                return { output: null, reason: "invalid_response" };
            }
            if (payload.compressed_output === null) {
                return { output: null, reason: "no_output" };
            }
            if (typeof payload.compressed_output !== "string") {
                return { output: null, reason: "invalid_response" };
            }
            if (payload.compressed_output === "") {
                return { output: null, reason: "no_output" };
            }

            const metrics = responseMetrics(payload.details);
            return metrics
                ? { output: payload.compressed_output, metrics }
                : { output: payload.compressed_output };
        } catch {
            if (timedOut) return { output: null, reason: "timeout" };
            if (signal?.aborted || controller.signal.aborted) {
                return { output: null, reason: "aborted" };
            }
            return { output: null, reason: "service_error" };
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            signal?.removeEventListener("abort", abortFromCaller);
        }
    }

    /**
     * Reachability probe for the health poller. Any HTTP response proves the
     * service is up; a network error or timeout is down.
     */
    async ping(): Promise<boolean> {
        const controller = new AbortController();
        const timer = setTimeout(
            () => controller.abort(),
            this.config.timeoutMs,
        );
        try {
            const response: Response = await this.fetchImpl(
                `${this.config.baseUrl.replace(/\/$/, "")}/`,
                { method: "GET", signal: controller.signal },
            );
            // Drain the body so the socket does not linger in the pool.
            await response.text().catch(() => "");
            return true;
        } catch {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }
}
