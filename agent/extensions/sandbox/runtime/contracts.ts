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

export {
    SANDBOX_ERROR_CODES,
    SandboxExecutionError,
    isSandboxExecutionError,
    sandboxErrorMessage,
    type SandboxErrorCode,
};

export type SandboxProfileName =
    | "bash-general"
    | "think-strict"
    | "analysis-strict";

export const DOCKER_OPERATIONS = [
    "ps",
    "inspect",
    "logs",
    "stats",
    "exec",
    "start",
    "stop",
    "restart",
] as const;

export type DockerOperation = (typeof DOCKER_OPERATIONS)[number];

export type DockerTargetSelector =
    | { type: "container-name"; name: string }
    | { type: "compose-service"; project: string; service: string }
    | {
          /** Runtime-only selector. Persisted sandbox.json configuration rejects it. */
          type: "ephemeral-container";
          id: string;
          unsafeExecExpiresAtMs: number;
      };

export interface DockerTargetGrant {
    selector: DockerTargetSelector;
    operations?: DockerOperation[];
    allowUnsafeTarget: boolean;
}

export type SandboxDockerPolicy =
    | { mode: "disabled" }
    | {
          mode: "targeted";
          endpoint: string;
          targets: DockerTargetGrant[];
      }
    | { mode: "full"; endpoint: string };

export interface SandboxFilesystemPolicy {
    allowRead: string[];
    denyRead: string[];
    denyReadGlobs: string[];
    allowWrite: string[];
    denyWrite: string[];
    denyWriteGlobs: string[];
}

export interface SandboxNetworkPolicy {
    mode: "deny-all" | "domain-allowlist";
    allow: string[];
    allowHost: string[];
    deny: string[];
    allowLocalBinding?: boolean;
}

export interface SandboxEnvironmentPolicy {
    inherit: string[];
    set: Record<string, string>;
    deny: string[];
}

export interface SandboxTcpPublication {
    transport: "tcp";
    scope: "host" | "lan";
    listen: string;
    target: string;
}

export interface SandboxResourcesPolicy {
    unixSockets: string[];
    tcpPublications: SandboxTcpPublication[];
}

export interface SandboxPolicy {
    name: SandboxProfileName;
    strict: true;
    tmpNamespace: "host" | "lease-private";
    filesystem: SandboxFilesystemPolicy;
    network: SandboxNetworkPolicy;
    environment: SandboxEnvironmentPolicy;
    docker: SandboxDockerPolicy;
    resources?: SandboxResourcesPolicy;
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
    hostDomainRouting: true;
    outboundLoopback: true;
    networkDenyAll: true;
    nestedUserNamespacesBlocked: true;
    privateTemp: true;
    environmentFiltering: true;
    processTreeTermination: true;
    dynamicDenyGlobs: true;
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
