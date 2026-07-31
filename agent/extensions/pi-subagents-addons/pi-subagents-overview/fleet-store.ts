import type {
    FleetStatusEntryV1,
    FleetStatusV1,
} from './rpc-client.ts';

export interface LiveRunTokens {
    input: number;
    output: number;
    total: number;
}

interface LiveRunBase {
    key: string;
    agent: string;
    role?: string;
    model?: string;
    effort?: string;
    goal?: string;
    startedAt: number;
    tokens: LiveRunTokens;
}

export interface AsyncLiveRun extends LiveRunBase {
    source: 'async';
    id: string;
    controlId: string;
    asyncDir: string;
    state: 'running' | 'complete' | 'failed' | 'stopped';
    controllable: boolean;
    completedAt?: number;
    summary?: string;
    currentTool?: string;
    activity?: string;
    transcript?: string;
}

export interface FleetLiveRun extends LiveRunBase {
    source: 'fleet';
    state: 'active';
    controllable: false;
}

export type LiveRun = AsyncLiveRun | FleetLiveRun;

export interface LiveRunSnapshot {
    runs: LiveRun[];
    fleetAvailable: boolean;
    totalActive: number;
    omitted: number;
}

interface LiveRunStoreOptions {
    now?: () => number;
}

interface AsyncArtifactUpdate {
    state?: string;
    currentTool?: string;
    activity?: string;
    model?: string;
    effort?: string;
    tokens: LiveRunTokens;
    transcript: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function startedAgent(payload: Record<string, unknown>): string | undefined {
    const direct = optionalText(payload.agent);
    if (direct) return direct;
    if (!Array.isArray(payload.agents)) return undefined;
    return optionalText(payload.agents[0]);
}

function isLikelySameRun(
    run: AsyncLiveRun,
    entry: FleetStatusEntryV1,
): boolean {
    if (run.agent !== entry.agent) return false;
    if (run.goal && entry.goal && run.goal !== entry.goal) return false;
    return Math.abs(run.startedAt - entry.startedAt) <= 5_000;
}

export class LiveRunStore {
    private readonly now: () => number;
    private readonly asyncRuns = new Map<string, AsyncLiveRun>();
    private readonly listeners = new Set<() => void>();
    private fleet: FleetStatusV1 | undefined;

    constructor(options: LiveRunStoreOptions = {}) {
        this.now = options.now ?? Date.now;
    }

    ingestAsyncStarted(payload: unknown): AsyncLiveRun | undefined {
        if (!isRecord(payload)) return undefined;
        const id = optionalText(payload.id);
        const asyncDir = optionalText(payload.asyncDir);
        const agent = startedAgent(payload);
        if (!id || !asyncDir || !agent) return undefined;
        const startedAt =
            typeof payload.startedAt === 'number' &&
            Number.isSafeInteger(payload.startedAt) &&
            payload.startedAt >= 0
                ? payload.startedAt
                : this.now();
        const run: AsyncLiveRun = {
            source: 'async',
            key: `async:${id}`,
            id,
            controlId: id,
            asyncDir,
            agent,
            ...(optionalText(payload.role) ? { role: optionalText(payload.role) } : {}),
            ...(optionalText(payload.model)
                ? { model: optionalText(payload.model) }
                : {}),
            ...(optionalText(payload.effort)
                ? { effort: optionalText(payload.effort) }
                : {}),
            ...(optionalText(payload.goal ?? payload.task)
                ? { goal: optionalText(payload.goal ?? payload.task) }
                : {}),
            startedAt,
            tokens: { input: 0, output: 0, total: 0 },
            state: 'running',
            controllable: true,
        };
        this.asyncRuns.set(id, run);
        this.notify();
        return run;
    }

    ingestAsyncComplete(payload: unknown): AsyncLiveRun | undefined {
        if (!isRecord(payload)) return undefined;
        const id = optionalText(payload.runId) ?? optionalText(payload.id);
        if (!id) return undefined;
        const current = this.asyncRuns.get(id);
        if (!current) return undefined;
        const state =
            payload.state === 'stopped'
                ? 'stopped'
                : payload.success === true
                  ? 'complete'
                  : 'failed';
        const completedAt =
            typeof payload.timestamp === 'number' &&
            Number.isSafeInteger(payload.timestamp) &&
            payload.timestamp >= 0
                ? payload.timestamp
                : this.now();
        const summary = optionalText(payload.summary);
        const completed: AsyncLiveRun = {
            ...current,
            state,
            controllable: false,
            completedAt,
            ...(summary ? { summary } : {}),
        };
        this.asyncRuns.set(id, completed);
        this.notify();
        return completed;
    }

    updateAsyncArtifacts(
        id: string,
        artifact: AsyncArtifactUpdate,
    ): AsyncLiveRun | undefined {
        const current = this.asyncRuns.get(id);
        if (!current) return undefined;
        const terminalState =
            artifact.state === 'complete' || artifact.state === 'completed'
                ? 'complete'
                : artifact.state === 'failed' || artifact.state === 'error'
                  ? 'failed'
                  : artifact.state === 'stopped'
                    ? 'stopped'
                    : undefined;
        const updated: AsyncLiveRun = {
            ...current,
            ...(artifact.model ? { model: artifact.model } : {}),
            ...(artifact.effort ? { effort: artifact.effort } : {}),
            ...(artifact.currentTool ? { currentTool: artifact.currentTool } : {}),
            ...(artifact.activity ? { activity: artifact.activity } : {}),
            ...(artifact.transcript ? { transcript: artifact.transcript } : {}),
            tokens: artifact.tokens,
            ...(terminalState
                ? {
                      state: terminalState,
                      controllable: false,
                      completedAt: current.completedAt ?? this.now(),
                  }
                : {}),
        };
        this.asyncRuns.set(id, updated);
        this.notify();
        return updated;
    }

    setFleetStatus(fleet: FleetStatusV1 | undefined): void {
        this.fleet = fleet;
        this.notify();
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    reset(): void {
        this.asyncRuns.clear();
        this.fleet = undefined;
        this.notify();
    }

    snapshot(): LiveRunSnapshot {
        const asyncRuns = [...this.asyncRuns.values()];
        const fleetEntries = this.fleet?.entries ?? [];
        const usedFleetKeys = new Set<string>();
        const uniqueMatches = new Map<string, FleetStatusEntryV1>();
        for (const run of asyncRuns) {
            if (run.state !== 'running') continue;
            const entriesForRun = fleetEntries.filter((entry) =>
                isLikelySameRun(run, entry),
            );
            if (entriesForRun.length !== 1) continue;
            const entry = entriesForRun[0];
            const runsForEntry = asyncRuns.filter(
                (candidate) =>
                    candidate.state === 'running' &&
                    isLikelySameRun(candidate, entry),
            );
            if (runsForEntry.length === 1) uniqueMatches.set(run.id, entry);
        }

        const mergedAsyncRuns: AsyncLiveRun[] = [];
        for (const run of asyncRuns) {
            const entry = uniqueMatches.get(run.id);
            if (!entry) {
                mergedAsyncRuns.push(run);
                continue;
            }
            usedFleetKeys.add(entry.key);
            mergedAsyncRuns.push({
                ...run,
                ...(entry.role ? { role: entry.role } : {}),
                ...(entry.model ? { model: entry.model } : {}),
                ...(entry.effort ? { effort: entry.effort } : {}),
                tokens: entry.tokens,
            });
        }
        const publicRuns: FleetLiveRun[] = [];
        for (const entry of fleetEntries) {
            if (usedFleetKeys.has(entry.key)) continue;
            publicRuns.push({
                source: 'fleet',
                key: entry.key,
                agent: entry.agent,
                ...(entry.role ? { role: entry.role } : {}),
                ...(entry.model ? { model: entry.model } : {}),
                ...(entry.effort ? { effort: entry.effort } : {}),
                ...(entry.goal ? { goal: entry.goal } : {}),
                startedAt: entry.startedAt,
                tokens: entry.tokens,
                state: 'active',
                controllable: false,
            });
        }
        const runs = [...mergedAsyncRuns, ...publicRuns].toSorted(
            (left, right) => left.startedAt - right.startedAt,
        );
        const localActive = mergedAsyncRuns.filter(
            (run) => run.state === 'running',
        ).length;
        return {
            runs,
            fleetAvailable: this.fleet !== undefined,
            totalActive: this.fleet?.totalActive ?? localActive,
            omitted: this.fleet?.omitted ?? 0,
        };
    }

    private notify(): void {
        for (const listener of this.listeners) listener();
    }
}
