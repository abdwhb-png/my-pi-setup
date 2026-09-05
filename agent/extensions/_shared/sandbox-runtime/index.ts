import type { BashOperations } from "@earendil-works/pi-coding-agent";

import type { CreateBashOperationsOptions } from "../command-execution/exec.ts";
import type { AnalysisRequest, AnalysisResult } from "./analysis-protocol.ts";

export interface AnalysisSandboxPort {
    run(
        request: AnalysisRequest,
        signal?: AbortSignal,
    ): Promise<AnalysisResult>;
    shutdown(): Promise<void>;
}

export interface SandboxBashOperationOptions {
    stdin?: string;
    rewriteCommand?: CreateBashOperationsOptions["rewriteCommand"];
}

export type SandboxRuntimeSnapshot =
    | { state: "uninitialized" }
    | { state: "disabled" }
    | { state: "error" }
    | {
          state: "enabled";
          createBashOperations(
              options: SandboxBashOperationOptions,
          ): BashOperations;
          analysis: AnalysisSandboxPort;
      };

interface SandboxRuntimeRegistry {
    owner?: symbol;
    snapshot: SandboxRuntimeSnapshot;
    diagnostic?: string;
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
    current.snapshot = { state: "uninitialized" };
    current.diagnostic = undefined;
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
    return true;
}

export function releaseSandboxRuntime(owner: symbol): boolean {
    const current = registry();
    if (current.owner !== owner) return false;
    current.owner = undefined;
    current.snapshot = { state: "uninitialized" };
    current.diagnostic = undefined;
    return true;
}

export function getSandboxRuntime(): SandboxRuntimeSnapshot {
    return registry().snapshot;
}

export type SandboxUnavailableKind =
    | "uninitialized"
    | "disabled"
    | "initialization-failed";

const SANDBOX_UNAVAILABLE_BRAND: unique symbol = Symbol.for(
    "pi.sandbox-runtime.SandboxUnavailableError.v2",
);
const VALID_UNAVAILABLE_KINDS: ReadonlySet<SandboxUnavailableKind> = new Set([
    "uninitialized",
    "disabled",
    "initialization-failed",
]);
const SURFACED_REASON: Readonly<Record<SandboxUnavailableKind, string>> = {
    uninitialized: "Sandbox execution unavailable: uninitialized",
    disabled: "Sandbox execution unavailable: disabled",
    "initialization-failed":
        "Sandbox execution unavailable: initialization failed",
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

export function createSandboxBashOperations(
    options: SandboxBashOperationOptions = {},
): BashOperations {
    const snapshot = getSandboxRuntime();
    if (snapshot.state === "enabled") {
        return snapshot.createBashOperations(options);
    }
    return {
        async exec() {
            throw unavailableError();
        },
    };
}

export function getSandboxAnalysisPort(): AnalysisSandboxPort {
    const snapshot = getSandboxRuntime();
    if (snapshot.state === "enabled") return snapshot.analysis;
    return {
        async run() {
            throw unavailableError();
        },
        async shutdown() {
            return undefined;
        },
    };
}
