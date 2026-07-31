import { readAsyncArtifacts } from './artifact-reader.ts';
import { LiveRunStore, type AsyncLiveRun } from './fleet-store.ts';
import {
    SUBAGENT_RPC_READY_EVENT,
    SubagentRpcClient,
    parseFleetStatus,
    type EventBusLike,
} from './rpc-client.ts';

const ASYNC_STARTED_EVENT = 'subagent:async-started';
const ASYNC_COMPLETE_EVENT = 'subagent:async-complete';
const PROCESS_TERMINAL_EVENT = 'subagent:process-terminal';

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sessionIdFrom(value: unknown): string | undefined {
    if (!isRecord(value)) return undefined;
    return typeof value.sessionId === 'string' ? value.sessionId : undefined;
}

export class SubagentsLiveRuntime {
    readonly store = new LiveRunStore();
    private readonly client: SubagentRpcClient;
    private readonly unsubscribers: Array<() => void> = [];
    private sessionId: string | undefined;
    private fleetStatusSupported = false;
    private disposed = false;
    private refreshPromise: Promise<void> | undefined;

    constructor(private readonly events: EventBusLike) {
        this.client = new SubagentRpcClient(events);
        this.listen(SUBAGENT_RPC_READY_EVENT, () => {
            void this.negotiateAndRefresh();
        });
        this.listen(ASYNC_STARTED_EVENT, (payload) => {
            if (!this.belongsToCurrentSession(payload)) return;
            const run = this.store.ingestAsyncStarted(payload);
            if (run) this.refreshArtifact(run);
        });
        this.listen(ASYNC_COMPLETE_EVENT, (payload) => {
            if (!this.belongsToCurrentSession(payload)) return;
            const run = this.store.ingestAsyncComplete(payload);
            if (run) this.refreshArtifact(run);
        });
        this.listen(PROCESS_TERMINAL_EVENT, (payload) => {
            if (!this.belongsToCurrentSession(payload) || !isRecord(payload)) {
                return;
            }
            const id =
                typeof payload.runId === 'string'
                    ? payload.runId
                    : typeof payload.id === 'string'
                      ? payload.id
                      : undefined;
            const run = id
                ? this.store
                      .snapshot()
                      .runs.find(
                          (candidate): candidate is AsyncLiveRun =>
                              candidate.source === 'async' && candidate.id === id,
                      )
                : undefined;
            if (run) this.refreshArtifact(run);
        });
    }

    async beginSession(sessionId?: string): Promise<void> {
        this.sessionId = sessionId;
        this.fleetStatusSupported = false;
        this.store.reset();
        await this.negotiateAndRefresh();
    }

    refresh(): Promise<void> {
        if (this.disposed) return Promise.resolve();
        if (this.refreshPromise) return this.refreshPromise;
        this.refreshPromise = this.refreshNow().finally(() => {
            this.refreshPromise = undefined;
        });
        return this.refreshPromise;
    }

    async control(
        action: 'steer' | 'interrupt' | 'stop',
        run: AsyncLiveRun,
        message?: string,
    ): Promise<unknown> {
        if (!run.controllable) {
            throw new Error(`Async run ${run.id} is no longer controllable.`);
        }
        const steeringMessage = message?.trim();
        if (action === 'steer' && !steeringMessage) {
            throw new Error('Steer requires a non-empty message.');
        }
        return this.client.request(action, {
            id: run.controlId,
            ...(action === 'steer' ? { message: steeringMessage } : {}),
        });
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
        this.client.dispose();
        this.store.reset();
    }

    private listen(event: string, handler: (payload: unknown) => void): void {
        const unsubscribe = this.events.on(event, handler);
        if (unsubscribe) this.unsubscribers.push(unsubscribe);
    }

    private belongsToCurrentSession(payload: unknown): boolean {
        const payloadSessionId = sessionIdFrom(payload);
        return (
            !payloadSessionId ||
            !this.sessionId ||
            payloadSessionId === this.sessionId
        );
    }

    private async negotiateAndRefresh(): Promise<void> {
        if (this.disposed) return;
        try {
            const ping = await this.client.request('ping');
            const capabilities =
                isRecord(ping) && isRecord(ping.capabilities)
                    ? ping.capabilities
                    : undefined;
            this.fleetStatusSupported =
                capabilities !== undefined &&
                isRecord(capabilities.fleetStatus) &&
                capabilities.fleetStatus.version === 1;
        } catch {
            this.fleetStatusSupported = false;
        }
        await this.refresh();
    }

    private async refreshNow(): Promise<void> {
        if (this.fleetStatusSupported) {
            try {
                const status = await this.client.request('status');
                const fleet =
                    isRecord(status) && status.fleet !== undefined
                        ? parseFleetStatus(status.fleet)
                        : undefined;
                this.store.setFleetStatus(fleet);
            } catch {
                this.store.setFleetStatus(undefined);
            }
        } else {
            this.store.setFleetStatus(undefined);
        }
        for (const run of this.store.snapshot().runs) {
            if (run.source === 'async') this.refreshArtifact(run);
        }
    }

    private refreshArtifact(run: AsyncLiveRun): void {
        const artifact = readAsyncArtifacts(run.asyncDir);
        if (artifact) this.store.updateAsyncArtifacts(run.id, artifact);
    }
}
