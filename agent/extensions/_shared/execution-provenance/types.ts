/** Facts about one execution, independent of its output text. */
export interface ExecutionProvenance {
    status: "sandboxed" | "unsandboxed" | "unknown";
    profile:
        | "bash-general"
        | "think-strict"
        | "analysis-strict"
        | "none"
        | "unknown";
    backend: "zerobox" | "local" | "host" | "unknown";
    tmpNamespace: "host" | "lease-private" | "unknown";
    phase: "setup" | "process" | "source" | "analysis" | "policy" | "cleanup";
    outcome:
        | "pending"
        | "succeeded"
        | "failed"
        | "aborted"
        | "timed-out"
        | "blocked";
    exitCode?: number | null;
}

export type ExecutionObserver = (execution: ExecutionProvenance) => void;

export function unknownExecution(): ExecutionProvenance {
    return {
        status: "unknown",
        profile: "unknown",
        backend: "unknown",
        tmpNamespace: "unknown",
        phase: "setup",
        outcome: "pending",
    };
}

export function hostExecution(
    phase: "source" | "process" = "source",
): ExecutionProvenance {
    return {
        status: "unsandboxed",
        profile: "none",
        backend: "host",
        tmpNamespace: "host",
        phase,
        outcome: "succeeded",
    };
}
