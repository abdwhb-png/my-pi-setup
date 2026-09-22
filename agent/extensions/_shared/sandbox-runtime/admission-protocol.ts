import type {
    SandboxDockerPolicy,
    SandboxEnvironmentPolicy,
    SandboxFilesystemPolicy,
    SandboxNetworkPolicy,
    SandboxResourcesPolicy,
} from "./policy-contracts.ts";

export interface SandboxAdmissionReport {
    schema: 1 | 2;
    runtime: {
        target: "x86_64-unknown-linux-gnu";
        version: string;
        manifestSha256: string;
        component: "shell" | "analysis";
    };
    helperSha256: string;
    mounts: {
        source: string;
        destination: string;
        access: "ro" | "rw";
        origin: "runtime" | "policy" | "internal";
    }[];
    pathAliases?: {
        destination: string;
        target: string;
        directory: boolean;
    }[];
    kernelMounts: {
        destination: string;
        root: string;
        source: string;
        filesystem: string;
        access: "ro" | "rw";
    }[];
    filesystem: SandboxFilesystemPolicy;
    network: SandboxNetworkPolicy;
    resources: SandboxResourcesPolicy;
    path: string[];
    environment: Omit<SandboxEnvironmentPolicy, "set"> & { set: string[] };
    home: { path: string; namespace: "lease-private" };
    tmp: { path: "/tmp"; namespace: "host" | "lease-private" };
    docker: SandboxDockerPolicy;
}

export interface SandboxAdmission {
    report: SandboxAdmissionReport;
    sha256: string;
}
