import { randomUUID } from 'node:crypto';

export const SUBAGENT_RPC_PROTOCOL_VERSION = 1;
export const SUBAGENT_RPC_REQUEST_EVENT = 'subagents:rpc:v1:request';
export const SUBAGENT_RPC_READY_EVENT = 'subagents:rpc:v1:ready';
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX = 'subagents:rpc:v1:reply:';

export type SubagentRpcMethod =
    | 'ping'
    | 'status'
    | 'spawn'
    | 'steer'
    | 'interrupt'
    | 'stop'
    | 'resume';

export interface EventBusLike {
    on(event: string, handler: (data: unknown) => void): (() => void) | void;
    emit(event: string, data: unknown): void;
}

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

interface RpcClientOptions {
    timeoutMs?: number;
    requestId?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
    return (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 0
    );
}

function displayText(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const text = value
        .slice(0, 4_096)
        .replace(
            /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b][\s\S]*?(?:\x07|\x1b\\)|\x1b[PX^_][\s\S]*?\x1b\\|[\u0000-\u001f\u007f-\u009f]/g,
            ' ',
        )
        .replace(/\s+/g, ' ')
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

export class SubagentRpcError extends Error {
    constructor(
        message: string,
        readonly code = 'rpc_error',
    ) {
        super(message);
        this.name = 'SubagentRpcError';
    }
}

export class SubagentRpcClient {
    private readonly timeoutMs: number;
    private readonly createRequestId: () => string;
    private readonly cancelPending = new Set<(error: SubagentRpcError) => void>();
    private disposed = false;

    constructor(
        private readonly events: EventBusLike,
        options: RpcClientOptions = {},
    ) {
        this.timeoutMs = options.timeoutMs ?? 2_000;
        this.createRequestId = options.requestId ?? randomUUID;
    }

    request(method: SubagentRpcMethod, params?: object): Promise<unknown> {
        if (this.disposed) {
            return Promise.reject(
                new SubagentRpcError('Subagent RPC client is disposed.', 'disposed'),
            );
        }
        const requestId = this.createRequestId();
        const replyEvent = `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`;

        return new Promise((resolve, reject) => {
            let settled = false;
            let cancelTimer: (() => void) | undefined;
            let unsubscribe: (() => void) | void;
            const settle = (callback: () => void): void => {
                if (settled) return;
                settled = true;
                cancelTimer?.();
                unsubscribe?.();
                this.cancelPending.delete(cancel);
                callback();
            };
            const cancel = (error: SubagentRpcError): void => {
                settle(() => reject(error));
            };
            unsubscribe = this.events.on(replyEvent, (payload) => {
                if (!isRecord(payload)) {
                    settle(() => reject(new SubagentRpcError('Malformed RPC reply.')));
                    return;
                }
                if (
                    payload.version !== SUBAGENT_RPC_PROTOCOL_VERSION ||
                    payload.requestId !== requestId ||
                    payload.method !== method ||
                    typeof payload.success !== 'boolean'
                ) {
                    settle(() => reject(new SubagentRpcError('Mismatched RPC reply.')));
                    return;
                }
                if (!payload.success) {
                    const error = isRecord(payload.error) ? payload.error : {};
                    const message =
                        typeof error.message === 'string'
                            ? error.message
                            : 'Subagent RPC request failed.';
                    const code =
                        typeof error.code === 'string' ? error.code : 'rpc_error';
                    settle(() => reject(new SubagentRpcError(message, code)));
                    return;
                }
                settle(() => resolve(payload.data));
            });
            this.cancelPending.add(cancel);
            const timer = setTimeout(() => {
                settle(() =>
                    reject(
                        new SubagentRpcError(
                            `Subagent RPC ${method} timed out.`,
                            'timeout',
                        ),
                    ),
                );
            }, this.timeoutMs);
            cancelTimer = () => clearTimeout(timer);
            timer.unref?.();

            this.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
                version: SUBAGENT_RPC_PROTOCOL_VERSION,
                requestId,
                method,
                ...(params ? { params } : {}),
                source: { extension: 'pi-subagents-addons' },
            });
        });
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        const error = new SubagentRpcError(
            'Subagent RPC client is disposed.',
            'disposed',
        );
        for (const cancel of this.cancelPending) cancel(error);
    }
}
