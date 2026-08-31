export type SavedPlanKind = "session_plan" | "pi-plan";

export type SavedPlan = {
    readonly kind: SavedPlanKind;
    readonly key: string;
    readonly topic?: string;
    readonly path?: string;
    readonly version?: number;
    readonly bytes?: number;
    readonly at: string;
};

export type SavedPlanInput = Omit<SavedPlan, "at"> & {
    readonly at?: string;
};

type SessionPlans = Map<string, SavedPlan>;
type SavedPlansRegistry = Map<string, SessionPlans>;

const REGISTRY_KEY = Symbol.for("pi.savedPlans");

type GlobalWithSavedPlans = typeof globalThis & {
    [REGISTRY_KEY]?: SavedPlansRegistry;
};

function registry(): SavedPlansRegistry {
    const target = globalThis as GlobalWithSavedPlans;
    const existing = target[REGISTRY_KEY];
    if (existing) return existing;

    const created = new Map<string, SessionPlans>();
    target[REGISTRY_KEY] = created;
    return created;
}

function normalizedKey(entry: SavedPlanInput): string {
    return `${entry.kind}:${entry.key.trim().toLocaleLowerCase()}`;
}

export function recordSavedPlan(
    sessionId: string,
    entry: SavedPlanInput,
): SavedPlan {
    const plans = registry();
    const sessionPlans = plans.get(sessionId) ?? new Map<string, SavedPlan>();
    plans.set(sessionId, sessionPlans);

    const savedPlan: SavedPlan = {
        ...entry,
        at: entry.at ?? new Date().toISOString(),
    };
    sessionPlans.set(normalizedKey(entry), savedPlan);
    return savedPlan;
}

export function listSavedPlans(sessionId: string): SavedPlan[] {
    return [...(registry().get(sessionId)?.values() ?? [])].toSorted(
        (left, right) => left.at.localeCompare(right.at),
    );
}

export function clearSavedPlansForSession(sessionId: string): void {
    registry().delete(sessionId);
}
