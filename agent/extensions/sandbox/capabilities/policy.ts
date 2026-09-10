import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { PiSandboxConfig } from "../runtime/policies.ts";
import {
    emptyGrants,
    expandCapabilityPath,
    type CapabilityAuthority,
    type CapabilityGrants,
    type ProjectCapabilities,
    type ShellProfile,
} from "./authority.ts";

export interface ShellCapabilityResolution {
    state:
        | "ready"
        | "migration-required"
        | "authorization-required"
        | "machine-mismatch";
    projectRoot: string;
    requestedProfile: ShellProfile;
    profile: ShellProfile;
    grants: CapabilityGrants;
    requestedGrants: CapabilityGrants;
    authorityPath: string;
    diagnostic?: string;
    sandboxFingerprint?: string;
}
export interface ShellPolicyInput {
    cwd: string;
    config: PiSandboxConfig;
    authority: CapabilityAuthority;
    authorityPath: string;
    machineId: string;
    requestedProfile?: ShellProfile;
    projectProfile?: ShellProfile;
    session?: ProjectCapabilities;
    hasLegacySettings: boolean;
    domainsRequested: boolean;
    hostDomainsRequested: boolean;
    tmpRequested?: "host" | "private";
    integrationsRequested?: string[];
    writePathsRequested?: boolean;
}
export function resolveShellPolicy(input: ShellPolicyInput): {
    config: PiSandboxConfig;
    shell: ShellCapabilityResolution;
} {
    const projectRoot = realpathSync(input.cwd);
    const machineMatches = input.authority.machineId === input.machineId;
    const stored = machineMatches
        ? input.authority.projects.find((p) => p.projectRoot === projectRoot)
        : undefined;
    const entry =
        input.session?.projectRoot === projectRoot ? input.session : stored;
    const requestedProfile =
        input.requestedProfile ?? entry?.profile ?? "isolated";
    const requestedGrants: CapabilityGrants = {
        ...emptyGrants(),
        domains: input.config.network.allowedDomains,
        hostDomains: input.config.network.allowedHostDomains,
        readPaths: input.config.filesystem.allowRead.map((p) =>
            resolve(projectRoot, expandRelative(p)),
        ),
        writePaths: input.config.filesystem.allowWrite
            .map((p) => resolve(projectRoot, expandRelative(p)))
            .filter((p) => p !== projectRoot),
        host: requestedProfile === "host",
        // Legacy Bash shared /tmp. Migration must explicitly accept retaining it.
        hostTmp:
            input.tmpRequested === "host" ||
            (input.tmpRequested === undefined && input.hasLegacySettings),
    };
    let state: ShellCapabilityResolution["state"] = "ready";
    if (!machineMatches && !input.session) state = "machine-mismatch";
    else if (!entry && input.hasLegacySettings) state = "migration-required";
    else if (requestedProfile === "host" && !entry?.grants.host)
        state = "authorization-required";
    const order: ShellProfile[] = ["isolated", "integrated", "host"];
    const profile =
        state !== "ready"
            ? "isolated"
            : input.projectProfile
              ? order[
                    Math.min(
                        order.indexOf(requestedProfile),
                        order.indexOf(input.projectProfile),
                    )
                ]
              : requestedProfile;
    const grants = structuredClone(
        profile === "isolated"
            ? emptyGrants()
            : (entry?.grants ?? emptyGrants()),
    );
    if (input.domainsRequested)
        grants.domains = grants.domains.filter((p) =>
            input.config.network.allowedDomains.includes(p),
        );
    if (input.hostDomainsRequested)
        grants.hostDomains = grants.hostDomains.filter((p) =>
            input.config.network.allowedHostDomains.includes(p),
        );
    if (input.tmpRequested === "private") grants.hostTmp = false;
    if (input.integrationsRequested) {
        for (const name of Object.keys(grants.integrations)) {
            if (!input.integrationsRequested.includes(name))
                delete grants.integrations[
                    name as keyof typeof grants.integrations
                ];
        }
    }
    const requestedRead = input.config.filesystem.allowRead.map((p) =>
        resolve(projectRoot, expandRelative(p)),
    );
    const allowedRead = requestedRead.filter((p) =>
        [projectRoot, ...grants.readPaths].some(
            (allowed) => p === allowed || p.startsWith(`${allowed}/`),
        ),
    );
    const unavailableRead =
        requestedRead.length > 0 && allowedRead.length === 0;
    if (unavailableRead && state === "ready" && profile !== "host")
        state = "authorization-required";
    const config: PiSandboxConfig = {
        ...input.config,
        // Engine readiness and the shell execution profile are independent.
        enabled: true,
        tmpNamespace: grants.hostTmp ? "host" : "lease-private",
        network: {
            ...input.config.network,
            allowedDomains: grants.domains,
            allowedHostDomains: grants.hostDomains,
        },
        filesystem: {
            ...input.config.filesystem,
            allowRead:
                requestedRead.length === 0
                    ? []
                    : unavailableRead
                      ? [projectRoot]
                      : allowedRead,
            allowWrite: input.writePathsRequested
                ? input.config.filesystem.allowWrite
                      .map((p) => resolve(projectRoot, expandRelative(p)))
                      .filter((p) =>
                          [projectRoot, ...grants.writePaths].some(
                              (allowed) =>
                                  p === allowed || p.startsWith(`${allowed}/`),
                          ),
                      )
                : [projectRoot, ...grants.writePaths],
        },
    };
    const diagnostic =
        state === "ready"
            ? undefined
            : state === "machine-mismatch"
              ? "Local grants belong to another machine. Use /sandbox capabilities migrate to review them."
              : state === "migration-required"
                ? "Review existing settings with /sandbox capabilities migrate. No host or network access was granted."
                : unavailableRead
                  ? "The requested read paths have no local grant. Review /sandbox capabilities or narrow filesystem.allowRead to the project."
                  : "The host profile requires an explicit local grant. Use /sandbox profile host.";
    return {
        config,
        shell: {
            state,
            projectRoot,
            requestedProfile,
            profile,
            grants,
            requestedGrants,
            authorityPath: input.authorityPath,
            diagnostic,
            sandboxFingerprint: shellSandboxFingerprint(config),
        },
    };
}
export function shellSandboxFingerprint(config: PiSandboxConfig): string {
    return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
function expandRelative(path: string): string {
    return path === "~" || path.startsWith("~/")
        ? expandCapabilityPath(path)
        : path;
}
