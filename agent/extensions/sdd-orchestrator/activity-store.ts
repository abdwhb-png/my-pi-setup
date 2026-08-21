import { sanitizeDisplayText } from "../_shared/redaction";
import {
    delegationOutput,
    delegationUsage,
    type SddDelegationResponse,
    type SddDelegationStarted,
    type SddDelegationUpdate,
} from "./delegation-contract.ts";
import type { ApprovedManifest } from "./manifest";
import type { RunSnapshot, RunState, TaskState } from "./state-machine";
import type {
    SddDelegationActivityContext,
    SddWorkflowObserver,
} from "./workflow-observer";

export type SddActivityPhase = "prepared" | "running" | "terminal";

export interface SddActivityTool {
    readonly tool: string;
    readonly args: string;
}

export interface SddDelegationActivity {
    readonly requestId: string;
    readonly stage: string;
    readonly attempt: number;
    readonly agent: string;
    readonly model?: string;
    readonly phase: SddActivityPhase;
    readonly status?: SddDelegationResponse["status"];
    readonly currentTool?: SddActivityTool;
    readonly recentTools: readonly SddActivityTool[];
    readonly recentOutputLines: readonly string[];
    readonly durationMs?: number;
    readonly tokens?: number;
    readonly toolCount?: number;
}

export interface SddTaskActivity {
    readonly id: string;
    readonly title: string;
    readonly state: TaskState;
    readonly virtual?: boolean;
    readonly delegations: readonly SddDelegationActivity[];
}

export interface SddRunActivity {
    readonly runId: string;
    readonly planTitle: string;
    readonly state: RunState;
    readonly revision: number;
    readonly live: boolean;
    readonly startedAt: number;
    readonly presentationTerminal: boolean;
    readonly historyNotice?: string;
    readonly tasks: readonly SddTaskActivity[];
}

interface MutableDelegationActivity {
    requestId: string;
    stage: string;
    attempt: number;
    agent: string;
    model?: string;
    phase: SddActivityPhase;
    status?: SddDelegationResponse["status"];
    currentTool?: SddActivityTool;
    recentTools: SddActivityTool[];
    recentOutputLines: string[];
    durationMs?: number;
    tokens?: number;
    toolCount?: number;
}

interface MutableTaskActivity {
    id: string;
    title: string;
    state: TaskState;
    virtual?: boolean;
    delegations: MutableDelegationActivity[];
}

interface MutableRunActivity {
    runId: string;
    planTitle: string;
    state: RunState;
    revision: number;
    live: boolean;
    startedAt: number;
    historyNotice?: string;
    tasks: MutableTaskActivity[];
}

export interface SddActivityStoreOptions {
    readonly now?: () => number;
}

const PRESENTATION_TERMINAL_STATES = new Set<RunState>([
    "needs_input",
    "failed",
    "cancelled",
    "completed",
]);

const HISTORY_NOTICE = "Earlier live activity is unavailable after reload.";
const INTEGRATION_TASK_ID = "__integration__";

function integrationState(snapshot: RunSnapshot): TaskState {
    const integration = snapshot.integrationReview;
    if (!integration) return "pending";
    if (integration.applied) return "verified";
    if (integration.activeRequestId) return "reviewing";
    if (integration.terminalResponse) {
        return integration.terminalResponse.status === "completed"
            ? "reviewing"
            : "failed";
    }
    return "pending";
}

function sanitizedTools(
    tools: SddDelegationUpdate["recentTools"],
): SddActivityTool[] {
    const unique = new Map<string, SddActivityTool>();
    for (const tool of tools ?? []) {
        const sanitized = {
            tool: sanitizeDisplayText(tool.tool),
            args: sanitizeDisplayText(tool.args),
        };
        unique.set(`${sanitized.tool}\u0000${sanitized.args}`, sanitized);
    }
    return [...unique.values()].slice(-8);
}

function sanitizedOutputLines(value: string | undefined): string[] {
    if (!value) return [];
    return value
        .split(/\r?\n/u)
        .map((line) => sanitizeDisplayText(line))
        .filter(Boolean);
}

export class SddActivityStore implements SddWorkflowObserver {
    private readonly runs = new Map<string, MutableRunActivity>();
    private readonly requestOwners = new Map<
        string,
        { runId: string; taskId: string }
    >();
    private readonly subscribers = new Set<() => void>();
    private readonly now: () => number;

    constructor(options: SddActivityStoreOptions = {}) {
        this.now = options.now ?? Date.now;
    }

    subscribe(subscriber: () => void): () => void {
        this.subscribers.add(subscriber);
        return () => this.subscribers.delete(subscriber);
    }

    trackRun(
        manifest: ApprovedManifest,
        snapshot: RunSnapshot,
        options: { readonly live: boolean },
    ): void {
        const existing = this.runs.get(snapshot.runId);
        const existingById = new Map(
            existing?.tasks.map((task) => [task.id, task]) ?? [],
        );
        const tasks: MutableTaskActivity[] = manifest.tasks.map(
            (manifestTask) => {
                const previous = existingById.get(manifestTask.id);
                return {
                    id: manifestTask.id,
                    title: sanitizeDisplayText(manifestTask.title),
                    state: snapshot.tasks[manifestTask.id]?.state ?? "pending",
                    delegations: previous?.delegations ?? [],
                } satisfies MutableTaskActivity;
            },
        );
        if (manifest.finalIntegrationReview) {
            const previous = existingById.get(INTEGRATION_TASK_ID);
            tasks.push({
                id: INTEGRATION_TASK_ID,
                title: "Integration review",
                state: integrationState(snapshot),
                virtual: true,
                delegations: previous?.delegations ?? [],
            });
        }

        this.runs.set(snapshot.runId, {
            runId: snapshot.runId,
            planTitle: sanitizeDisplayText(manifest.planTitle),
            state: snapshot.state,
            revision: snapshot.revision,
            live: options.live,
            startedAt:
                Date.parse(manifest.decision.approvedAt) ||
                existing?.startedAt ||
                this.now(),
            historyNotice: options.live ? undefined : HISTORY_NOTICE,
            tasks,
        });
        this.notify();
    }

    getRun(runId: string): SddRunActivity | undefined {
        const run = this.runs.get(runId);
        if (!run) return undefined;
        return structuredClone({
            ...run,
            presentationTerminal: PRESENTATION_TERMINAL_STATES.has(run.state),
        });
    }

    getLiveRuns(): SddRunActivity[] {
        return [...this.runs.values()]
            .filter((run) => run.live)
            .map((run) => this.getRun(run.runId)!)
            .toSorted((left, right) => left.startedAt - right.startedAt);
    }

    setLive(runId: string, live: boolean): void {
        const run = this.runs.get(runId);
        if (!run || run.live === live) return;
        run.live = live;
        if (!live) run.historyNotice = HISTORY_NOTICE;
        this.notify();
    }

    onSnapshot(snapshot: RunSnapshot): void {
        const run = this.runs.get(snapshot.runId);
        if (!run || snapshot.revision < run.revision) return;
        if (
            snapshot.revision === run.revision &&
            snapshot.state === run.state
        ) {
            const unchanged = run.tasks.every(
                (task) =>
                    task.virtual ||
                    snapshot.tasks[task.id]?.state === task.state,
            );
            if (unchanged) return;
        }
        run.revision = snapshot.revision;
        run.state = snapshot.state;
        for (const task of run.tasks) {
            task.state = task.virtual
                ? integrationState(snapshot)
                : (snapshot.tasks[task.id]?.state ?? task.state);
        }
        this.notify();
    }

    onDelegationPrepared(context: SddDelegationActivityContext): void {
        if (this.requestOwners.has(context.requestId)) return;
        const run = this.runs.get(context.runId);
        const task = run?.tasks.find(
            (candidate) => candidate.id === context.taskId,
        );
        if (!run || !task) return;
        task.delegations.push({
            requestId: context.requestId,
            stage: sanitizeDisplayText(context.stage),
            attempt: context.attempt,
            agent: sanitizeDisplayText(context.agent),
            model: context.model
                ? sanitizeDisplayText(context.model)
                : undefined,
            phase: "prepared",
            recentTools: [],
            recentOutputLines: [],
        });
        this.requestOwners.set(context.requestId, {
            runId: context.runId,
            taskId: context.taskId,
        });
        this.notify();
    }

    onDelegationStarted(
        context: SddDelegationActivityContext,
        event: SddDelegationStarted,
    ): void {
        const activity = this.resolveActivity(context, event.requestId);
        if (!activity || activity.phase === "terminal") return;
        if (activity.phase === "running") return;
        activity.phase = "running";
        this.notify();
    }

    onDelegationUpdate(
        context: SddDelegationActivityContext,
        event: SddDelegationUpdate,
    ): void {
        const activity = this.resolveActivity(context, event.requestId);
        if (!activity || activity.phase === "terminal") return;
        activity.phase = "running";
        if (event.currentTool) {
            activity.currentTool = {
                tool: sanitizeDisplayText(event.currentTool),
                args: sanitizeDisplayText(event.currentToolArgs ?? ""),
            };
        }
        if (event.recentTools)
            activity.recentTools = sanitizedTools(event.recentTools);
        const outputLines =
            event.recentOutputLines ?? sanitizedOutputLines(event.recentOutput);
        if (outputLines.length > 0) {
            activity.recentOutputLines = outputLines
                .map((line) => sanitizeDisplayText(line))
                .filter(Boolean)
                .slice(-5);
        }
        if (event.model) activity.model = sanitizeDisplayText(event.model);
        if (event.durationMs !== undefined)
            activity.durationMs = event.durationMs;
        if (event.tokens !== undefined) activity.tokens = event.tokens;
        if (event.toolCount !== undefined) activity.toolCount = event.toolCount;
        this.notify();
    }

    onDelegationFinished(
        context: SddDelegationActivityContext,
        response: SddDelegationResponse,
    ): void {
        const activity = this.resolveActivity(context, response.requestId);
        if (!activity || activity.phase === "terminal") return;
        activity.phase = "terminal";
        activity.status = response.status;
        if (response.agent)
            activity.agent = sanitizeDisplayText(response.agent);
        if (response.model)
            activity.model = sanitizeDisplayText(response.model);
        const usage = delegationUsage(response);
        if (usage.durationMs !== undefined)
            activity.durationMs = usage.durationMs;
        if (usage.tokens !== undefined) activity.tokens = usage.tokens;
        if (usage.toolCount !== undefined) activity.toolCount = usage.toolCount;
        activity.recentOutputLines = [
            ...activity.recentOutputLines,
            ...sanitizedOutputLines(
                delegationOutput(response) ?? response.error,
            ),
        ].slice(-5);
        this.notify();
    }

    private resolveActivity(
        context: SddDelegationActivityContext,
        eventRequestId: string,
    ): MutableDelegationActivity | undefined {
        if (eventRequestId !== context.requestId) return undefined;
        const owner = this.requestOwners.get(context.requestId);
        if (
            !owner ||
            owner.runId !== context.runId ||
            owner.taskId !== context.taskId
        ) {
            return undefined;
        }
        return this.runs
            .get(owner.runId)
            ?.tasks.find((task) => task.id === owner.taskId)
            ?.delegations.find(
                (delegation) => delegation.requestId === context.requestId,
            );
    }

    private notify(): void {
        for (const subscriber of this.subscribers) subscriber();
    }
}
