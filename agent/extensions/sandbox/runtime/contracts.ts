import type { ChildProcess } from "node:child_process";
import type { ExecutionProvenance } from "../../_shared/execution-provenance/types.ts";
import {
    SANDBOX_ERROR_CODES,
    SandboxExecutionError,
    isSandboxExecutionError,
    sandboxErrorMessage,
    type SandboxErrorCode,
} from "../../_shared/sandbox-runtime/errors.ts";
import type { SandboxExecutionContext } from "../../_shared/sandbox-runtime/execution-context.ts";
import type {
    SandboxLeasePaths,
    SandboxPolicy,
} from "../../_shared/sandbox-runtime/policy-contracts.ts";

export * from "../../_shared/sandbox-runtime/policy-contracts.ts";

export {
    SANDBOX_ERROR_CODES,
    SandboxExecutionError,
    isSandboxExecutionError,
    sandboxErrorMessage,
    type SandboxErrorCode,
};

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
    execution?: ExecutionProvenance;
    sandboxContext?: SandboxExecutionContext;
    getSandboxContext?: () => SandboxExecutionContext | undefined;
    file: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    statusProtocol: { fd: 3; version: 1 | 2 };
    extraStdio: ("pipe" | "ignore" | number)[];
    beforeSpawn?: () => void;
    cleanup?: () => void | Promise<void>;
    supervise(child: ChildProcess): SandboxStatusSupervision;
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
    hostDomainRouting: true;
    outboundLoopback: true;
    networkDenyAll: true;
    nestedUserNamespacesBlocked: true;
    privateTemp: true;
    environmentFiltering: true;
    processTreeTermination: true;
    dynamicDenyGlobs: true;
    mediatedDirectTcp: boolean;
    inboundBinding: boolean;
    privateNetworkListeners: true;
    arbitraryUnixSockets: boolean;
}

export const SANDBOX_CAPABILITIES: SandboxCapabilities = Object.freeze({
    platforms: ["linux"] as const,
    strict: true,
    exactReadDeny: true,
    exactWriteDeny: true,
    domainAllowlist: true,
    hostDomainRouting: true,
    outboundLoopback: true,
    networkDenyAll: true,
    nestedUserNamespacesBlocked: true,
    privateTemp: true,
    environmentFiltering: true,
    processTreeTermination: true,
    dynamicDenyGlobs: true,
    mediatedDirectTcp: false,
    inboundBinding: false,
    privateNetworkListeners: true,
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
