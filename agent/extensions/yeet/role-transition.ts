export const YEET_ROLE_TRANSITION_ENTRY_TYPE = "yeet:role-transition" as const;

export type YeetRoleTransitionPhase =
    | "queued"
    | "active"
    | "completed"
    | "cancelled";

export interface YeetRoleTransition {
    id: string;
    phase: YeetRoleTransitionPhase;
    previousRole?: string;
    targetCwd: string;
    timestamp: number;
}

/** Persist one append-only phase of a Yeet role transition. */
export function writeYeetRoleTransition(
    pi: { appendEntry: (customType: string, data?: unknown) => void },
    transition: Omit<YeetRoleTransition, "timestamp"> & {
        timestamp?: number;
    },
): YeetRoleTransition {
    const persisted: YeetRoleTransition = {
        ...transition,
        timestamp: transition.timestamp ?? Date.now(),
    };
    pi.appendEntry(YEET_ROLE_TRANSITION_ENTRY_TYPE, persisted);
    return persisted;
}

function isTransitionPhase(value: string): value is YeetRoleTransitionPhase {
    return (
        value === "queued" ||
        value === "active" ||
        value === "completed" ||
        value === "cancelled"
    );
}

// oxlint-disable-next-line typescript/no-restricted-types -- session entry data is unknown at the Pi API boundary
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/** Return the newest valid persisted Yeet role transition. */
export function findLatestYeetRoleTransition(
    entries: ReadonlyArray<{
        type: string;
        customType?: string;
        // oxlint-disable-next-line typescript/no-restricted-types -- session entry data is unknown at the Pi API boundary
        data?: unknown;
    }>,
): YeetRoleTransition | null {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (
            !entry ||
            entry.type !== "custom" ||
            entry.customType !== YEET_ROLE_TRANSITION_ENTRY_TYPE
        ) {
            continue;
        }

        const data = entry.data;
        if (!isRecord(data)) continue;

        const id = data.id;
        const phase = data.phase;
        const previousRole = data.previousRole;
        const targetCwd = data.targetCwd;
        const timestamp = data.timestamp;
        if (
            typeof id !== "string" ||
            !id ||
            typeof phase !== "string" ||
            !isTransitionPhase(phase) ||
            typeof targetCwd !== "string" ||
            !targetCwd ||
            typeof timestamp !== "number" ||
            (phase === "active" &&
                (typeof previousRole !== "string" || !previousRole))
        ) {
            continue;
        }

        return {
            id,
            phase,
            previousRole:
                typeof previousRole === "string" ? previousRole : undefined,
            targetCwd,
            timestamp,
        };
    }

    return null;
}
