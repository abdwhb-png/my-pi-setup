import { randomUUID } from "node:crypto";

export const SUBAGENT_RPC_PROTOCOL_VERSION = 1;
export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";

export type SubagentRpcMethod =
    | "ping"
    | "spawn"
    | "status"
    | "manage"
    | "steer"
    | "interrupt"
    | "stop"
    | "resume";

export interface SubagentRpcEventBus {
    on(event: string, handler: (data: unknown) => void): (() => void) | void;
    emit(event: string, data: unknown): void;
}

export interface SubagentRpcRequestOptions {
    signal?: AbortSignal;
}

export interface SubagentRpcToolResult {
    text: string;
    details?: Record<string, unknown>;
    isError?: boolean;
    fleet?: Record<string, unknown>;
    asyncSnapshot?: Record<string, unknown>;
}

export interface SubagentAsyncCompletion extends Record<string, unknown> {
    id: string;
    runId?: string;
    sessionId?: string;
    success?: boolean;
    state?: string;
    results?: Array<Record<string, unknown>>;
}

export interface SubagentRpcClientOptions {
    sourceExtension?: string;
    timeoutMs?: number;
    requestId?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedIdentity(value: unknown, field: string): string {
    if (
        typeof value !== "string" ||
        !value.trim() ||
        value.length > 256 ||
        /[\r\n]/.test(value)
    ) {
        throw new SubagentRpcError(
            `${field} must be a non-empty string of at most 256 characters without newlines.`,
            "invalid_request",
        );
    }
    return value;
}

function parseToolResult(value: unknown): SubagentRpcToolResult {
    if (!isRecord(value)) {
        throw new SubagentRpcError("Malformed subagent RPC tool result.");
    }
    const text = value.text === undefined ? "" : value.text;
    if (typeof text !== "string") {
        throw new SubagentRpcError("Malformed subagent RPC tool result text.");
    }
    for (const field of ["details", "fleet", "asyncSnapshot"] as const) {
        if (value[field] !== undefined && !isRecord(value[field])) {
            throw new SubagentRpcError(
                `Malformed subagent RPC tool result ${field}.`,
            );
        }
    }
    if (value.isError !== undefined && typeof value.isError !== "boolean") {
        throw new SubagentRpcError(
            "Malformed subagent RPC tool result isError.",
        );
    }
    return {
        text,
        ...(isRecord(value.details) ? { details: value.details } : {}),
        ...(value.isError === true ? { isError: true } : {}),
        ...(isRecord(value.fleet) ? { fleet: value.fleet } : {}),
        ...(isRecord(value.asyncSnapshot)
            ? { asyncSnapshot: value.asyncSnapshot }
            : {}),
    };
}

function parseCompletion(value: unknown): SubagentAsyncCompletion | undefined {
    if (!isRecord(value)) return undefined;
    const identity =
        typeof value.id === "string" && value.id.trim()
            ? value.id
            : typeof value.runId === "string" && value.runId.trim()
              ? value.runId
              : undefined;
    if (!identity || identity.length > 256 || /[\r\n]/.test(identity)) {
        return undefined;
    }
    if (
        value.sessionId !== undefined &&
        (typeof value.sessionId !== "string" ||
            !value.sessionId.trim() ||
            value.sessionId.length > 4_096)
    ) {
        return undefined;
    }
    if (value.success !== undefined && typeof value.success !== "boolean") {
        return undefined;
    }
    if (value.state !== undefined && typeof value.state !== "string") {
        return undefined;
    }
    if (
        value.results !== undefined &&
        (!Array.isArray(value.results) ||
            value.results.some((result) => !isRecord(result)))
    ) {
        return undefined;
    }
    return {
        ...value,
        id: identity,
        ...(Array.isArray(value.results)
            ? { results: value.results as Array<Record<string, unknown>> }
            : {}),
    };
}

export class SubagentRpcError extends Error {
    constructor(
        message: string,
        readonly code = "rpc_error",
    ) {
        super(message);
        this.name = "SubagentRpcError";
    }
}

export class SubagentRpcClient {
    private readonly sourceExtension: string;
    private readonly timeoutMs: number;
    private readonly createRequestId: () => string;
    private readonly cancelPending = new Set<
        (error: SubagentRpcError) => void
    >();
    private readonly completionUnsubscribers = new Set<() => void>();
    private disposed = false;

    constructor(
        private readonly events: SubagentRpcEventBus,
        options: SubagentRpcClientOptions = {},
    ) {
        this.sourceExtension = boundedIdentity(
            options.sourceExtension ?? "pi-subagents-addons",
            "Subagent RPC source extension",
        );
        this.timeoutMs = options.timeoutMs ?? 2_000;
        if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
            throw new SubagentRpcError(
                "Subagent RPC timeoutMs must be positive.",
                "invalid_request",
            );
        }
        this.createRequestId = options.requestId ?? randomUUID;
    }

    ping(
        options?: SubagentRpcRequestOptions,
    ): Promise<Record<string, unknown>> {
        return this.request("ping", undefined, options).then((value) => {
            if (!isRecord(value)) {
                throw new SubagentRpcError(
                    "Malformed subagent RPC ping result.",
                );
            }
            return value;
        });
    }

    spawn(
        params: Record<string, unknown>,
        options?: SubagentRpcRequestOptions,
    ): Promise<SubagentRpcToolResult> {
        return this.request("spawn", params, options).then(parseToolResult);
    }

    status(
        params: Record<string, unknown> = {},
        options?: SubagentRpcRequestOptions,
    ): Promise<SubagentRpcToolResult> {
        return this.request("status", params, options).then(parseToolResult);
    }

    manage(
        params: Record<string, unknown>,
        options?: SubagentRpcRequestOptions,
    ): Promise<SubagentRpcToolResult> {
        return this.request("manage", params, options).then(parseToolResult);
    }

    steer(
        params: Record<string, unknown>,
        options?: SubagentRpcRequestOptions,
    ): Promise<SubagentRpcToolResult> {
        return this.request("steer", params, options).then(parseToolResult);
    }

    interrupt(
        params: Record<string, unknown>,
        options?: SubagentRpcRequestOptions,
    ): Promise<SubagentRpcToolResult> {
        return this.request("interrupt", params, options).then(parseToolResult);
    }

    stop(
        params: Record<string, unknown>,
        options?: SubagentRpcRequestOptions,
    ): Promise<SubagentRpcToolResult> {
        return this.request("stop", params, options).then(parseToolResult);
    }

    resume(
        params: Record<string, unknown>,
        options?: SubagentRpcRequestOptions,
    ): Promise<SubagentRpcToolResult> {
        return this.request("resume", params, options).then(parseToolResult);
    }

    onAsyncComplete(
        handler: (completion: SubagentAsyncCompletion) => void,
        malformed?: (
            error: SubagentRpcError,
            identity: { runId?: string; sessionId?: string },
        ) => void,
    ): () => void {
        if (this.disposed)
            throw new SubagentRpcError(
                "Subagent RPC client is disposed.",
                "disposed",
            );
        const unsubscribe =
            this.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (value) => {
                const completion = parseCompletion(value);
                if (completion) handler(completion);
                else if (malformed)
                    malformed(
                        new SubagentRpcError(
                            "Malformed subagent async completion.",
                            "invalid_completion",
                        ),
                        {
                            ...(isRecord(value) &&
                            typeof (value.id ?? value.runId) === "string"
                                ? { runId: String(value.id ?? value.runId) }
                                : {}),
                            ...(isRecord(value) &&
                            typeof value.sessionId === "string"
                                ? { sessionId: value.sessionId }
                                : {}),
                        },
                    );
            }) ?? (() => undefined);
        let active = true;
        const release = () => {
            if (!active) return;
            active = false;
            this.completionUnsubscribers.delete(release);
            unsubscribe();
        };
        this.completionUnsubscribers.add(release);
        return release;
    }

    private request(
        method: SubagentRpcMethod,
        params?: Record<string, unknown>,
        options: SubagentRpcRequestOptions = {},
    ): Promise<unknown> {
        if (this.disposed) {
            return Promise.reject(
                new SubagentRpcError(
                    "Subagent RPC client is disposed.",
                    "disposed",
                ),
            );
        }
        if (options.signal?.aborted) {
            return Promise.reject(
                new SubagentRpcError(
                    `Subagent RPC ${method} was aborted.`,
                    "aborted",
                ),
            );
        }
        let requestId: string;
        try {
            requestId = boundedIdentity(
                this.createRequestId(),
                "Subagent RPC requestId",
            );
        } catch (error) {
            return Promise.reject(error);
        }
        const replyEvent = `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`;

        return new Promise((resolve, reject) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let unsubscribe: (() => void) | void;
            const onAbort = () =>
                cancel(
                    new SubagentRpcError(
                        `Subagent RPC ${method} was aborted.`,
                        "aborted",
                    ),
                );
            const settle = (callback: () => void): void => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                options.signal?.removeEventListener("abort", onAbort);
                unsubscribe?.();
                this.cancelPending.delete(cancel);
                callback();
            };
            const cancel = (error: SubagentRpcError): void =>
                settle(() => reject(error));

            unsubscribe = this.events.on(replyEvent, (payload) => {
                if (
                    !isRecord(payload) ||
                    payload.version !== SUBAGENT_RPC_PROTOCOL_VERSION ||
                    payload.requestId !== requestId ||
                    payload.method !== method ||
                    typeof payload.success !== "boolean"
                ) {
                    cancel(
                        new SubagentRpcError("Mismatched subagent RPC reply."),
                    );
                    return;
                }
                if (!payload.success) {
                    const error = isRecord(payload.error) ? payload.error : {};
                    cancel(
                        new SubagentRpcError(
                            typeof error.message === "string"
                                ? error.message
                                : "Subagent RPC request failed.",
                            typeof error.code === "string"
                                ? error.code
                                : "rpc_error",
                        ),
                    );
                    return;
                }
                settle(() => resolve(payload.data));
            });
            this.cancelPending.add(cancel);
            options.signal?.addEventListener("abort", onAbort, { once: true });
            timer = setTimeout(
                () =>
                    cancel(
                        new SubagentRpcError(
                            `Subagent RPC ${method} timed out.`,
                            "timeout",
                        ),
                    ),
                this.timeoutMs,
            );
            timer.unref?.();

            this.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
                version: SUBAGENT_RPC_PROTOCOL_VERSION,
                requestId,
                method,
                ...(params ? { params } : {}),
                source: { extension: this.sourceExtension },
            });
        });
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const unsubscribe of this.completionUnsubscribers) {
            unsubscribe();
        }
        const error = new SubagentRpcError(
            "Subagent RPC client is disposed.",
            "disposed",
        );
        for (const cancel of this.cancelPending) cancel(error);
    }
}

export type EventBusLike = SubagentRpcEventBus;
export interface FleetStatusEntryV1 {
    key: string;
    agent: string;
    role?: string;
    model?: string;
    effort?: string;
    goal?: string;
    startedAt: number;
    tokens: { input: number; output: number; total: number };
}

export interface FleetStatusV1 {
    version: 1;
    entries: FleetStatusEntryV1[];
    totalActive: number;
    omitted: number;
}

function isCount(value: unknown): value is number {
    return (
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    );
}

function displayText(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const text = value
        .slice(0, 4_096)
        .replace(
            /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b][\s\S]*?(?:\x07|\x1b\\)|\x1b[PX^_][\s\S]*?\x1b\\|[\u0000-\u001f\u007f-\u009f]/g,
            " ",
        )
        .replace(/\s+/g, " ")
        .trim();
    return text || undefined;
}

function parseFleetEntry(value: unknown): FleetStatusEntryV1 | undefined {
    if (!isRecord(value) || !isRecord(value.tokens)) return undefined;
    const key = displayText(value.key);
    const agent = displayText(value.agent);
    if (
        !key ||
        !agent ||
        !isCount(value.startedAt) ||
        !isCount(value.tokens.input) ||
        !isCount(value.tokens.output) ||
        !isCount(value.tokens.total)
    ) {
        return undefined;
    }
    const role = displayText(value.role);
    const model = displayText(value.model);
    const effort = displayText(value.effort);
    const goal = displayText(value.goal);
    return {
        key,
        agent,
        ...(role ? { role } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(goal ? { goal } : {}),
        startedAt: value.startedAt,
        tokens: {
            input: value.tokens.input,
            output: value.tokens.output,
            total: value.tokens.total,
        },
    };
}

export function parseFleetStatus(value: unknown): FleetStatusV1 | undefined {
    if (
        !isRecord(value) ||
        value.version !== 1 ||
        !Array.isArray(value.entries) ||
        !isCount(value.totalActive) ||
        !isCount(value.omitted)
    ) {
        return undefined;
    }
    const entries = value.entries.map(parseFleetEntry);
    if (entries.some((entry) => entry === undefined)) return undefined;
    return {
        version: 1,
        entries: entries.filter(
            (entry): entry is FleetStatusEntryV1 => entry !== undefined,
        ),
        totalActive: value.totalActive,
        omitted: value.omitted,
    };
}
