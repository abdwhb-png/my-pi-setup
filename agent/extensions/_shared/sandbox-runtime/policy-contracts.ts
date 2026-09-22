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
    mediatedDirectTcp?: { ports: number[] };
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

export interface SandboxLeasePaths {
    root: string;
    homeDir: string;
    tmpDir: string;
    zeroboxHome: string;
    proxyRunsDir: string;
    profilesDir: string;
}
