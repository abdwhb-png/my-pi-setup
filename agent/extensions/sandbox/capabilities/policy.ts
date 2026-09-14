import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { DEFAULT_DOCKER_ENDPOINT } from "../runtime/docker-policy.ts";
import type { PiSandboxConfig } from "../runtime/policies.ts";
import { normalizeSandboxResources } from "../runtime/policies.ts";
import { expandShellPathEntry } from "../runtime/shell-baseline.ts";
import {
    canonicalProjectPath,
    canonicalPotentialPath,
    type SandboxConfigLayer,
    type SandboxMode,
    type ShellProfile,
} from "./authority.ts";
import {
    installationContains,
    installationReadPaths,
    selectInstallations,
} from "./installations.ts";

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
    /** Derived from the effective policy. It is never persisted as authority. */
    profile: ShellProfile;
    requestedProfile: ShellProfile;
    grants: {
        domains: string[];
        hostDomains: string[];
        readPaths: string[];
        writePaths: string[];
        hostTmp: boolean;
    };
    requestedGrants: {
        domains: string[];
        hostDomains: string[];
        readPaths: string[];
        writePaths: string[];
        hostTmp: boolean;
    };
    authorityPath: string;
    diagnostic?: string;
    sandboxFingerprint?: string;
}
export interface ShellPolicyInput {
    cwd: string;
    baseline?: PiSandboxConfig;
    /** Historical reader-only input. Kept to compile legacy migration fixtures. */
    config?: PiSandboxConfig;
    global?: SandboxConfigLayer;
    project?: SandboxConfigLayer;
    session?: SandboxConfigLayer;
    authorityPath: string;
    authority?: unknown;
    machineId?: string;
    hasLegacySettings?: boolean;
    domainsRequested?: boolean;
    hostDomainsRequested?: boolean;
    tmpRequested?: "host" | "private";
    writePathsRequested?: boolean;
}

type LayerConfig = Pick<
    PiSandboxConfig,
    "network" | "filesystem" | "environment" | "tmpNamespace"
>;
function canonicalLayer(
    layer: SandboxConfigLayer | undefined,
    root: string,
): SandboxConfigLayer | undefined {
    if (!layer) return undefined;
    const paths = (
        section: "filesystem",
        field: "allowRead" | "denyRead" | "allowWrite" | "denyWrite",
    ) => {
        const raw = layer[section]?.[field];
        if (raw === undefined) return undefined;
        if (!Array.isArray(raw) || raw.some((p) => typeof p !== "string"))
            throw new Error(`${section}.${field} must be a string array`);
        return raw.map((p) => canonicalProjectPath(p, root));
    };
    const filesystem =
        layer.filesystem === undefined
            ? undefined
            : {
                  ...layer.filesystem,
                  ...Object.fromEntries(
                      [
                          "allowRead",
                          "denyRead",
                          "allowWrite",
                          "denyWrite",
                      ].flatMap((field) => {
                          const value = paths(
                              "filesystem",
                              field as "allowRead",
                          );
                          return value === undefined ? [] : [[field, value]];
                      }),
                  ),
              };
    const resources =
        layer.resources === undefined
            ? undefined
            : (() => {
                  const raw = layer.resources as Record<string, unknown>;
                  const normalizedResources = normalizeSandboxResources(raw);
                  return {
                      ...(Object.hasOwn(raw, "unixSockets")
                          ? {
                                unixSockets:
                                    normalizedResources.unixSockets.map(
                                        (socket) =>
                                            canonicalProjectPath(socket, root),
                                    ),
                            }
                          : {}),
                      ...(Object.hasOwn(raw, "tcpPublications")
                          ? {
                                tcpPublications:
                                    normalizedResources.tcpPublications,
                            }
                          : {}),
                  };
              })();
    const environmentPath = list(
        layer.environment?.path,
        "environment.path",
    )?.map(expandShellPathEntry);
    const environmentVariables = variables(
        layer.environment?.variables,
        "environment.variables",
    );
    return {
        ...layer,
        ...(environmentPath === undefined && environmentVariables === undefined
            ? {}
            : {
                  environment: {
                      ...layer.environment,
                      ...(environmentPath === undefined
                          ? {}
                          : { path: environmentPath }),
                      ...(environmentVariables === undefined
                          ? {}
                          : {
                                variables: Object.fromEntries(
                                    Object.entries(environmentVariables).map(
                                        ([key, value]) => [
                                            key,
                                            value.startsWith("~/")
                                                ? expandShellPathEntry(value)
                                                : value,
                                        ],
                                    ),
                                ),
                            }),
                  },
              }),
        ...(filesystem === undefined ? {} : { filesystem }),
        ...(resources === undefined ? {} : { resources }),
    };
}
function list(value: unknown, field: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value))
        throw new Error(`${field} must be a string array`);
    const entries: unknown[] = value;
    if (!entries.every((entry): entry is string => typeof entry === "string"))
        throw new Error(`${field} must be a string array`);
    return entries;
}
function boolean(value: unknown, field: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") throw new Error(field + " must be boolean");
    return value;
}
function variables(
    value: unknown,
    field: string,
): Record<string, string> | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(field + " must be an object");
    }
    const result: Record<string, string> = {};
    for (const [name, configured] of Object.entries(value)) {
        if (typeof configured !== "string") {
            throw new Error(field + " values must be strings");
        }
        result[name] = configured;
    }
    return result;
}
function restrictBoolean(
    requested: boolean | undefined,
    ceiling: boolean,
    field: string,
): boolean {
    if (requested === undefined) return ceiling;
    if (requested && !ceiling)
        throw new Error(field + " is outside its ceiling");
    return requested;
}
function restrictedList(
    requested: string[] | undefined,
    ceiling: string[],
    field: string,
): string[] {
    if (requested === undefined) return ceiling;
    if (requested.some((entry) => !ceiling.includes(entry))) {
        throw new Error(field + " is outside its ceiling");
    }
    return requested;
}
function restrictedVariables(
    requested: Record<string, string> | undefined,
    ceiling: Record<string, string>,
    field: string,
): Record<string, string> {
    if (requested === undefined) return ceiling;
    for (const [name, value] of Object.entries(requested)) {
        if (ceiling[name] !== value) {
            throw new Error(field + " is outside its ceiling");
        }
    }
    return requested;
}
function restrictedExact<T>(
    requested: T[] | undefined,
    ceiling: T[],
    key: (entry: T) => string,
    field: string,
): T[] {
    if (requested === undefined) return ceiling;
    const allowed = new Set(ceiling.map(key));
    if (requested.some((entry) => !allowed.has(key(entry))))
        throw new Error(field + " is outside its ceiling");
    return requested;
}
function narrower(
    requested: string[] | undefined,
    ceiling: string[],
): string[] {
    return requested === undefined
        ? ceiling
        : requested.filter((entry) =>
              ceiling.some((allowed) => domainIsWithin(entry, allowed)),
          );
}

export function domainIsWithin(requested: string, ceiling: string): boolean {
    if (requested === ceiling) return true;
    const port = (value: string) => /:(\d+)$/.exec(value)?.[1];
    const ceilingPort = port(ceiling);
    if (ceilingPort !== undefined && port(requested) !== ceilingPort)
        return false;
    const host = (value: string) => value.replace(/:\d+$/, "");
    const requestedHost = host(requested);
    const ceilingHost = host(ceiling);
    if (requestedHost === ceilingHost) return true;
    if (!ceilingHost.startsWith("*.")) return false;
    const suffix = ceilingHost.slice(1);
    return (
        requestedHost.endsWith(suffix) && requestedHost.length > suffix.length
    );
}
function permittedPath(path: string, ceiling: string[]): boolean {
    return ceiling.some((root) => path === root || path.startsWith(`${root}/`));
}
function narrowerPaths(
    requested: string[] | undefined,
    ceiling: string[],
    projectField?: { name: string; configPath: string; authorityPath: string },
): string[] {
    if (projectField) {
        const outside = requested?.find(
            (path) => !permittedPath(path, ceiling),
        );
        if (outside !== undefined)
            throw new Error(
                `${projectField.configPath}: ${projectField.name} requests ${JSON.stringify(outside)} outside the global ceiling. An explicit authorization covering this path in ${projectField.authorityPath} (${projectField.name}) is required before the project can select it. The command was not executed.`,
            );
    }
    return requested === undefined
        ? ceiling
        : requested.filter((path) => permittedPath(path, ceiling));
}

function preserveAuthorizedReadAliases(
    grants: string[],
    layers: (SandboxConfigLayer | undefined)[],
    projectRoot: string,
): string[] {
    const result = new Set(grants);
    for (const layer of layers) {
        for (const field of ["allowRead", "allowWrite"] as const) {
            for (const raw of list(
                layer?.filesystem?.[field],
                `filesystem.${field}`,
            ) ?? []) {
                const logical = resolve(projectRoot, expandShellPathEntry(raw));
                const canonical = canonicalProjectPath(raw, projectRoot);
                if (logical === canonical) continue;
                for (const grant of grants) {
                    // Translate only the selected portion. Restoring a whole
                    // global alias root would undo a narrower project ceiling.
                    if (permittedPath(grant, [canonical])) {
                        const suffix = relative(canonical, grant);
                        result.add(suffix ? join(logical, suffix) : logical);
                    }
                }
            }
        }
    }
    return [...result];
}
function mergeLayers(input: ShellPolicyInput): {
    config: PiSandboxConfig;
    mode: SandboxMode;
    requestedMode: SandboxMode;
} {
    const projectRoot = realpathSync(input.cwd);
    const global = canonicalLayer(input.global, projectRoot);
    const project = canonicalLayer(input.project, projectRoot);
    const session = canonicalLayer(input.session, projectRoot);
    const globalNetwork = global?.network ?? {};
    const projectNetwork = project?.network ?? {};
    const sessionNetwork = session?.network ?? {};
    const globalFs = global?.filesystem ?? {};
    const projectFs = project?.filesystem ?? {};
    const sessionFs = session?.filesystem ?? {};
    const baseline = input.baseline ?? input.config;
    if (!baseline) throw new Error("A baseline sandbox policy is required");
    const installations = selectInstallations(
        global?.environment?.installations,
        project?.environment?.installations,
        session?.environment?.installations,
    );
    const installationReadGrants = installations.flatMap((installation) =>
        installation.roots.flatMap(installationReadPaths),
    );
    const allowedDomains = narrower(
        narrower(
            list(
                projectNetwork.allowedDomains,
                "project network.allowedDomains",
            ),
            list(
                globalNetwork.allowedDomains,
                "global network.allowedDomains",
            ) ?? baseline.network.allowedDomains,
        ),
        list(sessionNetwork.allowedDomains, "session network.allowedDomains") ??
            list(
                projectNetwork.allowedDomains,
                "project network.allowedDomains",
            ) ??
            list(
                globalNetwork.allowedDomains,
                "global network.allowedDomains",
            ) ??
            baseline.network.allowedDomains,
    );
    const allowedHostDomains = narrower(
        narrower(
            list(
                projectNetwork.allowedHostDomains,
                "project network.allowedHostDomains",
            ),
            list(
                globalNetwork.allowedHostDomains,
                "global network.allowedHostDomains",
            ) ?? baseline.network.allowedHostDomains,
        ),
        list(
            sessionNetwork.allowedHostDomains,
            "session network.allowedHostDomains",
        ) ??
            list(
                projectNetwork.allowedHostDomains,
                "project network.allowedHostDomains",
            ) ??
            list(
                globalNetwork.allowedHostDomains,
                "global network.allowedHostDomains",
            ) ??
            baseline.network.allowedHostDomains,
    );
    const globalLocalBinding =
        boolean(
            globalNetwork.allowLocalBinding,
            "global network.allowLocalBinding",
        ) ?? baseline.network.allowLocalBinding;
    const projectLocalBinding = restrictBoolean(
        boolean(
            projectNetwork.allowLocalBinding,
            "project network.allowLocalBinding",
        ),
        globalLocalBinding,
        "project network.allowLocalBinding",
    );
    const allowLocalBinding = restrictBoolean(
        boolean(
            sessionNetwork.allowLocalBinding,
            "session network.allowLocalBinding",
        ),
        projectLocalBinding,
        "session network.allowLocalBinding",
    );
    const baselineRead = [
        projectRoot,
        ...baseline.filesystem.allowRead.map((path) =>
            canonicalProjectPath(path, projectRoot),
        ),
    ];
    const baselineWrite = baseline.filesystem.allowWrite.map((path) =>
        canonicalProjectPath(path, projectRoot),
    );
    const requestedGlobalRead = list(
        globalFs.allowRead,
        "global filesystem.allowRead",
    );
    const requestedGlobalWrite = list(
        globalFs.allowWrite,
        "global filesystem.allowWrite",
    );
    // An omitted ceiling keeps the project baseline. An explicit empty list is
    // the only way to close it; non-empty grants retain the project itself.
    const ordinaryGlobalRead =
        requestedGlobalRead === undefined
            ? baselineRead
            : requestedGlobalRead.length === 0
              ? []
              : [...new Set([projectRoot, ...requestedGlobalRead])];
    const globalRead = [
        ...new Set([...ordinaryGlobalRead, ...installationReadGrants]),
    ];
    const globalWrite =
        requestedGlobalWrite === undefined
            ? baselineWrite
            : requestedGlobalWrite.length === 0
              ? []
              : [...new Set([projectRoot, ...requestedGlobalWrite])];
    const projectRead = narrowerPaths(
        list(projectFs.allowRead, "project filesystem.allowRead"),
        globalRead,
        {
            name: "filesystem.allowRead",
            configPath: join(projectRoot, ".pi", "sandbox.json"),
            authorityPath: input.authorityPath,
        },
    );
    const projectWrite = narrowerPaths(
        list(projectFs.allowWrite, "project filesystem.allowWrite"),
        globalWrite,
        {
            name: "filesystem.allowWrite",
            configPath: join(projectRoot, ".pi", "sandbox.json"),
            authorityPath: input.authorityPath,
        },
    );
    const read = narrowerPaths(
        list(sessionFs.allowRead, "session filesystem.allowRead"),
        projectRead,
    );
    const write = narrowerPaths(
        list(sessionFs.allowWrite, "session filesystem.allowWrite"),
        projectWrite,
    );
    if (project?.host !== undefined || session?.host !== undefined)
        throw new Error("host.allowed is reserved to the global sandbox.json");
    const hostAllowed = global?.host?.allowed ?? global?.mode === "host";
    if (project?.mode === "host")
        throw new Error(
            "Host mode requires an explicit current-session selection",
        );
    const requestedMode = session?.mode ?? project?.mode ?? "sandbox";
    if (requestedMode === "host" && !hostAllowed)
        throw new Error(
            "Host mode is outside the global ceiling: set host.allowed in the global sandbox.json to authorize it",
        );
    const tmpGlobal = global?.tmpNamespace ?? "lease-private";
    const tmpProject = project?.tmpNamespace ?? tmpGlobal;
    const tmp = session?.tmpNamespace ?? tmpProject;
    if (tmp === "host" && tmpGlobal !== "host")
        throw new Error(
            "Project requested host temporary files outside the global ceiling",
        );
    const globalEnvironment = global?.environment ?? {};
    const projectEnvironment = project?.environment ?? {};
    const sessionEnvironment = session?.environment ?? {};
    const resourceField = <T extends "unixSockets" | "tcpPublications">(
        layer: SandboxConfigLayer | undefined,
        field: T,
    ) =>
        layer?.resources !== undefined &&
        Object.hasOwn(layer.resources as Record<string, unknown>, field)
            ? normalizeSandboxResources(layer.resources)[field]
            : undefined;
    const globalResources =
        global?.resources === undefined
            ? (baseline.resources ?? { unixSockets: [], tcpPublications: [] })
            : {
                  unixSockets:
                      resourceField(global, "unixSockets") ??
                      baseline.resources?.unixSockets ??
                      [],
                  tcpPublications:
                      resourceField(global, "tcpPublications") ??
                      baseline.resources?.tcpPublications ??
                      [],
              };
    const projectResources = restrictedExact(
        resourceField(project, "unixSockets"),
        globalResources.unixSockets,
        (entry) => entry,
        "project resources.unixSockets",
    );
    const unixSockets = restrictedExact(
        resourceField(session, "unixSockets"),
        projectResources,
        (entry) => entry,
        "session resources.unixSockets",
    );
    const publicationKey = (
        entry: (typeof globalResources.tcpPublications)[number],
    ) => `${entry.transport}\0${entry.scope}\0${entry.listen}\0${entry.target}`;
    const projectPublications = restrictedExact(
        resourceField(project, "tcpPublications"),
        globalResources.tcpPublications,
        publicationKey,
        "project resources.tcpPublications",
    );
    const tcpPublications = restrictedExact(
        resourceField(session, "tcpPublications"),
        projectPublications,
        publicationKey,
        "session resources.tcpPublications",
    );
    const dockerSocketPaths = [
        DEFAULT_DOCKER_ENDPOINT,
        baseline.docker.mode === "disabled"
            ? undefined
            : baseline.docker.endpoint,
        global?.docker && typeof global.docker === "object"
            ? (global.docker as Record<string, unknown>).endpoint
            : undefined,
    ]
        .filter((endpoint): endpoint is string => typeof endpoint === "string")
        .filter((endpoint) => endpoint.startsWith("unix:///"))
        .map((endpoint) =>
            canonicalPotentialPath(endpoint.slice("unix://".length)),
        );
    const dockerIdentities = dockerSocketPaths.flatMap((path) => {
        try {
            const stat = lstatSync(path);
            return [`${stat.dev}:${stat.ino}`];
        } catch {
            return [];
        }
    });
    for (const socket of unixSockets) {
        const canonical = canonicalPotentialPath(socket);
        let identity: string | undefined;
        try {
            const stat = lstatSync(canonical);
            identity = `${stat.dev}:${stat.ino}`;
        } catch {
            // A missing socket still compares canonically against known paths.
        }
        if (
            dockerSocketPaths.includes(canonical) ||
            (identity !== undefined && dockerIdentities.includes(identity))
        )
            throw new Error(
                "Raw Docker daemon sockets are reserved for the Docker broker",
            );
    }
    const envPath =
        list(globalEnvironment.path, "global environment.path") ??
        baseline.environment.path;
    const projectPath = narrower(
        list(projectEnvironment.path, "project environment.path"),
        envPath,
    );
    const ordinaryPath = narrower(
        list(sessionEnvironment.path, "session environment.path"),
        projectPath,
    );
    const path = [
        ...new Set([
            ...installations.flatMap((installation) =>
                installation.roots.flatMap((entry) =>
                    entry.path
                        .map((part) => resolve(entry.root, part))
                        .filter(
                            (directory) =>
                                permittedPath(directory, [...read, ...write]) ||
                                (entry.files !== undefined &&
                                    installationReadPaths(entry).some(
                                        (file) =>
                                            installationContains(
                                                directory,
                                                file,
                                            ) &&
                                            permittedPath(file, [
                                                ...read,
                                                ...write,
                                            ]),
                                    )),
                        ),
                ),
            ),
            ...ordinaryPath,
        ]),
    ];
    const globalAllowedVariables =
        list(
            globalEnvironment.allowedVariables,
            "global environment.allowedVariables",
        ) ?? baseline.environment.allowedVariables;
    const projectAllowedVariables = restrictedList(
        list(
            projectEnvironment.allowedVariables,
            "project environment.allowedVariables",
        ),
        globalAllowedVariables,
        "project environment.allowedVariables",
    );
    const allowedVariables = restrictedList(
        list(
            sessionEnvironment.allowedVariables,
            "session environment.allowedVariables",
        ),
        projectAllowedVariables,
        "session environment.allowedVariables",
    );
    const deniedVariables = [
        ...new Set([
            ...baseline.environment.deniedVariables,
            ...(list(
                globalEnvironment.deniedVariables,
                "global environment.deniedVariables",
            ) ?? []),
            ...(list(
                projectEnvironment.deniedVariables,
                "project environment.deniedVariables",
            ) ?? []),
            ...(list(
                sessionEnvironment.deniedVariables,
                "session environment.deniedVariables",
            ) ?? []),
        ]),
    ];
    const globalVariables =
        variables(
            globalEnvironment.variables,
            "global environment.variables",
        ) ?? baseline.environment.variables;
    const projectVariables = restrictedVariables(
        variables(
            projectEnvironment.variables,
            "project environment.variables",
        ),
        globalVariables,
        "project environment.variables",
    );
    const configuredVariables = restrictedVariables(
        variables(
            sessionEnvironment.variables,
            "session environment.variables",
        ),
        projectVariables,
        "session environment.variables",
    );
    const deny = (field: "denyRead" | "denyWrite") => [
        ...new Set([
            ...baseline.filesystem[field],
            ...(list(globalFs[field], `global filesystem.${field}`) ?? []),
            ...(list(projectFs[field], `project filesystem.${field}`) ?? []),
            ...(list(sessionFs[field], `session filesystem.${field}`) ?? []),
        ]),
    ];
    const deniedDomains = [
        ...new Set([
            ...baseline.network.deniedDomains,
            ...(list(
                globalNetwork.deniedDomains,
                "global network.deniedDomains",
            ) ?? []),
            ...(list(
                projectNetwork.deniedDomains,
                "project network.deniedDomains",
            ) ?? []),
            ...(list(
                sessionNetwork.deniedDomains,
                "session network.deniedDomains",
            ) ?? []),
        ]),
    ];
    const config: PiSandboxConfig = {
        ...baseline,
        enabled: true,
        tmpNamespace: tmp,
        network: {
            ...baseline.network,
            allowLocalBinding,
            allowedDomains: allowedDomains.filter(
                (d) => !deniedDomains.includes(d),
            ),
            allowedHostDomains,
            deniedDomains,
        },
        filesystem: {
            ...baseline.filesystem,
            allowRead: preserveAuthorizedReadAliases(
                read,
                [input.global, input.project, input.session],
                projectRoot,
            ),
            allowWrite: write,
            denyRead: deny("denyRead"),
            // Installation grants are read-only, including beneath a writable project.
            denyWrite: [
                ...new Set([...deny("denyWrite"), ...installationReadGrants]),
            ],
        },
        environment: {
            ...baseline.environment,
            allowedVariables,
            deniedVariables,
            variables: configuredVariables,
            path,
            ...(installations.length ? { installations } : {}),
        },
        resources: { unixSockets, tcpPublications },
    };
    return { config, mode: requestedMode, requestedMode };
}
export function resolveShellPolicy(input: ShellPolicyInput): {
    config: PiSandboxConfig;
    shell: ShellCapabilityResolution;
} {
    const { config, mode, requestedMode } = mergeLayers(input);
    const baselineConfig = mergeLayers({
        ...input,
        global: undefined,
        project: undefined,
        session: undefined,
    }).config;
    const custom =
        mode === "sandbox" && normalized(config) !== normalized(baselineConfig);
    const profile: ShellProfile =
        mode === "host" ? "host" : custom ? "custom" : "default";
    const grants = {
        domains: config.network.allowedDomains,
        hostDomains: config.network.allowedHostDomains,
        readPaths: config.filesystem.allowRead,
        writePaths: config.filesystem.allowWrite,
        hostTmp: config.tmpNamespace === "host",
    };
    return {
        config,
        shell: {
            hostAllowed:
                input.global?.host?.allowed ?? input.global?.mode === "host",
            ...(input.global?.mode !== undefined
                ? {
                      diagnostic:
                          "Deprecated global mode field: use host.allowed for authorization; select the session mode with /sandbox mode. Explicit host.allowed takes precedence.",
                  }
                : {}),
            state: "ready",
            projectRoot: realpathSync(input.cwd),
            mode,
            requestedMode,
            profile,
            requestedProfile: profile,
            grants,
            requestedGrants: grants,
            authorityPath: input.authorityPath,
            sandboxFingerprint: shellSandboxFingerprint(config),
        },
    };
}
function normalized(value: unknown): string {
    const sort = (current: unknown): unknown => {
        if (Array.isArray(current)) {
            const entries: unknown[] = current;
            return entries
                .toSorted((left, right) => {
                    const a = String(left);
                    const b = String(right);
                    return a < b ? -1 : a > b ? 1 : 0;
                })
                .map(sort);
        }
        if (typeof current === "object" && current !== null) {
            return Object.fromEntries(
                Object.entries(current as Record<string, unknown>)
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([key, entry]) => [key, sort(entry)]),
            );
        }
        return current;
    };
    return JSON.stringify(sort(value));
}
export function shellSandboxFingerprint(config: PiSandboxConfig): string {
    return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
