/**
 * subagent-wait-guard
 *
 * Programmatic enforcement of the delegation rule: do not finalize an answer
 * while delegated subagent runs are still in flight.
 *
 * Mode-aware safeguards backed by pi-subagents' process-global active-runs API:
 *
 * 1. Interactive TUI sessions preserve parent output, including exposed thinking.
 * 2. Interactive reminders use hidden custom messages and native completion wake.
 * 3. RPC/headless sessions replace premature prose and receive one hidden blocking-wait
 *    follow-up per active-run snapshot.
 * 4. Paused runs receive one hidden attention reminder without a blind wait turn.
 *
 * Explicit progress markers are stripped before display. Snapshot changes reset the
 * one-shot reminder state, and an empty snapshot clears session state.
 * PI_SUBAGENT_WAIT_GUARD=off disables registration entirely.
 *
 * Hard veto of turn completion is unavailable through Pi's public extension API, so
 * strict replacement remains limited to non-interactive runtimes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    buildFollowUp,
    buildParentReminder,
    buildReplacement,
    injectProgressProtocol,
    isInteractiveTuiRuntime,
    isPrematureFinalAssistant,
    stripProgressMarker,
    type GuardNoticeKind,
} from "./guard.ts";

const ACTIVE_RUNS_REGISTRY_KEY = "pi-subagents.active-runs.v1";
const ACTIVE_RUNS_PROTOCOL_VERSION = 1;
const MAX_SOURCES = 100;
const MAX_RUNS_PER_SOURCE = 10_000;

interface SessionInterventionState {
    fingerprint: string;
    followUpPending: boolean;
    followUpSent: boolean;
    progressPermit: boolean;
}

const sessionInterventions = new Map<string, SessionInterventionState>();

type ActiveSubagentRunStatus = "queued" | "running" | "paused";

interface ActiveSubagentRun {
    id: string;
    sessionId: string;
    status: ActiveSubagentRunStatus;
}

interface ActiveRunsRegistry {
    version: number;
    sources: Map<string, unknown>;
}

interface SessionIdentityManager {
    getSessionFile(): string | undefined;
    getSessionId(): string;
}

/** Mirrors pi-subagents' session identity selection. */
function resolveSessionIdentity(manager: SessionIdentityManager): string {
    return manager.getSessionFile() ?? manager.getSessionId();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validString(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.trim() === value &&
        !value.includes("\0")
    );
}

function validStatus(value: unknown): value is ActiveSubagentRunStatus {
    return value === "queued" || value === "running" || value === "paused";
}

function activeRunsRegistry(): ActiveRunsRegistry | undefined {
    const value = (globalThis as Record<PropertyKey, unknown>)[
        Symbol.for(ACTIVE_RUNS_REGISTRY_KEY)
    ];
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Malformed pi-subagents active-runs registry.");
    }
    const registry = value as { version?: unknown; sources?: unknown };
    const { version, sources } = registry;
    if (version !== ACTIVE_RUNS_PROTOCOL_VERSION || !(sources instanceof Map)) {
        throw new Error(
            `Unsupported pi-subagents active-runs registry version '${String(version)}'.`,
        );
    }
    if (sources.size > MAX_SOURCES)
        throw new Error(`Active-runs registry exceeds ${MAX_SOURCES} sources.`);
    return { version, sources };
}

function snapshotActiveSubagentRuns(sessionId: string): ActiveSubagentRun[] {
    const registry = activeRunsRegistry();
    if (!registry) return [];
    const runs: ActiveSubagentRun[] = [];
    const identities = new Set<string>();
    for (const [sourceName, source] of registry.sources) {
        if (!isRecord(source)) {
            throw new Error(`Active-runs source '${sourceName}' is malformed.`);
        }
        if (source.name !== sourceName) {
            throw new Error(
                `Active-runs source '${sourceName}' has a mismatched name.`,
            );
        }
        const { listActiveRuns } = source;
        if (typeof listActiveRuns !== "function") {
            throw new Error(
                `Active-runs source '${sourceName}' lacks listActiveRuns().`,
            );
        }
        const active: unknown = listActiveRuns.call(source);
        if (!Array.isArray(active)) {
            throw new Error(
                `Active-runs source '${sourceName}' did not return an array.`,
            );
        }
        if (active.length > MAX_RUNS_PER_SOURCE) {
            throw new Error(
                `Active-runs source '${sourceName}' exceeds ${MAX_RUNS_PER_SOURCE} runs.`,
            );
        }
        for (const value of active) {
            if (!isRecord(value)) {
                throw new Error(
                    `Active-runs source '${sourceName}' returned a malformed run.`,
                );
            }
            const { id, sessionId: ownerSessionId, status: rawStatus } = value;
            if (!validString(id) || !validString(ownerSessionId)) {
                throw new Error(
                    `Active-runs source '${sourceName}' returned an invalid run identity.`,
                );
            }
            if (rawStatus !== undefined && !validStatus(rawStatus)) {
                throw new Error(
                    `Active-runs source '${sourceName}' returned an invalid run status.`,
                );
            }
            const identity = `${ownerSessionId}\0${id}`;
            if (identities.has(identity))
                throw new Error(`Duplicate active run '${id}'.`);
            identities.add(identity);
            if (ownerSessionId === sessionId)
                runs.push({
                    id,
                    sessionId: ownerSessionId,
                    status: rawStatus ?? "running",
                });
        }
    }
    return runs;
}

function activeRuns(sessionId: string): ActiveSubagentRun[] {
    try {
        return snapshotActiveSubagentRuns(sessionId).toSorted((left, right) =>
            left.id.localeCompare(right.id),
        );
    } catch (error) {
        console.error(
            "[subagent-wait-guard] Failed to snapshot active pi-subagents runs:",
            error,
        );
        return [];
    }
}

function resetIfSettled(
    sessionId: string,
    runs: readonly ActiveSubagentRun[],
): boolean {
    if (runs.length > 0) return false;
    sessionInterventions.delete(sessionId);
    return true;
}

function runFingerprint(runs: readonly ActiveSubagentRun[]): string {
    return JSON.stringify(runs.map((run) => [run.id, run.status]));
}

function interventionState(
    sessionId: string,
    runs: readonly ActiveSubagentRun[],
): SessionInterventionState {
    const fingerprint = runFingerprint(runs);
    const current = sessionInterventions.get(sessionId);
    if (current?.fingerprint === fingerprint) return current;
    const created: SessionInterventionState = {
        fingerprint,
        followUpPending: false,
        followUpSent: false,
        progressPermit: hasPausedRun(runs),
    };
    sessionInterventions.set(sessionId, created);
    return created;
}

function hasPausedRun(runs: readonly ActiveSubagentRun[]): boolean {
    return runs.some((run) => run.status === "paused");
}

function replacementKind(
    runs: readonly ActiveSubagentRun[],
    interactive: boolean,
): GuardNoticeKind {
    if (hasPausedRun(runs)) return "attention";
    return interactive ? "interactive" : "headless";
}

function reconcileTurnEndState(
    sessionId: string,
    runs: readonly ActiveSubagentRun[],
): SessionInterventionState | undefined {
    const current = sessionInterventions.get(sessionId);
    if (!current) return undefined;
    const fingerprint = runFingerprint(runs);
    if (current.fingerprint === fingerprint) return current;
    if (!current.followUpPending) return undefined;
    const reconciled: SessionInterventionState = {
        fingerprint,
        followUpPending: true,
        followUpSent: false,
        progressPermit: hasPausedRun(runs),
    };
    sessionInterventions.set(sessionId, reconciled);
    return reconciled;
}

export default function register(pi: ExtensionAPI): void {
    if (process.env.PI_SUBAGENT_WAIT_GUARD === "off") return;
    const sendMessage = pi.sendMessage.bind(pi);

    pi.on("before_agent_start", (event, ctx) => {
        const sessionId = resolveSessionIdentity(ctx.sessionManager);
        const runs = activeRuns(sessionId);
        return {
            systemPrompt: injectProgressProtocol(
                event.systemPrompt,
                runs.map((run) => run.id),
            ),
        };
    });

    pi.on("tool_result", (event, ctx) => {
        if (
            event.isError ||
            (event.toolName !== "subagent" &&
                event.toolName !== "subagent_wait")
        ) {
            return;
        }
        const sessionId = resolveSessionIdentity(ctx.sessionManager);
        const runs = activeRuns(sessionId);
        if (resetIfSettled(sessionId, runs)) return;
        interventionState(sessionId, runs).progressPermit = true;
    });

    pi.on("message_end", (event, ctx) => {
        const { message } = event;
        if (message.role !== "assistant") return undefined;
        const progressMessage = stripProgressMarker(message);
        const sessionId = resolveSessionIdentity(ctx.sessionManager);
        const runs = activeRuns(sessionId);
        if (resetIfSettled(sessionId, runs)) {
            return progressMessage ? { message: progressMessage } : undefined;
        }
        if (!isPrematureFinalAssistant(message)) {
            return progressMessage ? { message: progressMessage } : undefined;
        }
        const state = interventionState(sessionId, runs);
        const progressPermitted = state.progressPermit;
        state.progressPermit = false;
        if (progressMessage && progressPermitted) {
            return { message: progressMessage };
        }
        const interactive = isInteractiveTuiRuntime(ctx.hasUI, process.argv);
        if (!state.followUpPending && !state.followUpSent) {
            state.followUpPending = true;
        }
        if (interactive) {
            return progressMessage ? { message: progressMessage } : undefined;
        }
        return {
            message: buildReplacement(
                message,
                runs.map((run) => run.id),
                replacementKind(runs, interactive),
            ),
        };
    });

    pi.on("turn_end", (_event, ctx) => {
        const sessionId = resolveSessionIdentity(ctx.sessionManager);
        const runs = activeRuns(sessionId);
        if (resetIfSettled(sessionId, runs)) return;
        const state = reconcileTurnEndState(sessionId, runs);
        if (!state?.followUpPending || state.followUpSent) return;
        state.followUpPending = false;
        state.followUpSent = true;
        const interactive = isInteractiveTuiRuntime(ctx.hasUI, process.argv);
        if (interactive || hasPausedRun(runs)) {
            sendMessage(
                {
                    customType: "subagent-wait-guard-reminder",
                    content: buildParentReminder(
                        runs.map((run) => run.id),
                        replacementKind(runs, interactive),
                    ),
                    display: false,
                },
                { triggerTurn: false },
            );
            return;
        }
        sendMessage(
            {
                customType: "subagent-wait-guard-reminder",
                content: buildFollowUp(runs.map((run) => run.id)),
                display: false,
            },
            { deliverAs: "followUp" },
        );
    });

    pi.on("session_shutdown", (_event, ctx) => {
        sessionInterventions.delete(resolveSessionIdentity(ctx.sessionManager));
    });
}
