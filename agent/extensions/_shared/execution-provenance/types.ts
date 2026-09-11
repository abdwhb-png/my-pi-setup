/** Facts about one execution, independent of its output text. */
export interface ExecutionProvenance {
    /** Effective configuration mode when the execution boundary observed it. */
    mode?: "sandbox" | "host";
    /** Describes the effective shell policy without changing execution proof. */
    shellProfile?: "default" | "custom" | "host";
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
    /** Observed launcher process state, never proof that external work stopped. */
    localProcess?: "running" | "exited";
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
        mode: "host",
        shellProfile: "host",
        status: "unsandboxed",
        profile: "none",
        backend: "host",
        tmpNamespace: "host",
        phase,
        outcome: "succeeded",
    };
}
