/** Session capture and one-shot post-compaction restore hooks. */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
    ExtensionContext,
    ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { ThinkStore } from "../storage/store.ts";
import {
    CAPTURE_ENTRY_TYPE,
    CaptureBuffer,
    isCaptureRecord,
    type CaptureRecord,
} from "./capture.ts";
import {
    SNAPSHOT_ENTRY_TYPE,
    buildSnapshot,
    type Snapshot,
} from "./snapshot.ts";

const SNAPSHOT_READY_TYPE = "think-in-code:snapshot:ready";
const SNAPSHOT_CONSUMED_TYPE = "think-in-code:snapshot:consumed";
const LEGACY_ROUTING_ENTRY_TYPE = "think-in-code:routing";
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
    #store: ThinkStore;
    #tokenBudget: number;
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

    rebind(store: ThinkStore, tokenBudget = 1500): void {
        this.shutdown();
        this.#store = store;
        this.#tokenBudget = tokenBudget;
    }

    start(sessionId: string, entries: readonly CustomEntryLike[] = []): void {
        this.#sessionId = sessionId;
        this.#currentTurn = 0;
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
            if (
                compactionEntryId &&
                !consumed.has(snapshotId) &&
                this.#store.isRecentPendingSnapshot(snapshotId, sessionId)
            ) {
                this.#snapshotId = snapshotId;
                this.#snapshot = snapshot;
                this.#readyCompactionEntryId = compactionEntryId;
                break;
            }
        }
    }

    captureToolResult(input: {
        toolName: string;
        content?: unknown;
        details?: unknown;
    }): void {
        this.#buffer?.addToolResult(input, this.#currentTurn);
    }

    endTurn(): void {
        this.#buffer?.flush();
        this.#currentTurn += 1;
    }

    buildAndPersistSnapshot(sessionId: string): Snapshot | undefined {
        try {
            const records: CaptureRecord[] = [];
            const events = this.#store.recentSessionEventPayloads(
                sessionId,
                CAPTURE_ENTRY_TYPE,
            );
            for (const payload of events) {
                try {
                    const parsed: unknown = JSON.parse(payload);
                    if (isCaptureRecord(parsed)) records.push(parsed);
                } catch {
                    // Ignore malformed historical capture rows.
                }
            }
            records.push(...(this.#buffer?.pending() ?? []));
            if (records.length === 0) return undefined;
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
    pi.on("tool_result", (event) => {
        try {
            state.captureToolResult({
                toolName: event.toolName,
                content: event.content,
                details: event.details,
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
            for (let i = event.messages.length - 1; i >= 0; i -= 1) {
                const message = event.messages[i] as AgentMessage & {
                    customType?: string;
                };
                if (message.customType === LEGACY_ROUTING_ENTRY_TYPE) {
                    event.messages.splice(i, 1);
                }
            }
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

export const __test = {
    SNAPSHOT_ENTRY_TYPE,
    SNAPSHOT_READY_TYPE,
    SNAPSHOT_CONSUMED_TYPE,
    parseSnapshotEntry,
    parseMarkerEntry,
};
