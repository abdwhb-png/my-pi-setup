import type { ChildProcess } from "node:child_process";
import {
    SANDBOX_ERROR_CODES,
    SandboxExecutionError,
    isSandboxExecutionError,
    sandboxErrorMessage,
    type SandboxErrorCode,
} from "../../_shared/sandbox-runtime/errors.ts";

export {
    SANDBOX_ERROR_CODES,
    SandboxExecutionError,
    isSandboxExecutionError,
    sandboxErrorMessage,
    type SandboxErrorCode,
};

export type SandboxProfileName = "bash-general" | "analysis-strict";

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
    | { type: "compose-service"; project: string; service: string };

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
    docker: SandboxDockerPolicy;
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
    dynamicDenyGlobs: true;
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
    dynamicDenyGlobs: true,
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
