import {
    nativeArtifactRoot,
    readOwnedCompletion,
} from "./completion-reader.ts";
import type {
    DelegationStatus,
    DelegationValue,
    DelegationUsage,
} from "./contracts.ts";
import {
    DelegationClient as ForegroundClient,
    type DelegationClientOptions,
} from "./foreground-client.ts";
import {
    preflightSubagent,
    restrictSubagents,
    currentSubagentRestriction,
    subagentSessionKey,
    type Restriction,
} from "./native-api.ts";
import {
    SubagentRpcClient,
    SubagentRpcError,
    type SubagentRpcClientOptions,
    type SubagentRpcEventBus,
    type SubagentAsyncCompletion,
    type SubagentRpcRequestOptions,
} from "./rpc-client.ts";
import { readActiveRuns } from "./status.ts";
import {
    compileWorkflow,
    nativeLaunch,
    type DetachedRequest,
} from "./workflow.ts";
import type { AgentLaunch } from "./workflow.ts";

export interface RunRef {
    runId: string;
    sessionId: string;
    resumedFrom?: string;
}
export interface ChildResult {
    runId?: string;
    key?: string;
    agent?: string;
    status: DelegationStatus;
    value?: DelegationValue;
    error?: string;
    model?: string;
    thinking?: string;
    usage?: Partial<DelegationUsage>;
}
export interface RunCompletion {
    runId: string;
    sessionId?: string;
    status: DelegationStatus;
    steps: ChildResult[];
    error?: string;
}
export type SubagentEvent =
    | { kind: "terminal"; completion: RunCompletion }
    | { kind: "diagnostic"; runId?: string; sessionId?: string; error: Error };
export type RunControl =
    | { kind: "steer"; message: string }
    | { kind: "interrupt" | "stop" };
export type IntegrationOptions = DelegationClientOptions &
    Partial<SubagentRpcClientOptions> & { artifactRoot?: string };

type RecoveryListener = (error?: Error, terminal?: RunCompletion) => void;
type RecoveryWatch = {
    listeners: Set<RecoveryListener>;
    timer?: ReturnType<typeof setTimeout>;
};

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function status(
    value: Record<string, unknown>,
    success: boolean,
): DelegationStatus {
    if (value.timedOut === true || value.status === "timed_out")
        return "timed_out";
    if (
        value.stopped === true ||
        value.state === "stopped" ||
        value.status === "stopped" ||
        value.status === "cancelled"
    )
        return "cancelled";
    if (
        value.interrupted === true ||
        value.state === "paused" ||
        value.status === "paused" ||
        value.status === "interrupted"
    )
        return "interrupted";
    if (
        value.status === "tool_budget_exhausted" ||
        value.status === "structured_output_failed" ||
        value.status === "acceptance_failed"
    )
        return value.status;
    return success ? "completed" : "failed";
}

function usage(value: unknown): Partial<DelegationUsage> | undefined {
    if (!record(value)) return undefined;
    const result: Partial<DelegationUsage> = {};
    for (const key of [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "cost",
        "turns",
        "toolCalls",
        "durationMs",
    ] as const) {
        const count = value[key];
        if (typeof count === "number" && Number.isFinite(count) && count >= 0)
            result[key] = count;
    }
    return Object.keys(result).length ? result : undefined;
}

function normalize(completion: SubagentAsyncCompletion): RunCompletion {
    const steps = (completion.results ?? []).map((child): ChildResult => {
        const value: DelegationValue | undefined = Object.hasOwn(
            child,
            "structuredOutput",
        )
            ? { kind: "structured", value: child.structuredOutput }
            : typeof child.output === "string"
              ? { kind: "text", text: child.output }
              : undefined;
        const success =
            child.success !== false &&
            (child.status === undefined ||
                child.status === "complete" ||
                child.status === "completed");
        const accounting = usage(child.usage);
        return {
            status: status(child, success),
            ...(typeof child.workflowKey === "string"
                ? { key: child.workflowKey }
                : {}),
            ...(typeof child.agent === "string" ? { agent: child.agent } : {}),
            ...(value ? { value } : {}),
            ...(typeof child.error === "string" ? { error: child.error } : {}),
            ...(typeof child.model === "string" ? { model: child.model } : {}),
            ...(typeof child.thinking === "string"
                ? { thinking: child.thinking }
                : {}),
            ...(typeof child.runId === "string" ? { runId: child.runId } : {}),
            ...(accounting ? { usage: accounting } : {}),
        };
    });
    const outcome = status(
        completion,
        completion.success === true &&
            steps.every((step) => step.status === "completed"),
    );
    return {
        runId: completion.id,
        ...(completion.sessionId ? { sessionId: completion.sessionId } : {}),
        status: outcome,
        steps,
        ...(outcome !== "completed" && typeof completion.summary === "string"
            ? { error: completion.summary }
            : {}),
    };
}

/** Owns transport correlation and normalization, never the package's execution state. */
export class SubagentIntegration extends ForegroundClient {
    private readonly rpc: SubagentRpcClient;
    private readonly terminal = new Map<string, RunCompletion>();
    private readonly diagnostics = new Map<string, Error>();
    private readonly listeners = new Set<(event: SubagentEvent) => void>();
    private unsubscribe?: () => void;
    private readonly observed = new Set<string>();
    private readonly pendingLaunches = new Map<string, number>();
    private readonly early = new Map<string, SubagentEvent>();
    private unscopedSubscribers = 0;
    private sessionCheck?: Promise<string>;
    private readonly recovery = new Map<string, RecoveryWatch>();
    private readonly waiting = new Set<(error: Error) => void>();
    private closed = false;
    private readonly artifactRoot: string;

    constructor(events: SubagentRpcEventBus, options: IntegrationOptions = {}) {
        super(
            {
                emit: (event, data) => events.emit(event, data),
                on: (event, handler) => events.on(event, handler) ?? (() => {}),
            },
            options,
        );
        this.rpc = new SubagentRpcClient(events, {
            ...options,
            sourceExtension: options.sourceExtension ?? "subagents-integration",
        });
        this.artifactRoot = options.artifactRoot ?? nativeArtifactRoot();
    }

    private observeNativeEvents(): void {
        if (this.unsubscribe) return;
        this.unsubscribe = this.rpc.onAsyncComplete(
            (raw) => {
                if (this.accepts(raw.id, raw.sessionId))
                    this.receive({
                        kind: "terminal",
                        completion: normalize(raw),
                    });
            },
            (error, identity) => {
                if (this.accepts(identity.runId, identity.sessionId))
                    this.receive({ kind: "diagnostic", ...identity, error });
            },
        );
    }

    private accepts(runId?: string, sessionId?: string): boolean {
        return (
            this.unscopedSubscribers > 0 ||
            (runId !== undefined &&
                this.observed.has(this.completionKey(runId, sessionId))) ||
            (sessionId !== undefined && this.pendingLaunches.has(sessionId))
        );
    }

    private receive(event: SubagentEvent): void {
        const identity = event.kind === "terminal" ? event.completion : event;
        const key = this.completionKey(
            identity.runId ?? "",
            identity.sessionId,
        );
        if (!this.observed.has(key) && this.unscopedSubscribers === 0) {
            this.early.set(key, event);
            if (this.early.size > 128)
                this.early.delete(this.early.keys().next().value!);
            return;
        }
        if (event.kind === "terminal") this.observeCompletion(event.completion);
        else {
            if (event.runId && event.sessionId) {
                this.diagnostics.set(key, event.error);
                if (this.diagnostics.size > 128)
                    this.diagnostics.delete(
                        this.diagnostics.keys().next().value!,
                    );
            }
            for (const listener of this.listeners) listener(event);
        }
    }

    private observeReference(ref: RunRef): void {
        this.observeNativeEvents();
        const key = this.completionKey(ref.runId, ref.sessionId);
        this.observed.add(key);
        const early = this.early.get(key);
        if (early) {
            this.early.delete(key);
            this.receive(early);
        }
    }

    private async launch(
        sessionId: string,
        request: () => Promise<Record<string, unknown> | undefined>,
    ): Promise<RunRef> {
        this.observeNativeEvents();
        this.pendingLaunches.set(
            sessionId,
            (this.pendingLaunches.get(sessionId) ?? 0) + 1,
        );
        try {
            const ref = this.receipt(await request(), sessionId);
            this.observeReference(ref);
            return ref;
        } finally {
            const pending = (this.pendingLaunches.get(sessionId) ?? 1) - 1;
            if (pending > 0) this.pendingLaunches.set(sessionId, pending);
            else {
                this.pendingLaunches.delete(sessionId);
                for (const [key, event] of this.early) {
                    const identity =
                        event.kind === "terminal" ? event.completion : event;
                    if (identity.sessionId === sessionId)
                        this.early.delete(key);
                }
            }
        }
    }

    private completionKey(runId: string, sessionId?: string): string {
        return JSON.stringify([sessionId, runId]);
    }

    private observeCompletion(completion: RunCompletion): RunCompletion {
        const key = this.completionKey(completion.runId, completion.sessionId);
        const known = this.terminal.get(key);
        if (known) return known;
        this.diagnostics.delete(key);
        this.terminal.set(key, completion);
        if (this.terminal.size > 128) {
            const expired = this.terminal.keys().next().value!;
            this.terminal.delete(expired);
            this.observed.delete(expired);
        }
        for (const listener of this.listeners)
            listener({ kind: "terminal", completion });
        return completion;
    }

    private async session(
        options?: SubagentRpcRequestOptions,
    ): Promise<string> {
        const ping = await this.rpc.ping(options);
        if (
            !record(ping.session) ||
            typeof ping.session.sessionId !== "string" ||
            !ping.session.sessionId.trim()
        )
            throw new Error(
                "Subagent runtime did not provide a trusted session identity.",
            );
        return subagentSessionKey(
            ping.session.sessionId,
            typeof ping.session.sessionFile === "string"
                ? ping.session.sessionFile
                : undefined,
        );
    }

    private async assertSession(ref: RunRef): Promise<void> {
        const session = (this.sessionCheck ??= this.session().finally(() => {
            this.sessionCheck = undefined;
        }));
        if (!ref.runId.trim() || ref.sessionId !== (await session))
            throw new Error("Subagent reference belongs to another session.");
    }

    async reference(runId: string): Promise<RunRef> {
        const ref = { runId, sessionId: await this.session() };
        this.observeReference(ref);
        return ref;
    }

    async activeRuns() {
        return readActiveRuns(await this.rpc.status());
    }

    async restrict(policy: Restriction) {
        return restrictSubagents({
            sessionId: await this.session(),
            source: "subagents-integration",
            ceiling: policy,
        });
    }

    async preflight(
        request: AgentLaunch,
        options: { projectTrusted?: boolean } = {},
    ) {
        if (!request.cwd) throw new Error("Preflight requires cwd.");
        const sessionId = await this.session();
        return preflightSubagent(
            {
                agent: request.agent,
                cwd: request.cwd,
                context: request.context,
                task: request.task,
                model: request.model,
                thinking: request.thinking,
                skill: request.skill,
                artifacts: request.artifacts,
                outputSchema:
                    request.result?.kind === "structured"
                        ? request.result.schema
                        : undefined,
                extensionBindings: request.extensionBindings,
                intercomBridge: request.intercomBridge,
                parentSessionId: sessionId,
                capabilityCeiling: currentSubagentRestriction(sessionId),
            },
            options,
        );
    }

    async start(
        request: DetachedRequest,
        options?: SubagentRpcRequestOptions,
    ): Promise<RunRef> {
        const sessionId = await this.session(options);
        const params =
            "stages" in request
                ? {
                      workflowScript: compileWorkflow(request),
                      cwd: request.cwd,
                      context: request.context ?? "fresh",
                      artifacts: request.artifacts ?? true,
                      mission: false,
                  }
                : nativeLaunch(request);
        return this.launch(
            sessionId,
            async () =>
                (await this.rpc.spawn({ ...params, async: true }, options))
                    .details,
        );
    }

    private receipt(
        details: Record<string, unknown> | undefined,
        sessionId: string,
    ): RunRef {
        if (typeof details?.asyncId !== "string" || !details.asyncId.trim())
            throw new Error(
                "Subagent launch did not return an async run identity.",
            );
        return { runId: details.asyncId, sessionId };
    }

    async inspect(
        ref: RunRef,
    ): Promise<{ state: string; terminal?: RunCompletion }> {
        await this.assertSession(ref);
        const completion = this.terminal.get(
            this.completionKey(ref.runId, ref.sessionId),
        );
        if (completion)
            return { state: completion.status, terminal: completion };
        const result = await this.rpc.status({ id: ref.runId });
        const artifacts = readOwnedCompletion(ref, this.artifactRoot);
        if (artifacts.completion) {
            const terminal = this.observeCompletion(
                normalize(artifacts.completion),
            );
            return { state: terminal.status, terminal };
        }
        if (result.isError)
            throw new Error(result.text || "Subagent status failed.");
        if (artifacts.state) return { state: artifacts.state };
        const snapshot = result.asyncSnapshot;
        if (
            !snapshot ||
            snapshot.version !== 1 ||
            snapshot.kind !== "pi-subagents.async-status-snapshot" ||
            !Array.isArray(snapshot.runs)
        )
            throw new Error("Subagent status lacks a supported snapshot.");
        const runs: readonly unknown[] = snapshot.runs;
        const run = runs.find(
            (node: unknown) => record(node) && node.id === ref.runId,
        );
        if (!record(run) || typeof run.state !== "string")
            throw new Error("Subagent run is unavailable in this session.");
        return { state: run.state };
    }

    async wait(
        ref: RunRef,
        options: { signal?: AbortSignal; timeoutMs?: number } = {},
    ): Promise<RunCompletion> {
        await this.assertSession(ref);
        this.observeReference(ref);
        const diagnostic = this.diagnostics.get(
            this.completionKey(ref.runId, ref.sessionId),
        );
        if (diagnostic) throw diagnostic;
        const cached = this.terminal.get(
            this.completionKey(ref.runId, ref.sessionId),
        );
        if (cached) return cached;
        if (options.signal?.aborted)
            throw new SubagentRpcError("Subagent wait aborted.", "aborted");
        return new Promise((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let stopRecovery: (() => void) | undefined;
            let settled = false;
            const finish = (error?: Error, terminal?: RunCompletion) => {
                if (settled) return;
                settled = true;
                unsubscribe();
                clearTimeout(timer);
                stopRecovery?.();
                options.signal?.removeEventListener("abort", abort);
                this.waiting.delete(cancel);
                if (error) reject(error);
                else resolve(terminal!);
            };
            const cancel = (error: Error) => finish(error);
            const abort = () =>
                finish(
                    new SubagentRpcError("Subagent wait aborted.", "aborted"),
                );
            const unsubscribe = this.subscribe((event) => {
                if (event.kind === "diagnostic") {
                    if (
                        event.runId === ref.runId &&
                        event.sessionId === ref.sessionId
                    )
                        finish(event.error);
                    return;
                }
                const terminal = event.completion;
                if (
                    terminal.runId === ref.runId &&
                    terminal.sessionId === ref.sessionId
                )
                    finish(undefined, terminal);
            });
            this.waiting.add(cancel);
            options.signal?.addEventListener("abort", abort, { once: true });
            if (options.timeoutMs !== undefined)
                timer = setTimeout(
                    () =>
                        finish(
                            new SubagentRpcError(
                                "Subagent wait timed out.",
                                "timeout",
                            ),
                        ),
                    options.timeoutMs,
                );
            stopRecovery = this.watchRecovery(ref, finish);
        });
    }

    private watchRecovery(ref: RunRef, listener: RecoveryListener): () => void {
        const key = this.completionKey(ref.runId, ref.sessionId);
        let watch = this.recovery.get(key);
        if (!watch) {
            watch = { listeners: new Set() };
            this.recovery.set(key, watch);
            const shared = watch;
            const inspect = async () => {
                if (this.recovery.get(key) !== shared) return;
                try {
                    const observation = await this.inspect(ref);
                    if (observation.terminal)
                        for (const receive of shared.listeners)
                            receive(undefined, observation.terminal);
                } catch (error) {
                    for (const receive of shared.listeners)
                        receive(
                            error instanceof Error
                                ? error
                                : new Error(String(error)),
                        );
                }
                if (
                    shared.listeners.size > 0 &&
                    this.recovery.get(key) === shared
                )
                    shared.timer = setTimeout(inspect, 250);
            };
            queueMicrotask(() => void inspect());
        }
        const shared = watch;
        shared.listeners.add(listener);
        return () => {
            shared.listeners.delete(listener);
            if (shared.listeners.size === 0) {
                clearTimeout(shared.timer);
                if (this.recovery.get(key) === shared)
                    this.recovery.delete(key);
            }
        };
    }

    async control(
        ref: RunRef,
        command: RunControl,
    ): Promise<{ acknowledged: true }> {
        await this.assertSession(ref);
        const result =
            command.kind === "steer"
                ? await this.rpc.steer({
                      id: ref.runId,
                      message: command.message,
                  })
                : await this.rpc[command.kind]({ id: ref.runId });
        if (result.isError)
            throw new Error(result.text || "Subagent control rejected.");
        return { acknowledged: true };
    }

    async resume(ref: RunRef, message: string): Promise<RunRef> {
        await this.assertSession(ref);
        const resumed = await this.launch(
            ref.sessionId,
            async () =>
                (await this.rpc.resume({ id: ref.runId, message })).details,
        );
        return {
            ...resumed,
            resumedFrom: ref.runId,
        };
    }

    subscribe(
        listener: (event: SubagentEvent) => void,
        ref?: RunRef,
    ): () => void {
        if (this.closed) throw new Error("Subagent integration is disposed.");
        if (ref) this.observeReference(ref);
        else {
            this.unscopedSubscribers++;
            this.observeNativeEvents();
        }
        const receive = (event: SubagentEvent) => {
            const identity =
                event.kind === "terminal" ? event.completion : event;
            if (
                !ref ||
                (identity.runId === ref.runId &&
                    identity.sessionId === ref.sessionId)
            )
                listener(event);
        };
        this.listeners.add(receive);
        if (ref) {
            const completion = this.terminal.get(
                this.completionKey(ref.runId, ref.sessionId),
            );
            if (completion) receive({ kind: "terminal", completion });
            else {
                const error = this.diagnostics.get(
                    this.completionKey(ref.runId, ref.sessionId),
                );
                if (error) receive({ kind: "diagnostic", ...ref, error });
            }
        }
        return () => {
            if (this.listeners.delete(receive) && !ref)
                this.unscopedSubscribers--;
        };
    }

    override dispose(): void {
        if (this.closed) return;
        this.closed = true;
        for (const cancel of this.waiting)
            cancel(
                new SubagentRpcError(
                    "Subagent integration disposed.",
                    "disposed",
                ),
            );
        this.unsubscribe?.();
        this.listeners.clear();
        this.terminal.clear();
        this.diagnostics.clear();
        this.observed.clear();
        this.early.clear();
        this.pendingLaunches.clear();
        this.rpc.dispose();
        super.dispose();
    }
}
