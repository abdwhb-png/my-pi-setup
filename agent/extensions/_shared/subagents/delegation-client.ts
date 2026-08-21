import {
    SUBAGENT_DELEGATION_CANCEL_EVENT,
    SUBAGENT_DELEGATION_REQUEST_EVENT,
    SUBAGENT_DELEGATION_RESPONSE_EVENT,
    SUBAGENT_DELEGATION_STARTED_EVENT,
    SUBAGENT_DELEGATION_UPDATE_EVENT,
} from "pi-subagents/delegation";
import {
    type SddDelegationRequest,
    type SddDelegationResponse,
    type SddDelegationStarted,
    type SddDelegationUpdate,
} from "../../sdd-orchestrator/delegation-contract.ts";

const noop = () => {};
const terminalStatuses = [
    "completed",
    "failed",
    "timed_out",
    "cancelled",
    "interrupted",
    "turn_budget_exhausted",
    "tool_budget_exhausted",
    "structured_output_failed",
    "acceptance_failed",
    "invalid_request",
    "unavailable_context",
    "duplicate_node",
] as const satisfies ReadonlyArray<SddDelegationResponse["status"]>;

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
    return typeof value === "object" && value !== null;
}

function isValidRequestId(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.trim().length > 0 &&
        value.length <= 256 &&
        !/[\r\n]/.test(value)
    );
}

function parseStarted(value: unknown): DelegationStarted | undefined {
    if (
        !isRecord(value) ||
        !isValidRequestId(value.requestId) ||
        !isValidRequestId(value.ownerRunId) ||
        !isValidRequestId(value.nodeId)
    ) {
        return undefined;
    }
    return {
        requestId: value.requestId,
        ownerRunId: value.ownerRunId,
        nodeId: value.nodeId,
    };
}

function isOptionalString(value: unknown): value is string | undefined {
    return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown): value is number | undefined {
    return value === undefined || typeof value === "number";
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
    return (
        value === undefined ||
        (Array.isArray(value) &&
            value.every((item) => typeof item === "string"))
    );
}

function isOptionalRecentTools(
    value: unknown,
): value is SddDelegationUpdate["recentTools"] {
    return (
        value === undefined ||
        (Array.isArray(value) &&
            value.every(
                (item) =>
                    isRecord(item) &&
                    typeof item.tool === "string" &&
                    typeof item.args === "string",
            ))
    );
}

function parseUpdate(value: unknown): SddDelegationUpdate | undefined {
    const started = parseStarted(value);
    if (!started || !isRecord(value)) return undefined;
    if (
        !isOptionalString(value.currentTool) ||
        !isOptionalString(value.currentToolArgs) ||
        !isOptionalString(value.recentOutput) ||
        !isOptionalStringArray(value.recentOutputLines) ||
        !isOptionalRecentTools(value.recentTools) ||
        !isOptionalString(value.model) ||
        !isOptionalNumber(value.toolCount) ||
        !isOptionalNumber(value.durationMs) ||
        !isOptionalNumber(value.tokens)
    ) {
        return undefined;
    }

    const update: SddDelegationUpdate = started;
    if (value.currentTool !== undefined) update.currentTool = value.currentTool;
    if (value.currentToolArgs !== undefined) {
        update.currentToolArgs = value.currentToolArgs;
    }
    if (value.recentOutput !== undefined)
        update.recentOutput = value.recentOutput;
    if (value.recentOutputLines !== undefined) {
        update.recentOutputLines = [...value.recentOutputLines];
    }
    if (value.recentTools !== undefined) {
        update.recentTools = value.recentTools.map(({ tool, args }) => ({
            tool,
            args,
        }));
    }
    if (value.model !== undefined) update.model = value.model;
    if (value.toolCount !== undefined) update.toolCount = value.toolCount;
    if (value.durationMs !== undefined) update.durationMs = value.durationMs;
    if (value.tokens !== undefined) update.tokens = value.tokens;
    return update;
}

function isTerminalStatus(
    value: unknown,
): value is SddDelegationResponse["status"] {
    return terminalStatuses.some((status) => status === value);
}

function parseResult(value: unknown): SddDelegationResponse["result"] {
    if (value === undefined) return undefined;
    if (!isRecord(value)) return undefined;
    if (value.kind === "text" && typeof value.text === "string") {
        return { kind: "text", text: value.text };
    }
    if (value.kind === "structured" && Object.hasOwn(value, "value")) {
        return { kind: "structured", value: value.value };
    }
    return undefined;
}

function parseUsage(value: unknown): SddDelegationResponse["usage"] {
    if (value === undefined) return undefined;
    if (!isRecord(value)) return undefined;
    const fields = [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "cost",
        "turns",
        "toolCalls",
        "durationMs",
    ] as const;
    if (fields.some((field) => typeof value[field] !== "number")) {
        return undefined;
    }
    return {
        input: value.input as number,
        output: value.output as number,
        cacheRead: value.cacheRead as number,
        cacheWrite: value.cacheWrite as number,
        cost: value.cost as number,
        turns: value.turns as number,
        toolCalls: value.toolCalls as number,
        durationMs: value.durationMs as number,
    };
}

function parseTerminalResponse(
    value: unknown,
): SddDelegationResponse | undefined {
    if (
        !isRecord(value) ||
        !isValidRequestId(value.requestId) ||
        !isTerminalStatus(value.status)
    ) {
        return undefined;
    }
    const invalidRequest = value.status === "invalid_request";
    if (
        !invalidRequest &&
        (!isValidRequestId(value.ownerRunId) || !isValidRequestId(value.nodeId))
    ) {
        return undefined;
    }
    if (
        invalidRequest &&
        ((value.ownerRunId !== undefined &&
            !isValidRequestId(value.ownerRunId)) ||
            (value.nodeId !== undefined && !isValidRequestId(value.nodeId)))
    ) {
        return undefined;
    }
    const result = parseResult(value.result);
    const usage = parseUsage(value.usage);
    if (
        !isOptionalString(value.error) ||
        !isOptionalString(value.runId) ||
        !isOptionalString(value.agent) ||
        !isOptionalString(value.model) ||
        !isOptionalString(value.thinking) ||
        !isOptionalNumber(value.exitCode) ||
        !isOptionalString(value.launchContractDigest) ||
        (value.result !== undefined && result === undefined) ||
        (value.usage !== undefined && usage === undefined)
    ) {
        return undefined;
    }

    const response: SddDelegationResponse = {
        requestId: value.requestId,
        ...(typeof value.ownerRunId === "string"
            ? { ownerRunId: value.ownerRunId }
            : {}),
        ...(typeof value.nodeId === "string" ? { nodeId: value.nodeId } : {}),
        status: value.status,
    };
    if (value.error !== undefined) response.error = value.error;
    if (value.runId !== undefined) response.runId = value.runId;
    if (value.agent !== undefined) response.agent = value.agent;
    if (value.model !== undefined) response.model = value.model;
    if (value.thinking !== undefined) response.thinking = value.thinking;
    if (value.exitCode !== undefined) response.exitCode = value.exitCode;
    if (value.launchContractDigest !== undefined) {
        response.launchContractDigest = value.launchContractDigest;
    }
    if (result !== undefined) response.result = result;
    if (usage !== undefined) response.usage = usage;
    return response;
}

export interface EventBus {
    on(channel: string, handler: (data: unknown) => void): () => void;
    emit(channel: string, data: unknown): void;
}

export interface DelegationRunOptions {
    signal?: AbortSignal;
    deadlineMs?: number;
    onStarted?(event: DelegationStarted): void;
    onUpdate?(event: SddDelegationUpdate): void;
}

/** Injectable only to make deadline behavior deterministic at the boundary. */
export interface DelegationClientOptions {
    createDeadlineSignal?: (deadlineMs: number) => AbortSignal;
}

type DelegationStarted = SddDelegationStarted;

interface PendingDelegation {
    identity: DelegationStarted;
    cancelEmitted: boolean;
    cleanup(): void;
    onStarted?(event: DelegationStarted): void;
    onUpdate?(event: SddDelegationUpdate): void;
    reject(error: Error): void;
    resolve(response: SddDelegationResponse): void;
}

export class DelegationDeadlineError extends Error {
    constructor(requestId: string) {
        super(`Delegation request ${requestId} exceeded its deadline.`);
        this.name = "DelegationDeadlineError";
    }
}

export class DelegationDisposedError extends Error {
    constructor() {
        super("Delegation client is disposed.");
        this.name = "DelegationDisposedError";
    }
}

export class DelegationDetachedError extends Error {
    constructor(requestId: string) {
        super(`Delegation request ${requestId} was cancelled and detached.`);
        this.name = "DelegationDetachedError";
    }
}

export class DelegationClient {
    private readonly pending = new Map<string, PendingDelegation>();
    private readonly unsubscribers: Array<() => void>;
    private readonly createDeadlineSignal: (deadlineMs: number) => AbortSignal;
    private disposed = false;

    constructor(
        private readonly events: EventBus,
        options: DelegationClientOptions = {},
    ) {
        this.createDeadlineSignal =
            options.createDeadlineSignal ??
            ((deadlineMs) => AbortSignal.timeout(deadlineMs));
        this.unsubscribers = [
            events.on(SUBAGENT_DELEGATION_STARTED_EVENT, (data) => {
                const event = parseStarted(data);
                if (!event) return;
                const pending = this.pending.get(event.requestId);
                if (!pending || !this.matchesPending(pending, event)) return;
                pending.onStarted?.(event);
            }),
            events.on(SUBAGENT_DELEGATION_UPDATE_EVENT, (data) => {
                const event = parseUpdate(data);
                if (!event) return;
                const pending = this.pending.get(event.requestId);
                if (!pending || !this.matchesPending(pending, event)) return;
                pending.onUpdate?.(event);
            }),
            events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (data) => {
                const response = parseTerminalResponse(data);
                if (!response) return;

                const pending = this.pending.get(response.requestId);
                if (!pending || !this.matchesPending(pending, response)) return;

                this.pending.delete(response.requestId);
                pending.cleanup();
                pending.resolve(response);
            }),
        ];
    }

    run(
        request: SddDelegationRequest,
        options: DelegationRunOptions = {},
    ): Promise<SddDelegationResponse> {
        if (this.disposed) return Promise.reject(new DelegationDisposedError());
        if (!isValidRequestId(request.requestId)) {
            return Promise.reject(
                new Error(
                    "Delegation requestId must be a non-empty string of at most 256 characters without newlines.",
                ),
            );
        }
        if (this.pending.has(request.requestId)) {
            return Promise.reject(
                new Error(
                    `Delegation request ${request.requestId} is already active.`,
                ),
            );
        }

        let resolveRun!: (response: SddDelegationResponse) => void;
        let rejectRun!: (error: Error) => void;
        const result = new Promise<SddDelegationResponse>((resolve, reject) => {
            resolveRun = resolve;
            rejectRun = reject;
        });
        const onAbort = () => this.cancel(request.requestId);
        let clearDeadline = noop;
        const pending: PendingDelegation = {
            identity: {
                requestId: request.requestId,
                ownerRunId: request.ownerRunId,
                nodeId: request.nodeId,
            },
            cancelEmitted: false,
            cleanup: () => {
                options.signal?.removeEventListener("abort", onAbort);
                clearDeadline();
            },
            onStarted: (event) => options.onStarted?.(event),
            onUpdate: (event) => options.onUpdate?.(event),
            reject: rejectRun,
            resolve: resolveRun,
        };
        this.pending.set(request.requestId, pending);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.deadlineMs !== undefined && options.deadlineMs > 0) {
            const deadlineSignal = this.createDeadlineSignal(
                options.deadlineMs,
            );
            const onDeadline = () => {
                if (this.pending.get(request.requestId) !== pending) return;

                this.pending.delete(request.requestId);
                pending.cleanup();
                this.emitCancel(pending);
                pending.reject(new DelegationDeadlineError(request.requestId));
            };
            deadlineSignal.addEventListener("abort", onDeadline, {
                once: true,
            });
            clearDeadline = () =>
                deadlineSignal.removeEventListener("abort", onDeadline);
        }
        if (options.signal?.aborted) this.cancel(request.requestId);
        this.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
        return result;
    }

    cancel(requestId: string): void {
        const pending = this.pending.get(requestId);
        if (!pending) return;

        this.emitCancel(pending);
    }

    /**
     * Cancel a request and release all local listeners even if its child never
     * sends a terminal response. Normal cancel() remains available to callers
     * that intentionally wait for the terminal event.
     */
    cancelAndDetach(requestId: string): boolean {
        const pending = this.pending.get(requestId);
        if (!pending) return false;

        this.pending.delete(requestId);
        pending.cleanup();
        this.emitCancel(pending);
        pending.reject(new DelegationDetachedError(requestId));
        return true;
    }

    dispose(): void {
        if (this.disposed) return;

        this.disposed = true;
        for (const unsubscribe of this.unsubscribers) unsubscribe();
        for (const [requestId, pending] of this.pending) {
            this.pending.delete(requestId);
            pending.cleanup();
            pending.reject(new DelegationDisposedError());
        }
    }

    private emitCancel(pending: PendingDelegation): void {
        if (pending.cancelEmitted) return;

        pending.cancelEmitted = true;
        this.events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, pending.identity);
    }

    private matchesPending(
        pending: PendingDelegation,
        event: Pick<
            SddDelegationResponse,
            "requestId" | "ownerRunId" | "nodeId"
        >,
    ): boolean {
        return (
            event.requestId === pending.identity.requestId &&
            event.ownerRunId === pending.identity.ownerRunId &&
            event.nodeId === pending.identity.nodeId
        );
    }
}
