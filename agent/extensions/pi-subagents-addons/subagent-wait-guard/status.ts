import type { SubagentRpcToolResult } from "../../_shared/subagents/rpc-client.ts";

export interface ActiveSubagentRun {
    id: string;
    status: "queued" | "running" | "paused";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read the package's current-session projection; incomplete status is never settlement proof. */
export function readActiveRuns(
    result: SubagentRpcToolResult,
): ActiveSubagentRun[] {
    if (result.isError)
        throw new Error(result.text || "Subagent status failed.");
    const snapshot = result.asyncSnapshot;
    if (
        snapshot?.kind !== "pi-subagents.async-status-snapshot" ||
        snapshot.version !== 1 ||
        !Array.isArray(snapshot.runs)
    ) {
        throw new Error("Subagent status lacks a supported async snapshot.");
    }
    const omitted = snapshot.omitted;
    if (
        !isRecord(omitted) ||
        omitted.runs !== 0 ||
        omitted.children !== 0 ||
        omitted.byteLimitExceeded !== false
    ) {
        throw new Error(
            "Subagent status is incomplete; inspect subagent status before concluding.",
        );
    }
    const runs: ActiveSubagentRun[] = [];
    const identities = new Set<string>();
    const terminal = new Set([
        "complete",
        "failed",
        "partial",
        "stopped",
        "rejected",
    ]);
    for (const node of snapshot.runs) {
        if (
            !isRecord(node) ||
            typeof node.id !== "string" ||
            !node.id.trim() ||
            identities.has(node.id)
        ) {
            throw new Error(
                "Subagent status contains an invalid or duplicate run identity.",
            );
        }
        identities.add(node.id);
        const status = node.state;
        if (
            status === "queued" ||
            status === "running" ||
            status === "paused"
        ) {
            runs.push({ id: node.id, status });
        } else if (typeof status !== "string" || !terminal.has(status)) {
            throw new Error(
                "Subagent status contains an unsupported run state.",
            );
        }
    }
    // Fleet display keys are opaque. Never use them as async run IDs.
    if (runs.length === 0 && result.fleet && result.fleet.totalActive !== 0) {
        throw new Error(
            "Subagent fleet has activity without usable async run identities.",
        );
    }
    return runs.toSorted((left, right) => left.id.localeCompare(right.id));
}
