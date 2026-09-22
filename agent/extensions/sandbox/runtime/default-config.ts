import type { SandboxDockerPolicy } from "./contracts.ts";
import { validatePiSandboxConfig, type PiSandboxConfig } from "./policies.ts";

const DEFAULT_CONFIG: Omit<PiSandboxConfig, "docker"> = {
    enabled: true,
    network: {
        allowLocalBinding: true,
        allowedHostDomains: [],
        allowedDomains: [],
        deniedDomains: [],
        mediatedDirectTcp: { enabled: false, ports: [] },
    },
    filesystem: {
        allowRead: ["."],
        denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
        allowWrite: ["."],
        denyWrite: [".env"],
    },
    environment: {
        allowedVariables: [],
        deniedVariables: [],
        variables: {},
        path: [],
    },
    resources: { unixSockets: [], tcpPublications: [] },
};

/** Build the one active baseline used by loading and migration validation. */
export function createDefaultSandboxBaseline(
    docker: SandboxDockerPolicy,
): PiSandboxConfig {
    return validatePiSandboxConfig(DEFAULT_CONFIG, docker);
}
