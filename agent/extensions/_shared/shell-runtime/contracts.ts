export type SandboxMode = "sandbox" | "host";

/** Historical literals are accepted only by legacy readers. */
export type ShellProfile = "default" | "custom" | "host";

export interface CapabilityGrants {
    domains: string[];
    hostDomains: string[];
    readPaths: string[];
    writePaths: string[];
    hostTmp: boolean;
}

export interface ShellCapabilityResolution {
    hostAllowed?: boolean;
    state:
        | "ready"
        | "authorization-required"
        | "migration-required"
        | "machine-mismatch";
    projectRoot: string;
    mode?: SandboxMode;
    requestedMode?: SandboxMode;
    profile: ShellProfile;
    requestedProfile: ShellProfile;
    grants: CapabilityGrants;
    requestedGrants: CapabilityGrants;
    authorityPath: string;
    diagnostic?: string;
    sandboxFingerprint?: string;
}

export function emptyGrants(): CapabilityGrants {
    return {
        domains: [],
        hostDomains: [],
        readPaths: [],
        writePaths: [],
        hostTmp: false,
    };
}
