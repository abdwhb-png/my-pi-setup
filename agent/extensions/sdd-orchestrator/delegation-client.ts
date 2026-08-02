import {
    SUBAGENT_DELEGATION_CANCEL_EVENT,
    SUBAGENT_DELEGATION_REQUEST_EVENT,
    SUBAGENT_DELEGATION_RESPONSE_EVENT,
    SUBAGENT_DELEGATION_STARTED_EVENT,
    SUBAGENT_DELEGATION_UPDATE_EVENT,
    type SubagentDelegationRequest,
    type SubagentDelegationResponse,
    type SubagentDelegationUpdate,
} from 'pi-subagents/delegation';

const noop = () => {};
const terminalStatuses = [
    'completed',
    'failed',
    'timed_out',
    'cancelled',
    'interrupted',
    'turn_budget_exhausted',
    'tool_budget_exhausted',
    'structured_output_failed',
    'acceptance_failed',
    'invalid_request',
    'unavailable_context',
] as const satisfies ReadonlyArray<SubagentDelegationResponse['status']>;
type DelegationAcceptance = NonNullable<
    SubagentDelegationResponse['acceptance']
>;
type DelegationEvidenceStatus = DelegationAcceptance['evidenceStatus'];
const acceptanceStatuses = [
    'pending',
    'not-required',
    'claimed',
    'attested',
    'checked',
    'verified',
    'review-required',
    'reviewed',
    'accepted',
    'rejected',
] as const satisfies ReadonlyArray<DelegationAcceptance['status']>;
const evidenceStatuses = [
    'pending',
    'not-required',
    'claimed',
    'attested',
    'checked',
    'verified',
    'rejected',
] as const satisfies ReadonlyArray<DelegationEvidenceStatus>;

interface ParsedAcceptance {
    status: DelegationAcceptance['status'];
    evidenceStatus?: DelegationEvidenceStatus;
    explicit: boolean;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
    return typeof value === 'object' && value !== null;
}

function isValidRequestId(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        value.trim().length > 0 &&
        value.length <= 256 &&
        !/[\r\n]/.test(value)
    );
}

function parseStarted(value: unknown): DelegationStarted | undefined {
    if (
        !isRecord(value) ||
        value.version !== 1 ||
        !isValidRequestId(value.requestId)
    ) {
        return undefined;
    }
    return { version: 1, requestId: value.requestId };
}

function isOptionalString(value: unknown): value is string | undefined {
    return value === undefined || typeof value === 'string';
}

function isOptionalNumber(value: unknown): value is number | undefined {
    return value === undefined || typeof value === 'number';
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
    return (
        value === undefined ||
        (Array.isArray(value) &&
            value.every((item) => typeof item === 'string'))
    );
}

function isOptionalRecentTools(
    value: unknown,
): value is SubagentDelegationUpdate['recentTools'] {
    return (
        value === undefined ||
        (Array.isArray(value) &&
            value.every(
                (item) =>
                    isRecord(item) &&
                    typeof item.tool === 'string' &&
                    typeof item.args === 'string',
            ))
    );
}

function parseUpdate(value: unknown): SubagentDelegationUpdate | undefined {
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

    const update: SubagentDelegationUpdate = started;
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
): value is SubagentDelegationResponse['status'] {
    return terminalStatuses.some((status) => status === value);
}

function isOptionalAcceptance(
    value: unknown,
): value is ParsedAcceptance | undefined {
    return (
        value === undefined ||
        (isRecord(value) &&
            acceptanceStatuses.some((status) => status === value.status) &&
            typeof value.explicit === 'boolean' &&
            (value.evidenceStatus === undefined ||
                evidenceStatuses.some(
                    (status) => status === value.evidenceStatus,
                )))
    );
}

function fallbackEvidenceStatus(
    status: DelegationAcceptance['status'],
): DelegationEvidenceStatus {
    if (
        status === 'review-required' ||
        status === 'reviewed' ||
        status === 'accepted'
    ) {
        return 'verified';
    }
    return status;
}

function parseTerminalResponse(
    value: unknown,
): SubagentDelegationResponse | undefined {
    const started = parseStarted(value);
    if (!started || !isRecord(value) || !isTerminalStatus(value.status)) {
        return undefined;
    }
    if (
        !isOptionalString(value.error) ||
        !isOptionalString(value.runId) ||
        !isOptionalNumber(value.childIndex) ||
        !isOptionalString(value.agent) ||
        !isOptionalString(value.model) ||
        !isOptionalNumber(value.exitCode) ||
        !isOptionalString(value.output) ||
        !isOptionalString(value.outputPath) ||
        !isOptionalString(value.sessionFile) ||
        !isOptionalAcceptance(value.acceptance) ||
        !isOptionalNumber(value.turns) ||
        !isOptionalNumber(value.toolCount) ||
        !isOptionalNumber(value.durationMs) ||
        !isOptionalNumber(value.tokens) ||
        !isOptionalStringArray(value.warnings)
    ) {
        return undefined;
    }

    const response: SubagentDelegationResponse = {
        ...started,
        status: value.status,
    };
    if (value.error !== undefined) response.error = value.error;
    if (value.runId !== undefined) response.runId = value.runId;
    if (value.childIndex !== undefined) response.childIndex = value.childIndex;
    if (value.agent !== undefined) response.agent = value.agent;
    if (value.model !== undefined) response.model = value.model;
    if (value.exitCode !== undefined) response.exitCode = value.exitCode;
    if (value.output !== undefined) response.output = value.output;
    if (value.outputPath !== undefined) response.outputPath = value.outputPath;
    if (value.sessionFile !== undefined)
        response.sessionFile = value.sessionFile;
    if (value.acceptance !== undefined) {
        response.acceptance = {
            status: value.acceptance.status,
            evidenceStatus:
                value.acceptance.evidenceStatus ??
                fallbackEvidenceStatus(value.acceptance.status),
            explicit: value.acceptance.explicit,
        };
    }
    if (value.turns !== undefined) response.turns = value.turns;
    if (value.toolCount !== undefined) response.toolCount = value.toolCount;
    if (value.durationMs !== undefined) response.durationMs = value.durationMs;
    if (value.tokens !== undefined) response.tokens = value.tokens;
    if (value.warnings !== undefined) response.warnings = [...value.warnings];
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
    onUpdate?(event: SubagentDelegationUpdate): void;
}

type DelegationStarted = Pick<
    SubagentDelegationResponse,
    'version' | 'requestId'
>;

interface PendingDelegation {
    cancelEmitted: boolean;
    cleanup(): void;
    onStarted?(event: DelegationStarted): void;
    onUpdate?(event: SubagentDelegationUpdate): void;
    reject(error: Error): void;
    resolve(response: SubagentDelegationResponse): void;
}

export class DelegationDeadlineError extends Error {
    constructor(requestId: string) {
        super(`Delegation request ${requestId} exceeded its deadline.`);
        this.name = 'DelegationDeadlineError';
    }
}

export class DelegationDisposedError extends Error {
    constructor() {
        super('Delegation client is disposed.');
        this.name = 'DelegationDisposedError';
    }
}

export class DelegationClient {
    private readonly pending = new Map<string, PendingDelegation>();
    private readonly unsubscribers: Array<() => void>;
    private disposed = false;

    constructor(private readonly events: EventBus) {
        this.unsubscribers = [
            events.on(SUBAGENT_DELEGATION_STARTED_EVENT, (data) => {
                const event = parseStarted(data);
                if (!event) return;
                this.pending.get(event.requestId)?.onStarted?.(event);
            }),
            events.on(SUBAGENT_DELEGATION_UPDATE_EVENT, (data) => {
                const event = parseUpdate(data);
                if (!event) return;
                this.pending.get(event.requestId)?.onUpdate?.(event);
            }),
            events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (data) => {
                const response = parseTerminalResponse(data);
                if (!response) return;

                const pending = this.pending.get(response.requestId);
                if (!pending) return;

                this.pending.delete(response.requestId);
                pending.cleanup();
                pending.resolve(response);
            }),
        ];
    }

    run(
        request: SubagentDelegationRequest,
        options: DelegationRunOptions = {},
    ): Promise<SubagentDelegationResponse> {
        if (this.disposed) return Promise.reject(new DelegationDisposedError());
        if (!isValidRequestId(request.requestId)) {
            return Promise.reject(
                new Error(
                    'Delegation requestId must be a non-empty string of at most 256 characters without newlines.',
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

        let resolveRun!: (response: SubagentDelegationResponse) => void;
        let rejectRun!: (error: Error) => void;
        const result = new Promise<SubagentDelegationResponse>(
            (resolve, reject) => {
                resolveRun = resolve;
                rejectRun = reject;
            },
        );
        const onAbort = () => this.cancel(request.requestId);
        let clearDeadline = noop;
        const pending: PendingDelegation = {
            cancelEmitted: false,
            cleanup: () => {
                options.signal?.removeEventListener('abort', onAbort);
                clearDeadline();
            },
            onStarted: (event) => options.onStarted?.(event),
            onUpdate: (event) => options.onUpdate?.(event),
            reject: rejectRun,
            resolve: resolveRun,
        };
        this.pending.set(request.requestId, pending);
        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.deadlineMs !== undefined && options.deadlineMs > 0) {
            const deadline = setTimeout(() => {
                if (this.pending.get(request.requestId) !== pending) return;

                this.pending.delete(request.requestId);
                pending.cleanup();
                this.emitCancel(request.requestId, pending);
                pending.reject(new DelegationDeadlineError(request.requestId));
            }, options.deadlineMs);
            clearDeadline = () => clearTimeout(deadline);
        }
        if (options.signal?.aborted) this.cancel(request.requestId);
        this.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
        return result;
    }

    cancel(requestId: string): void {
        const pending = this.pending.get(requestId);
        if (!pending) return;

        this.emitCancel(requestId, pending);
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

    private emitCancel(requestId: string, pending: PendingDelegation): void {
        if (pending.cancelEmitted) return;

        pending.cancelEmitted = true;
        this.events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, {
            version: 1,
            requestId,
        });
    }
}
