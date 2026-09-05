import type { ChildProcess } from "node:child_process";

export const SANDBOX_ERROR_CODES = [
    "unsupported-platform",
    "backend-unavailable",
    "provenance-mismatch",
    "strict-unavailable",
    "unsupported-capability",
    "invalid-policy",
    "spawn-failed",
    "setup-failed",
    "protocol-error",
    "timeout",
    "aborted",
    "cleanup-failed",
] as const;

export type SandboxErrorCode = (typeof SANDBOX_ERROR_CODES)[number];

const PUBLIC_ERROR_MESSAGES: Record<SandboxErrorCode, string> = {
    "unsupported-platform": "Sandbox execution is unsupported on this platform",
    "backend-unavailable": "Sandbox backend is unavailable",
    "provenance-mismatch": "Sandbox backend provenance does not match",
    "strict-unavailable": "Strict sandbox enforcement is unavailable",
    "unsupported-capability":
        "Sandbox configuration requests an unsupported capability",
    "invalid-policy": "Sandbox policy is invalid",
    "spawn-failed": "Sandbox process could not be started",
    "setup-failed": "Sandbox setup failed",
    "protocol-error": "Sandbox status protocol failed",
    timeout: "Sandbox execution timed out",
    aborted: "Sandbox execution was aborted",
    "cleanup-failed": "Sandbox cleanup failed",
};

export class SandboxExecutionError extends Error {
    readonly code: SandboxErrorCode;

    constructor(
        code: SandboxErrorCode,
        options: { cause?: unknown; cleanupError?: unknown } = {},
    ) {
        super(PUBLIC_ERROR_MESSAGES[code]);
        Object.defineProperty(this, "name", {
            configurable: true,
            enumerable: false,
            value: "SandboxExecutionError",
            writable: true,
        });
        this.code = code;
        Object.defineProperty(this, "cause", {
            configurable: false,
            enumerable: false,
            value: options.cause,
            writable: false,
        });
        Object.defineProperty(this, "cleanupError", {
            configurable: false,
            enumerable: false,
            value: options.cleanupError,
            writable: true,
        });
    }

    getCause(): unknown {
        return (this as Error & { cause?: unknown }).cause;
    }

    getCleanupError(): unknown {
        return (this as { cleanupError?: unknown }).cleanupError;
    }

    attachCleanupError(error: unknown): void {
        if (this.getCleanupError() === undefined) {
            (this as { cleanupError?: unknown }).cleanupError = error;
        }
    }
}

export type SandboxProfileName = "bash-general" | "analysis-strict";

export interface SandboxFilesystemPolicy {
    allowRead: string[];
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
}

export interface SandboxNetworkPolicy {
    mode: "deny-all" | "domain-allowlist";
    allow: string[];
    deny: string[];
}

export interface SandboxEnvironmentPolicy {
    inherit: string[];
    set: Record<string, string>;
    deny: string[];
}

export interface SandboxPolicy {
    name: SandboxProfileName;
    strict: true;
    filesystem: SandboxFilesystemPolicy;
    network: SandboxNetworkPolicy;
    environment: SandboxEnvironmentPolicy;
}

export interface SandboxCommand {
    file: string;
    args: string[];
    cwd: string;
    stdin?: string;
}

export interface SandboxStatusSupervision {
    ready: Promise<void>;
    settled: Promise<void>;
}

export interface SandboxSpawnSpec {
    file: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    statusProtocol: { fd: 3; version: 1 };
    extraStdio: ("pipe" | "ignore" | number)[];
    beforeSpawn?: () => void;
    cleanup?: () => void | Promise<void>;
    supervise(child: ChildProcess): SandboxStatusSupervision;
}

export interface SandboxLeasePaths {
    root: string;
    homeDir: string;
    tmpDir: string;
    zeroboxHome: string;
    proxyRunsDir: string;
    profilesDir: string;
}

export interface PrivateTempLease extends SandboxLeasePaths {
    markerPath: string;
    dispose(): Promise<void>;
}

export interface SandboxCapabilities {
    platforms: readonly ["linux"];
    strict: true;
    exactReadDeny: true;
    exactWriteDeny: true;
    domainAllowlist: true;
    outboundLoopback: true;
    networkDenyAll: true;
    nestedUserNamespacesBlocked: true;
    privateTemp: true;
    environmentFiltering: true;
    processTreeTermination: true;
    dynamicDenyGlobs: false;
    inboundBinding: false;
    arbitraryUnixSockets: false;
}

export const SANDBOX_CAPABILITIES: SandboxCapabilities = Object.freeze({
    platforms: ["linux"] as const,
    strict: true,
    exactReadDeny: true,
    exactWriteDeny: true,
    domainAllowlist: true,
    outboundLoopback: true,
    networkDenyAll: true,
    nestedUserNamespacesBlocked: true,
    privateTemp: true,
    environmentFiltering: true,
    processTreeTermination: true,
    dynamicDenyGlobs: false,
    inboundBinding: false,
    arbitraryUnixSockets: false,
});

export interface SandboxBackend {
    probe(): Promise<SandboxCapabilities>;
    prepare(
        command: SandboxCommand,
        policy: SandboxPolicy,
        lease: PrivateTempLease,
    ): Promise<SandboxSpawnSpec>;
}
