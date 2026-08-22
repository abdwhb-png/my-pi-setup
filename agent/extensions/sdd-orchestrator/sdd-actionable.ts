import type { RunSnapshot, RunState } from "./state-machine.ts";

/**
 * The subset of {@link RunSnapshot} the SDD actionability predicate needs.
 * Kept narrow so the predicate is testable without heavy transitive imports.
 */
export type ActionableSnapshot = Pick<
    RunSnapshot,
    | "runId"
    | "revision"
    | "state"
    | "tasks"
    | "consumedIdempotencyKeys"
    | "plannedDelegations"
    | "workspace"
>;

/**
 * Whether an SDD run still requires a workflow tool in the session.
 *
 * In-flight and pre-flight states are always actionable. A `completed` run is
 * actionable only when it still owns an isolated workspace with a pending
 * delivery (it needs `sdd_apply`). Once applied — or when failed/cancelled and
 * not explicitly resumed — the SDD workflow tools should leave the active set.
 */
export function isSddActionable(snap: ActionableSnapshot): boolean {
    if (isVisibleState(snap.state)) return true;
    if (snap.state === "completed") {
        return (
            snap.workspace?.mode === "isolated" &&
            snap.workspace.delivery.status !== "applied"
        );
    }
    return false;
}

function isVisibleState(state: RunSnapshot["state"]): boolean {
    return VISIBLE_STATES.has(state);
}

const VISIBLE_STATES: Readonly<Set<RunState>> = new Set([
    "draft",
    "assessed",
    "awaiting_approval",
    "approved",
    "running",
    "needs_input",
]);
