/** Session capture and one-shot post-compaction restore hooks. */

import type {
    ExtensionContext,
    ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { ThinkStore, __getRawDatabase } from "../storage/store.ts";
import {
    CAPTURE_ENTRY_TYPE,
    CaptureBuffer,
    classifyToolCall,
    classifyToolResult,
    type CapturePriority,
    type CaptureRecord,
} from "./capture.ts";
import {
    SNAPSHOT_ENTRY_TYPE,
    buildSnapshot,
    type Snapshot,
} from "./snapshot.ts";

const SNAPSHOT_READY_TYPE = "think-in-code:snapshot:ready";
const SNAPSHOT_CONSUMED_TYPE = "think-in-code:snapshot:consumed";
const CUSTOM_ENTRY_VERSION = 1;

type CustomEntryLike = Pick<SessionEntry, "type"> & {
    customType?: string;
    data?: unknown;
};

interface SnapshotEntryData {
    version: 1;
    sessionId: string;
    snapshotId: number;
    snapshot: Snapshot;
}

interface MarkerEntryData {
    version: 1;
    sessionId: string;
    snapshotId: number;
    compactionEntryId?: string;
}

interface HookOptions {
    store: ThinkStore;
    tokenBudget?: number;
    captureMaxChars?: number;
    appendEntry?: (
        customType: string,
        data: SnapshotEntryData | MarkerEntryData,
    ) => void;
}

export class HookState {
    readonly #store: ThinkStore;
    readonly #tokenBudget: number;
    readonly #captureMaxChars: number;
    readonly #appendEntry?: HookOptions["appendEntry"];
    readonly #emittedEntries: Array<{
        type: "custom";
        customType: string;
        data: SnapshotEntryData | MarkerEntryData;
    }> = [];
    #buffer: CaptureBuffer | undefined;
    #sessionId: string | undefined;
    #currentTurn = 0;
    #snapshot: Snapshot | undefined;
    #snapshotId: number | undefined;
    #readyCompactionEntryId: string | undefined;

    constructor(options: HookOptions) {
        this.#store = options.store;
        this.#tokenBudget = options.tokenBudget ?? 1500;
        this.#captureMaxChars = options.captureMaxChars ?? 1024;
        this.#appendEntry = options.appendEntry;
    }

    start(sessionId: string, entries: readonly CustomEntryLike[] = []): void {
        this.#sessionId = sessionId;
        this.#buffer = new CaptureBuffer(
            this.#store,
            sessionId,
            this.#captureMaxChars,
        );
        this.#snapshot = undefined;
        this.#snapshotId = undefined;
        this.#readyCompactionEntryId = undefined;

        const snapshots = new Map<number, Snapshot>();
        const ready = new Map<number, string>();
        const consumed = new Set<number>();
        for (const entry of entries) {
            if (entry.type !== "custom") continue;
            if (entry.customType === SNAPSHOT_ENTRY_TYPE) {
                const data = parseSnapshotEntry(entry.data, sessionId);
                if (data) snapshots.set(data.snapshotId, data.snapshot);
            } else if (entry.customType === SNAPSHOT_READY_TYPE) {
                const data = parseMarkerEntry(entry.data, sessionId);
                if (data?.compactionEntryId)
                    ready.set(data.snapshotId, data.compactionEntryId);
            } else if (entry.customType === SNAPSHOT_CONSUMED_TYPE) {
                const data = parseMarkerEntry(entry.data, sessionId);
                if (data) consumed.add(data.snapshotId);
            }
        }
        for (const [snapshotId, snapshot] of [
            ...snapshots.entries(),
        ].toReversed()) {
            const compactionEntryId = ready.get(snapshotId);
            if (compactionEntryId && !consumed.has(snapshotId)) {
                this.#snapshotId = snapshotId;
                this.#snapshot = snapshot;
                this.#readyCompactionEntryId = compactionEntryId;
                break;
            }
        }
    }

    captureUserPrompt(prompt: string): void {
        this.#buffer?.add({
            sessionId: this.#sessionId ?? "",
            turnIndex: this.#currentTurn,
            source: "user",
            priority: 2 satisfies CapturePriority,
            text: prompt,
        });
    }

    captureToolCall(toolName: string, args: Record<string, unknown>): void {
        const classification = classifyToolCall({ toolName, args });
        this.#buffer?.add({
            sessionId: this.#sessionId ?? "",
            turnIndex: this.#currentTurn,
            source: "tool-call",
            priority: classification.priority,
            text: classification.text,
        });
    }

    captureToolResult(input: {
        toolName: string;
        isError: boolean;
        details?: unknown;
        references?: readonly string[];
    }): void {
        const classification = classifyToolResult(input);
        this.#buffer?.add({
            sessionId: this.#sessionId ?? "",
            turnIndex: this.#currentTurn,
            source: "tool-result",
            priority: classification.priority,
            text: classification.text,
            references: classification.references,
        });
    }

    endTurn(): void {
        this.#buffer?.flush();
        this.#currentTurn += 1;
    }

    buildAndPersistSnapshot(sessionId: string): Snapshot | undefined {
        try {
            const records: CaptureRecord[] = [];
            const events = __getRawDatabase(this.#store)
                .query(
                    `SELECT payload FROM session_events
                       WHERE session_id = ? AND kind LIKE ?
                       ORDER BY turn_index, id`,
                )
                .all(sessionId, `${CAPTURE_ENTRY_TYPE}:%`) as Array<{
                payload: string;
            }>;
            for (const row of events) {
                try {
                    records.push(JSON.parse(row.payload) as CaptureRecord);
                } catch {
                    // Ignore malformed historical capture rows.
                }
            }
            records.push(...(this.#buffer?.pending() ?? []));
            const snapshot = buildSnapshot(records, {
                tokenBudget: this.#tokenBudget,
            });
            const saved = this.#store.saveSnapshot({
                sessionId,
                turnIndex: this.#currentTurn,
                content: snapshot.content,
            });
            this.#snapshot = snapshot;
            this.#snapshotId = saved.id;
            this.#readyCompactionEntryId = undefined;
            this.#emit(SNAPSHOT_ENTRY_TYPE, {
                version: CUSTOM_ENTRY_VERSION,
                sessionId,
                snapshotId: saved.id,
                snapshot,
            });
            return snapshot;
        } catch {
            return undefined;
        }
    }

    markReadyForRestore(sessionId: string, compactionEntryId: string): void {
        if (
            this.#sessionId !== sessionId ||
            this.#snapshotId === undefined ||
            !this.#snapshot
        )
            return;
        this.#readyCompactionEntryId = compactionEntryId;
        this.#emit(SNAPSHOT_READY_TYPE, {
            version: CUSTOM_ENTRY_VERSION,
            sessionId,
            snapshotId: this.#snapshotId,
            compactionEntryId,
        });
    }

    peekSnapshot(sessionId: string): Snapshot | undefined {
        if (
            this.#sessionId !== sessionId ||
            !this.#snapshot ||
            this.#snapshotId === undefined ||
            !this.#readyCompactionEntryId
        ) {
            return undefined;
        }
        return this.#snapshot;
    }

    consumeSnapshot(sessionId: string): Snapshot | undefined {
        const snapshot = this.peekSnapshot(sessionId);
        if (!snapshot || this.#snapshotId === undefined) return undefined;
        const snapshotId = this.#snapshotId;
        this.#store.markSnapshotConsumed(snapshotId);
        this.#emit(SNAPSHOT_CONSUMED_TYPE, {
            version: CUSTOM_ENTRY_VERSION,
            sessionId,
            snapshotId,
            compactionEntryId: this.#readyCompactionEntryId,
        });
        this.#snapshot = undefined;
        this.#snapshotId = undefined;
        this.#readyCompactionEntryId = undefined;
        return snapshot;
    }

    hasPendingSnapshot(): boolean {
        return this.peekSnapshot(this.#sessionId ?? "") !== undefined;
    }

    customEntries(): Array<{
        type: "custom";
        customType: string;
        data: SnapshotEntryData | MarkerEntryData;
    }> {
        return [...this.#emittedEntries];
    }

    shutdown(): void {
        this.#buffer?.flush();
        this.#buffer = undefined;
    }

    #emit(customType: string, data: SnapshotEntryData | MarkerEntryData): void {
        this.#emittedEntries.push({ type: "custom", customType, data });
        this.#appendEntry?.(customType, data);
    }
}

export interface RegisterHooksOptions extends Omit<HookOptions, "appendEntry"> {
    sessionIdAt(ctx: ExtensionContext): string;
}

export function registerHooks(
    pi: ExtensionAPI,
    options: RegisterHooksOptions,
): HookState {
    const state = new HookState({
        ...options,
        appendEntry: (customType, data) => pi.appendEntry(customType, data),
    });
    let sessionId = "unknown";

    pi.on("session_start", (_event, ctx) => {
        sessionId = options.sessionIdAt(ctx);
        state.start(sessionId, ctx.sessionManager.getEntries());
    });
    pi.on("before_agent_start", (event) => {
        try {
            state.captureUserPrompt(event.prompt ?? "");
        } catch {
            /* fail open */
        }
    });
    pi.on("tool_call", (event) => {
        try {
            state.captureToolCall(
                event.toolName,
                (event.input as Record<string, unknown>) ?? {},
            );
        } catch {
            /* fail open */
        }
    });
    pi.on("tool_result", (event) => {
        try {
            state.captureToolResult({
                toolName: event.toolName,
                isError: Boolean(event.isError),
                details: event.details,
                references: extractArchiveIds(event.details),
            });
        } catch {
            /* fail open */
        }
    });
    pi.on("turn_end", () => {
        try {
            state.endTurn();
        } catch {
            /* fail open */
        }
    });
    pi.on("session_before_compact", () => {
        try {
            state.buildAndPersistSnapshot(sessionId);
        } catch {
            /* fail open */
        }
    });
    pi.on("session_compact", (event) => {
        try {
            state.markReadyForRestore(sessionId, event.compactionEntry.id);
        } catch {
            /* fail open */
        }
    });
    pi.on("context", (event) => {
        try {
            const snapshot = state.peekSnapshot(sessionId);
            if (!snapshot) return;
            event.messages.push({
                role: "custom",
                customType: SNAPSHOT_ENTRY_TYPE,
                content: snapshot.content,
                display: false,
                details: { restoredAfterCompaction: true },
                timestamp: Date.now(),
            });
            state.consumeSnapshot(sessionId);
        } catch {
            /* fail open */
        }
    });
    pi.on("session_shutdown", () => {
        try {
            state.shutdown();
        } catch {
            /* fail open */
        }
    });
    return state;
}

function parseSnapshotEntry(
    data: unknown,
    sessionId: string,
): SnapshotEntryData | undefined {
    if (
        !isRecord(data) ||
        data.version !== CUSTOM_ENTRY_VERSION ||
        data.sessionId !== sessionId
    )
        return undefined;
    if (
        !Number.isInteger(data.snapshotId) ||
        !isRecord(data.snapshot) ||
        typeof data.snapshot.content !== "string"
    )
        return undefined;
    return data as unknown as SnapshotEntryData;
}

function parseMarkerEntry(
    data: unknown,
    sessionId: string,
): MarkerEntryData | undefined {
    if (
        !isRecord(data) ||
        data.version !== CUSTOM_ENTRY_VERSION ||
        data.sessionId !== sessionId
    )
        return undefined;
    if (!Number.isInteger(data.snapshotId)) return undefined;
    if (
        data.compactionEntryId !== undefined &&
        typeof data.compactionEntryId !== "string"
    )
        return undefined;
    return data as unknown as MarkerEntryData;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractArchiveIds(details: unknown): string[] | undefined {
    if (!isRecord(details) || !Array.isArray(details.archiveIds))
        return undefined;
    const filtered = details.archiveIds.filter(
        (id): id is string => typeof id === "string",
    );
    return filtered.length > 0 ? filtered : undefined;
}

export const __test = {
    SNAPSHOT_ENTRY_TYPE,
    SNAPSHOT_READY_TYPE,
    SNAPSHOT_CONSUMED_TYPE,
    extractArchiveIds,
    parseSnapshotEntry,
    parseMarkerEntry,
};
