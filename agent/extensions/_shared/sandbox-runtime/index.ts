import type { BashOperations } from "@earendil-works/pi-coding-agent";

import type { CreateBashOperationsOptions } from "../command-execution/exec.ts";
import type { ExecutionObserver } from "../execution-provenance/types.ts";
import type { AnalysisRequest, AnalysisResult } from "./analysis-protocol.ts";
import type { DockerAccessSummary } from "./docker-summary.ts";
import type { SandboxExecutionContextV1 } from "./execution-context.ts";
import type { SandboxProfileContextsV1 } from "./execution-context.ts";

export {
    SANDBOX_ERROR_CODES,
    SandboxExecutionError,
    isSandboxExecutionError,
    sandboxErrorMessage,
    type SandboxErrorCode,
} from "./errors.ts";

export interface AnalysisSandboxPort {
    run(
        request: AnalysisRequest,
        signal?: AbortSignal,
    ): Promise<AnalysisResult>;
    shutdown(): Promise<void>;
}

/**
 * Analysis becomes ready independently from the Bash sandbox. The object is
 * intentionally mutable: changing only Analysis readiness must not interrupt
 * Bash operations that captured the enabled runtime snapshot.
 */
export interface SandboxAnalysisRuntime {
    state: "ready" | "retrying";
    diagnostic?: string;
    service?: AnalysisSandboxPort;
}

export interface SandboxBashOperationOptions {
    onExecution?: ExecutionObserver;
    onSandboxContext?: (context: SandboxExecutionContextV1) => void;
    stdin?: string;
    rewriteCommand?: CreateBashOperationsOptions["rewriteCommand"];
}

export type SandboxRuntimeSnapshot =
    | { state: "uninitialized" }
    | { state: "reconfiguring" }
    | { state: "disabled" }
    | { state: "error" }
    | {
          state: "enabled";
          contexts?: SandboxProfileContextsV1;
          dockerAccess?: DockerAccessSummary;
          createBashOperations(
              options: SandboxBashOperationOptions,
          ): BashOperations;
          createThinkBashOperations(
              options: SandboxBashOperationOptions,
          ): BashOperations;
          analysis: SandboxAnalysisRuntime;
      };

interface SandboxRuntimeRegistry {
    owner?: symbol;
    session?: number;
    snapshot: SandboxRuntimeSnapshot;
    diagnostic?: string;
    waiters?: Set<() => void>;
    activeExecutions?: number;
}

const RUNTIME_KEY = Symbol.for("pi.sandbox-runtime.v2");

function registry(): SandboxRuntimeRegistry {
    const globals = globalThis as typeof globalThis & {
        [RUNTIME_KEY]?: SandboxRuntimeRegistry;
    };
    globals[RUNTIME_KEY] ??= { snapshot: { state: "uninitialized" } };
    return globals[RUNTIME_KEY];
}

export function claimSandboxRuntime(owner: symbol): void {
    const current = registry();
    current.owner = owner;
    current.session = (current.session ?? 0) + 1;
    current.snapshot = { state: "uninitialized" };
    current.diagnostic = undefined;
    current.activeExecutions = 0;
    wakeWaiters(current);
}

export function ownsSandboxRuntime(owner: symbol): boolean {
    return registry().owner === owner;
}

export function publishSandboxRuntime(
    owner: symbol,
    snapshot: SandboxRuntimeSnapshot,
    diagnostic?: string,
): boolean {
    const current = registry();
    if (current.owner !== owner) return false;
    current.snapshot = snapshot;
    current.diagnostic = snapshot.state === "error" ? diagnostic : undefined;
    wakeWaiters(current);
    return true;
}

export function releaseSandboxRuntime(owner: symbol): boolean {
    const current = registry();
    if (current.owner !== owner) return false;
    current.owner = undefined;
    current.snapshot = { state: "uninitialized" };
    current.diagnostic = undefined;
    wakeWaiters(current);
    return true;
}

export function getSandboxRuntime(): SandboxRuntimeSnapshot {
    return registry().snapshot;
}

/** Return executions already dispatched through the current runtime owner. */
export function getSandboxActiveExecutionCount(owner: symbol): number {
    const current = registry();
    return current.owner === owner ? (current.activeExecutions ?? 0) : 0;
}

export type SandboxUnavailableKind =
    | "uninitialized"
    | "disabled"
    | "initialization-failed"
    | "analysis-unavailable"
    | "reconfiguration-timeout"
    | "session-changed"
    | "execution-interrupted";

const SANDBOX_UNAVAILABLE_BRAND: unique symbol = Symbol.for(
    "pi.sandbox-runtime.SandboxUnavailableError.v2",
);
const VALID_UNAVAILABLE_KINDS: ReadonlySet<SandboxUnavailableKind> = new Set([
    "uninitialized",
    "disabled",
    "initialization-failed",
    "analysis-unavailable",
    "reconfiguration-timeout",
    "session-changed",
    "execution-interrupted",
]);
const SURFACED_REASON: Readonly<Record<SandboxUnavailableKind, string>> = {
    uninitialized: "Sandbox execution unavailable: uninitialized",
    disabled: "Sandbox execution unavailable: disabled",
    "initialization-failed":
        "Sandbox execution unavailable: initialization failed",
    "analysis-unavailable": "analysis-unavailable",
    "reconfiguration-timeout":
        "Sandbox reconfiguration did not finish in time; the request was not executed",
    "session-changed":
        "Sandbox session changed; the pending request was not executed",
    "execution-interrupted":
        "Sandbox execution was interrupted by reconfiguration; it was not retried",
};

export class SandboxUnavailableError extends Error {
    readonly kind!: SandboxUnavailableKind;
    readonly diagnostic?: string;

    constructor(kind: SandboxUnavailableKind, diagnostic?: string) {
        super(SURFACED_REASON[kind]);
        this.name = "SandboxUnavailableError";
        Object.defineProperty(this, "kind", {
            value: kind,
            enumerable: false,
            writable: false,
            configurable: false,
        });
        if (diagnostic !== undefined) {
            Object.defineProperty(this, "diagnostic", {
                value: diagnostic,
                enumerable: false,
                writable: false,
                configurable: false,
            });
        }
        Object.defineProperty(this, SANDBOX_UNAVAILABLE_BRAND, {
            value: true,
            enumerable: false,
            writable: false,
            configurable: false,
        });
    }

    getKind(): SandboxUnavailableKind {
        return this.kind;
    }

    getDiagnostic(): string | undefined {
        return this.diagnostic;
    }
}

export function isSandboxUnavailableError(
    error: unknown,
): error is SandboxUnavailableError {
    if (typeof error !== "object" || error === null) return false;
    const record = error as Record<string | symbol, unknown>;
    if (record[SANDBOX_UNAVAILABLE_BRAND] !== true) return false;
    const kind = record.kind;
    return (
        typeof kind === "string" &&
        VALID_UNAVAILABLE_KINDS.has(kind as SandboxUnavailableKind)
    );
}

function unavailableKind(
    snapshot: SandboxRuntimeSnapshot,
): SandboxUnavailableKind {
    if (snapshot.state === "disabled") return "disabled";
    if (snapshot.state === "error") return "initialization-failed";
    return "uninitialized";
}

function unavailableError(): SandboxUnavailableError {
    const current = registry();
    return new SandboxUnavailableError(
        unavailableKind(current.snapshot),
        current.diagnostic,
    );
}

function wakeWaiters(current: SandboxRuntimeRegistry): void {
    for (const wake of current.waiters ?? []) wake();
}

/** A transition never grants a local fallback or extends an execution deadline. */
async function withActiveRuntime<T>(
    owner: symbol | undefined,
    session: number | undefined,
    signal: AbortSignal | undefined,
    budgetMs: number,
    run: (
        snapshot: Extract<SandboxRuntimeSnapshot, { state: "enabled" }>,
        remainingMs: number,
    ) => Promise<T>,
): Promise<T> {
    const started = performance.now();
    const deadline = started + Math.min(30_000, budgetMs);
    let waited = false;
    while (true) {
        if (signal?.aborted)
            throw new Error("aborted; the request was not executed");
        const current = registry();
        if (current.owner !== owner || current.session !== session)
            throw new SandboxUnavailableError("session-changed");
        if (waited && performance.now() >= deadline)
            throw new SandboxUnavailableError("reconfiguration-timeout");
        if (current.snapshot.state !== "reconfiguring") {
            if (current.snapshot.state !== "enabled") {
                const error = unavailableError();
                if (waited)
                    error.message += "; the pending request was not executed";
                throw error;
            }
            const snapshot = current.snapshot;
            const remaining = budgetMs - (performance.now() - started);
            if (remaining <= 0)
                throw new SandboxUnavailableError("reconfiguration-timeout");
            current.activeExecutions = (current.activeExecutions ?? 0) + 1;
            try {
                // Dispatch in the same turn as the snapshot check: no stale adapter gap.
                // oxlint-disable-next-line no-await-in-loop -- Exactly one dispatch follows readiness; its failure must retain this snapshot.
                return await run(snapshot, remaining);
            } catch (error) {
                if (getSandboxRuntime() !== snapshot && !signal?.aborted)
                    throw new SandboxUnavailableError("execution-interrupted");
                throw error;
            } finally {
                const latest = registry();
                if (latest.owner === owner && latest.session === session) {
                    latest.activeExecutions = Math.max(
                        0,
                        (latest.activeExecutions ?? 1) - 1,
                    );
                }
            }
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0)
            throw new SandboxUnavailableError("reconfiguration-timeout");
        waited = true;
        // oxlint-disable-next-line no-await-in-loop -- Each notification requires a fresh state check before any execution.
        await new Promise<void>((resolve) => {
            const waiters = (current.waiters ??= new Set());
            const wake = () => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", wake);
                waiters.delete(wake);
                resolve();
            };
            const timer = setTimeout(wake, remaining);
            waiters.add(wake);
            signal?.addEventListener("abort", wake, { once: true });
            if (signal?.aborted) wake();
        });
    }
}

function bashOperations(
    options: SandboxBashOperationOptions,
    think: boolean,
): BashOperations {
    const { owner, session } = registry();
    return {
        async exec(command, cwd, executionOptions) {
            const budget =
                executionOptions.timeout && executionOptions.timeout > 0
                    ? executionOptions.timeout * 1000
                    : Infinity;
            return withActiveRuntime(
                owner,
                session,
                executionOptions.signal,
                budget,
                async (snapshot, remaining) => {
                    const operations = think
                        ? snapshot.createThinkBashOperations(options)
                        : snapshot.createBashOperations(options);
                    const result = await operations.exec(command, cwd, {
                        ...executionOptions,
                        ...(Number.isFinite(budget)
                            ? { timeout: remaining / 1000 }
                            : {}),
                    });
                    if (
                        result.exitCode === null &&
                        getSandboxRuntime() !== snapshot
                    )
                        throw new SandboxUnavailableError(
                            "execution-interrupted",
                        );
                    return result;
                },
            );
        },
    };
}

export function createSandboxBashOperations(
    options: SandboxBashOperationOptions = {},
): BashOperations {
    return bashOperations(options, false);
}

export function createSandboxThinkBashOperations(
    options: SandboxBashOperationOptions = {},
): BashOperations {
    return bashOperations(options, true);
}

export function getSandboxAnalysisPort(): AnalysisSandboxPort {
    const { owner, session } = registry();
    return {
        async run(request, signal) {
            const budget = request.limits?.wallTimeMs ?? 60_000;
            return withActiveRuntime(
                owner,
                session,
                signal,
                budget,
                (snapshot, remaining) => {
                    if (
                        snapshot.analysis.state !== "ready" ||
                        !snapshot.analysis.service
                    ) {
                        throw new SandboxUnavailableError(
                            "analysis-unavailable",
                            snapshot.analysis.diagnostic,
                        );
                    }
                    return snapshot.analysis.service.run(
                        {
                            ...request,
                            limits: {
                                ...request.limits,
                                wallTimeMs: Math.max(1, Math.floor(remaining)),
                            },
                        },
                        signal,
                    );
                },
            );
        },
        async shutdown() {
            const current = registry();
            if (
                current.owner === owner &&
                current.session === session &&
                current.snapshot.state === "enabled"
            ) {
                const analysis = current.snapshot.analysis;
                if (analysis.state === "ready" && analysis.service) {
                    await analysis.service.shutdown();
                }
            }
        },
    };
}
