/**
 * subagent-wait-guard
 *
 * Programmatic enforcement of the delegation rule: do not finalize an answer
 * while delegated subagent runs are still in flight.
 *
 * Two coordinated safeguards, backed by pi-subagents' process-global
 * active-runs API:
 *
 * 1. `message_end` replaces a final assistant prose answer while runs remain.
 * 2. Its matching `turn_end` injects one follow-up forcing `subagent_wait({ all: true })`.
 *
 * Safety valves:
 * - Consecutive-intervention cap prevents an eternally hung child from
 *   creating an infinite loop.
 * - An empty active-runs snapshot resets the intervention count.
 * - PI_SUBAGENT_WAIT_GUARD=off disables registration entirely.
 *
 * Hard veto of turn completion is not available through Pi's public extension
 * API; replacement plus follow-up is the strongest extension-level boundary.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    buildFollowUp,
    buildReplacement,
    isPrematureFinalAssistant,
    nextInterventionCount,
} from "./guard.ts";

const ACTIVE_RUNS_REGISTRY_KEY = "pi-subagents.active-runs.v1";
const ACTIVE_RUNS_PROTOCOL_VERSION = 1;
const MAX_SOURCES = 100;
const MAX_RUNS_PER_SOURCE = 10_000;
const INTERVENTION_CAP = 10;
const consecutiveInterventions = new Map<string, number>();
const pendingFollowUps = new Set<string>();

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
        if (!source || typeof source !== "object" || Array.isArray(source)) {
            throw new Error(`Active-runs source '${sourceName}' is malformed.`);
        }
        const sourceRecord = source as {
            name?: unknown;
            listActiveRuns?: unknown;
        };
        if (sourceRecord.name !== sourceName) {
            throw new Error(
                `Active-runs source '${sourceName}' has a mismatched name.`,
            );
        }
        const { listActiveRuns } = sourceRecord;
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
            if (!value || typeof value !== "object" || Array.isArray(value)) {
                throw new Error(
                    `Active-runs source '${sourceName}' returned a malformed run.`,
                );
            }
            const run = value as {
                id?: unknown;
                sessionId?: unknown;
                status?: unknown;
            };
            const { id, sessionId: ownerSessionId, status: rawStatus } = run;
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
    consecutiveInterventions.delete(sessionId);
    pendingFollowUps.delete(sessionId);
    return true;
}

function waitableRunIds(runs: readonly ActiveSubagentRun[]): string[] {
    return runs.filter((run) => run.status !== "paused").map((run) => run.id);
}

export default function register(pi: ExtensionAPI): void {
    if (process.env.PI_SUBAGENT_WAIT_GUARD === "off") return;
    const sendUserMessage = pi.sendUserMessage.bind(pi);

    pi.on("message_end", (event, ctx) => {
        const sessionId = resolveSessionIdentity(ctx.sessionManager);
        const runs = activeRuns(sessionId);
        if (resetIfSettled(sessionId, runs)) return undefined;
        const { message } = event;
        if (message.role !== "assistant") return undefined;
        if (!isPrematureFinalAssistant(message)) return undefined;
        const next = nextInterventionCount(
            consecutiveInterventions.get(sessionId) ?? 0,
            INTERVENTION_CAP,
        );
        if (next === null) return undefined;
        consecutiveInterventions.set(sessionId, next);
        pendingFollowUps.add(sessionId);
        return {
            message: buildReplacement(
                message,
                runs.map((run) => run.id),
            ),
        };
    });

    pi.on("turn_end", (_event, ctx) => {
        const sessionId = resolveSessionIdentity(ctx.sessionManager);
        const runs = activeRuns(sessionId);
        if (resetIfSettled(sessionId, runs)) return;
        if (!pendingFollowUps.has(sessionId)) return;
        const runIds = waitableRunIds(runs);
        if (runIds.length === 0) return;
        pendingFollowUps.delete(sessionId);
        sendUserMessage(buildFollowUp(runIds), { deliverAs: "followUp" });
    });

    pi.on("session_shutdown", () => {
        consecutiveInterventions.clear();
        pendingFollowUps.clear();
    });
}
