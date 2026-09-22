import { dirname } from "node:path";

import type { ExecutionProvenance } from "../execution-provenance/types.ts";
import type {
    SandboxAdmission,
    SandboxAdmissionReport,
} from "./admission-protocol.ts";
import {
    summarizeDockerAccess,
    type DockerAccessSummary,
} from "./docker-summary.ts";
import type {
    SandboxLeasePaths,
    SandboxPolicy,
    SandboxProfileName,
    SandboxTcpPublication,
} from "./policy-contracts.ts";

export interface SandboxExecutionContextV1 {
    version: 1;
    profile: SandboxProfileName;
    filesystem: {
        allowRead: string[];
        denyRead: string[];
        denyReadGlobs: string[];
        allowWrite: string[];
        denyWrite: string[];
        denyWriteGlobs: string[];
    };
    network: {
        mode: "deny-all" | "domain-allowlist";
        allow: string[];
        allowHost: string[];
        deny: string[];
        domainClientProxyRequired: boolean;
        loopback: {
            hostNamespace: "isolated";
            hostBridgePorts: number[];
            hostBridgeTransport: "managed-policy-proxy" | "disabled";
            unlistedHostPorts: "blocked";
            localListeners: "sandbox-only" | "disabled";
        };
    };
    tmp: {
        path: "/tmp";
        namespace: "host" | "lease-private";
    };
    ipc: {
        hostUserDbus: "unavailable";
        hostUnixSockets: "unavailable";
    };
    docker: DockerAccessSummary;
    environment: {
        inherit: string[];
        set: string[];
        deny: string[];
    };
}

export interface SandboxExecutionContextV2 extends Omit<
    SandboxExecutionContextV1,
    "version" | "network" | "ipc" | "environment"
> {
    version: 2;
    home: { path: string; namespace: "lease-private" };
    network: Omit<SandboxExecutionContextV1["network"], "loopback"> & {
        mediatedDirectTcp?: { ports: number[] };
        loopback: Omit<
            SandboxExecutionContextV1["network"]["loopback"],
            "localListeners"
        > & {
            localListeners: "sandbox-only" | "published" | "disabled";
            publications: SandboxTcpPublication[];
        };
    };
    ipc: { hostUserDbus: "not-inherited"; hostUnixSockets: string[] };
    environment: SandboxExecutionContextV1["environment"] & { path: string[] };
}

export interface SandboxExecutionContextV3 extends Omit<
    SandboxExecutionContextV2,
    "version"
> {
    version: 3;
    admission: "admitted";
    admissionSha256: string;
    runtime: SandboxAdmissionReport["runtime"];
    helperSha256: string;
    mounts: SandboxAdmissionReport["mounts"];
    pathAliases?: SandboxAdmissionReport["pathAliases"];
    kernelMounts: SandboxAdmissionReport["kernelMounts"];
}

export type SandboxExecutionContext =
    | SandboxExecutionContextV1
    | SandboxExecutionContextV2
    | SandboxExecutionContextV3;
export type SandboxProfileContexts = Record<
    SandboxProfileName,
    SandboxExecutionContext
>;

export type SandboxModelContextState =
    | "enabled"
    | "disabled"
    | "reconfiguring"
    | "error";

export interface SandboxModelContextSnapshotV1 {
    version: 1;
    state: SandboxModelContextState;
    profiles?: SandboxProfileContexts;
}

export type SandboxProfileContextsV1 = Record<
    SandboxProfileName,
    SandboxExecutionContextV1
>;

export interface SandboxExecutionContextOptions {
    homeDir: string;
    nowMs?: number;
}

const CONTEXT_START = "<!-- pi:sandbox-execution-context:v1:start -->";
const CONTEXT_END = "<!-- pi:sandbox-execution-context:v1:end -->";
const REGISTRY_KEY = Symbol.for("pi.sandbox-execution-context.v1");

interface SandboxExecutionContextRegistry {
    records: Map<string, SandboxExecutionContext>;
}

function contextRegistry(): SandboxExecutionContextRegistry {
    const globals = globalThis as typeof globalThis & {
        [REGISTRY_KEY]?: SandboxExecutionContextRegistry;
    };
    return (globals[REGISTRY_KEY] ??= { records: new Map() });
}

function stringArray(value: unknown): value is string[] {
    return (
        Array.isArray(value) && value.every((item) => typeof item === "string")
    );
}

function portArray(value: unknown): value is number[] {
    return (
        Array.isArray(value) &&
        value.every(
            (item) =>
                typeof item === "number" &&
                Number.isInteger(item) &&
                item > 0 &&
                item <= 65_535,
        )
    );
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function parseDockerSummary(value: unknown): DockerAccessSummary | undefined {
    const docker = recordValue(value);
    if (!docker || !["off", "targeted", "full"].includes(String(docker.mode)))
        return;
    if (
        typeof docker.profile !== "string" ||
        typeof docker.hostAccessException !== "boolean" ||
        !Array.isArray(docker.targets)
    )
        return;
    const targets: DockerAccessSummary["targets"] = [];
    for (const value of docker.targets) {
        const target = recordValue(value);
        if (
            !target ||
            typeof target.selector !== "string" ||
            typeof target.profile !== "string" ||
            !stringArray(target.operations) ||
            typeof target.hostAccessException !== "boolean"
        )
            return;
        targets.push({
            selector: target.selector,
            profile: target.profile,
            operations: [...target.operations],
            hostAccessException: target.hostAccessException,
            ...(typeof target.requestedProfile === "string"
                ? { requestedProfile: target.requestedProfile }
                : {}),
            ...(stringArray(target.requestedOperations)
                ? { requestedOperations: [...target.requestedOperations] }
                : {}),
            ...(typeof target.boundedInspection === "boolean"
                ? { boundedInspection: target.boundedInspection }
                : {}),
        });
    }
    const breakGlass = Array.isArray(docker.breakGlass)
        ? docker.breakGlass.flatMap((value) => {
              const entry = recordValue(value);
              return entry &&
                  typeof entry.containerId === "string" &&
                  typeof entry.expiresAtMs === "number"
                  ? [
                        {
                            containerId: entry.containerId,
                            expiresAtMs: entry.expiresAtMs,
                        },
                    ]
                  : [];
          })
        : undefined;
    if (
        Array.isArray(docker.breakGlass) &&
        breakGlass?.length !== docker.breakGlass.length
    )
        return;
    return {
        mode: docker.mode as DockerAccessSummary["mode"],
        profile: docker.profile,
        targets,
        hostAccessException: docker.hostAccessException,
        ...(typeof docker.boundedInspection === "boolean"
            ? { boundedInspection: docker.boundedInspection }
            : {}),
        ...(breakGlass ? { breakGlass } : {}),
    };
}

function parseLegacySandboxExecutionContext(
    value: unknown,
): SandboxExecutionContextV1 | undefined {
    const context = recordValue(value);
    const filesystem = recordValue(context?.filesystem);
    const network = recordValue(context?.network);
    const loopback = recordValue(network?.loopback);
    const tmp = recordValue(context?.tmp);
    const ipc = recordValue(context?.ipc);
    const environment = recordValue(context?.environment);
    const docker = parseDockerSummary(context?.docker);
    const filesystemKeys = [
        "allowRead",
        "denyRead",
        "denyReadGlobs",
        "allowWrite",
        "denyWrite",
        "denyWriteGlobs",
    ] as const;
    if (
        context?.version !== 1 ||
        !["bash-general", "think-strict", "analysis-strict"].includes(
            String(context?.profile),
        ) ||
        !filesystem ||
        !filesystemKeys.every((key) => stringArray(filesystem[key])) ||
        !network ||
        !["deny-all", "domain-allowlist"].includes(String(network.mode)) ||
        !stringArray(network.allow) ||
        !stringArray(network.allowHost) ||
        !stringArray(network.deny) ||
        typeof network.domainClientProxyRequired !== "boolean" ||
        !loopback ||
        loopback.hostNamespace !== "isolated" ||
        !portArray(loopback.hostBridgePorts) ||
        !["managed-policy-proxy", "disabled"].includes(
            String(loopback.hostBridgeTransport),
        ) ||
        loopback.unlistedHostPorts !== "blocked" ||
        !["sandbox-only", "disabled"].includes(
            String(loopback.localListeners),
        ) ||
        !tmp ||
        tmp.path !== "/tmp" ||
        !["host", "lease-private"].includes(String(tmp.namespace)) ||
        !ipc ||
        ipc.hostUserDbus !== "unavailable" ||
        ipc.hostUnixSockets !== "unavailable" ||
        !docker ||
        !environment ||
        !stringArray(environment.inherit) ||
        !stringArray(environment.set) ||
        !stringArray(environment.deny)
    )
        return;
    return {
        version: 1,
        profile: context.profile as SandboxProfileName,
        filesystem: Object.fromEntries(
            filesystemKeys.map((key) => [
                key,
                [...(filesystem[key] as string[])],
            ]),
        ) as SandboxExecutionContextV1["filesystem"],
        network: {
            mode: network.mode as SandboxExecutionContextV1["network"]["mode"],
            allow: [...network.allow],
            allowHost: [...network.allowHost],
            deny: [...network.deny],
            domainClientProxyRequired: network.domainClientProxyRequired,
            loopback: {
                hostNamespace: "isolated",
                hostBridgePorts: [...loopback.hostBridgePorts],
                hostBridgeTransport:
                    loopback.hostBridgeTransport as SandboxExecutionContextV1["network"]["loopback"]["hostBridgeTransport"],
                unlistedHostPorts: "blocked",
                localListeners:
                    loopback.localListeners as SandboxExecutionContextV1["network"]["loopback"]["localListeners"],
            },
        },
        tmp: {
            path: "/tmp",
            namespace:
                tmp.namespace as SandboxExecutionContextV1["tmp"]["namespace"],
        },
        ipc: {
            hostUserDbus: "unavailable",
            hostUnixSockets: "unavailable",
        },
        docker,
        environment: {
            inherit: [...environment.inherit],
            set: [...environment.set],
            deny: [...environment.deny],
        },
    };
}

export function parseSandboxExecutionContext(
    // oxlint-disable-next-line typescript/no-restricted-types -- Persisted context records require validation at the JSON boundary.
    value: unknown,
): SandboxExecutionContext | undefined {
    const context = recordValue(value);
    if (context?.version === 3) {
        const base = parseSandboxExecutionContext({ ...context, version: 2 });
        const runtime = recordValue(context.runtime);
        const digest = (value: unknown): value is string =>
            typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
        if (
            !base ||
            base.version !== 2 ||
            context.admission !== "admitted" ||
            !digest(context.admissionSha256) ||
            !digest(context.helperSha256) ||
            !runtime ||
            runtime.target !== "x86_64-unknown-linux-gnu" ||
            typeof runtime.version !== "string" ||
            !runtime.version ||
            !digest(runtime.manifestSha256) ||
            (runtime.component !== "shell" &&
                runtime.component !== "analysis") ||
            !Array.isArray(context.mounts)
        )
            return;
        const mounts: SandboxAdmissionReport["mounts"] = [];
        for (const entry of context.mounts) {
            const mount = recordValue(entry);
            if (
                !mount ||
                typeof mount.source !== "string" ||
                typeof mount.destination !== "string" ||
                (mount.access !== "ro" && mount.access !== "rw") ||
                (mount.origin !== "runtime" &&
                    mount.origin !== "policy" &&
                    mount.origin !== "internal")
            )
                return;
            mounts.push({
                source: mount.source,
                destination: mount.destination,
                access: mount.access,
                origin: mount.origin,
            });
        }
        const pathAliases: NonNullable<SandboxAdmissionReport["pathAliases"]> =
            [];
        if (context.pathAliases !== undefined) {
            if (!Array.isArray(context.pathAliases)) return;
            for (const entry of context.pathAliases) {
                const alias = recordValue(entry);
                if (
                    !alias ||
                    typeof alias.destination !== "string" ||
                    typeof alias.target !== "string" ||
                    typeof alias.directory !== "boolean"
                )
                    return;
                pathAliases.push({
                    destination: alias.destination,
                    target: alias.target,
                    directory: alias.directory,
                });
            }
        }
        if (!Array.isArray(context.kernelMounts)) return;
        const kernelMounts: SandboxAdmissionReport["kernelMounts"] = [];
        for (const entry of context.kernelMounts) {
            const mount = recordValue(entry);
            if (
                !mount ||
                typeof mount.destination !== "string" ||
                typeof mount.root !== "string" ||
                typeof mount.source !== "string" ||
                typeof mount.filesystem !== "string" ||
                (mount.access !== "ro" && mount.access !== "rw")
            )
                return;
            kernelMounts.push({
                destination: mount.destination,
                root: mount.root,
                source: mount.source,
                filesystem: mount.filesystem,
                access: mount.access,
            });
        }
        return {
            ...base,
            version: 3,
            admission: "admitted",
            admissionSha256: context.admissionSha256,
            helperSha256: context.helperSha256,
            runtime: {
                target: runtime.target,
                version: runtime.version,
                manifestSha256: runtime.manifestSha256,
                component: runtime.component,
            },
            mounts,
            kernelMounts,
            ...(context.pathAliases === undefined ? {} : { pathAliases }),
        };
    }
    if (context?.version === 1)
        return parseLegacySandboxExecutionContext(value);
    if (context?.version !== 2) return undefined;
    const home = recordValue(context.home);
    const network = recordValue(context.network);
    const loopback = recordValue(network?.loopback);
    const mediatedDirectTcp = recordValue(network?.mediatedDirectTcp);
    const ipc = recordValue(context.ipc);
    const environment = recordValue(context.environment);
    if (
        !home ||
        home.namespace !== "lease-private" ||
        typeof home.path !== "string" ||
        !home.path ||
        !network ||
        (network.mediatedDirectTcp !== undefined &&
            (!mediatedDirectTcp ||
                Object.keys(mediatedDirectTcp).some((key) => key !== "ports") ||
                !portArray(mediatedDirectTcp.ports) ||
                mediatedDirectTcp.ports.length === 0 ||
                mediatedDirectTcp.ports.length > 64 ||
                mediatedDirectTcp.ports.some(
                    (port, index, ports) =>
                        index > 0 && port <= ports[index - 1]!,
                ))) ||
        !loopback ||
        !["sandbox-only", "published", "disabled"].includes(
            String(loopback.localListeners),
        ) ||
        !Array.isArray(loopback.publications) ||
        !ipc ||
        ipc.hostUserDbus !== "not-inherited" ||
        !stringArray(ipc.hostUnixSockets) ||
        !environment ||
        !stringArray(environment.path)
    )
        return undefined;
    const publications: SandboxTcpPublication[] = [];
    for (const entry of loopback.publications) {
        const publication = recordValue(entry);
        if (
            !publication ||
            publication.transport !== "tcp" ||
            (publication.scope !== "host" && publication.scope !== "lan") ||
            typeof publication.listen !== "string" ||
            !publication.listen ||
            typeof publication.target !== "string" ||
            !publication.target
        )
            return undefined;
        publications.push({
            transport: "tcp",
            scope: publication.scope,
            listen: publication.listen,
            target: publication.target,
        });
    }
    if ((loopback.localListeners === "published") !== publications.length > 0)
        return undefined;
    // Validate the unchanged fields through the legacy decoder; never infer new grants from v1 records.
    const base = parseLegacySandboxExecutionContext({
        ...context,
        version: 1,
        network: {
            ...network,
            loopback: {
                ...loopback,
                localListeners:
                    loopback.localListeners === "published"
                        ? "sandbox-only"
                        : loopback.localListeners,
            },
        },
        ipc: { hostUserDbus: "unavailable", hostUnixSockets: "unavailable" },
    });
    if (!base) return undefined;
    return {
        ...base,
        version: 2,
        home: { path: home.path, namespace: "lease-private" },
        network: {
            ...base.network,
            ...(mediatedDirectTcp
                ? {
                      mediatedDirectTcp: {
                          ports: [...(mediatedDirectTcp.ports as number[])],
                      },
                  }
                : {}),
            loopback: {
                ...base.network.loopback,
                localListeners: publications.length
                    ? "published"
                    : base.network.loopback.localListeners,
                publications,
            },
        },
        ipc: {
            hostUserDbus: "not-inherited",
            hostUnixSockets: [...ipc.hostUnixSockets],
        },
        environment: { ...base.environment, path: [...environment.path] },
    };
}

export function recordSandboxExecutionContext(
    id: string,
    context: SandboxExecutionContext,
): void {
    contextRegistry().records.set(id, structuredClone(context));
}

export function clearSandboxExecutionContexts(): void {
    contextRegistry().records.clear();
}

export function sandboxExecutionContextFromDetails(
    details: unknown,
): SandboxExecutionContext | undefined {
    const record = recordValue(details);
    return parseSandboxExecutionContext(record?.sandboxExecutionContext);
}

export function resolveSandboxExecutionContext(
    id: string,
    details?: unknown,
): SandboxExecutionContext | undefined {
    return (
        sandboxExecutionContextFromDetails(details) ??
        contextRegistry().records.get(id)
    );
}

export function mergeSandboxContextForFailure(
    id: string,
    details: unknown,
    execution: ExecutionProvenance,
    isError: boolean,
): unknown {
    if (!isError || execution.status !== "sandboxed") return details;
    const context = resolveSandboxExecutionContext(id, details);
    if (!context) return details;
    return {
        ...(recordValue(details) ??
            (details === undefined ? {} : { originalDetails: details })),
        sandboxExecutionContext: structuredClone(context),
    };
}

export function withSandboxExecutionContext(
    error: unknown,
    context: SandboxExecutionContext | undefined,
): Error {
    const result = error instanceof Error ? error : new Error(String(error));
    if (context) {
        Object.defineProperty(result, "sandboxExecutionContext", {
            configurable: true,
            value: structuredClone(context),
        });
    }
    return result;
}

export function sandboxExecutionContextFromError(
    error: unknown,
): SandboxExecutionContext | undefined {
    if (typeof error !== "object" || error === null) return;
    return parseSandboxExecutionContext(
        Reflect.get(error, "sandboxExecutionContext"),
    );
}

function replacePathPrefix(
    path: string,
    prefix: string,
    alias: string,
): string | undefined {
    if (path === prefix) return alias;
    if (prefix !== "/" && path.startsWith(`${prefix}/`)) {
        return `${alias}${path.slice(prefix.length)}`;
    }
    return undefined;
}

function aliasPath(
    path: string,
    lease: SandboxLeasePaths,
    homeDir: string,
): string {
    const aliases: Array<readonly [string, string]> = [
        [lease.proxyRunsDir, "<sandbox-proxy-runs>"],
        [lease.profilesDir, "<sandbox-profiles>"],
        [lease.zeroboxHome, "<zerobox-home>"],
        [lease.homeDir, "<sandbox-home>"],
        [lease.tmpDir, "<sandbox-tmp>"],
        [lease.root, "<sandbox-lease>"],
        [dirname(lease.root), "<sandbox-runtime>"],
        [homeDir, "~"],
    ];
    for (const [prefix, alias] of aliases) {
        const replaced = replacePathPrefix(path, prefix, alias);
        if (replaced !== undefined) return replaced;
    }
    return path;
}

function aliasPaths(
    paths: readonly string[],
    lease: SandboxLeasePaths,
    homeDir: string,
): string[] {
    return paths.map((path) => aliasPath(path, lease, homeDir));
}

function explicitLoopbackPorts(policy: SandboxPolicy): number[] {
    if (policy.network.allowLocalBinding !== true) return [];
    const ports = policy.network.allow.flatMap((rule) => {
        const match = /^(?:localhost|127\.0\.0\.1|\[::1]):(\d+)$/i.exec(
            rule.trim(),
        );
        if (!match) return [];
        const port = Number(match[1]);
        return Number.isInteger(port) && port > 0 && port <= 65_535
            ? [port]
            : [];
    });
    return [...new Set(ports)].toSorted((left, right) => left - right);
}

/** Describe planned policy. Only v3 reports prove that the engine admitted it. */
export function createSandboxExecutionContext(
    policy: SandboxPolicy,
    lease: SandboxLeasePaths,
    options: SandboxExecutionContextOptions,
): SandboxExecutionContextV2 {
    const hostBridgePorts = explicitLoopbackPorts(policy);
    return {
        version: 2,
        home: {
            path: aliasPath(
                policy.environment.set.HOME ?? lease.homeDir,
                lease,
                options.homeDir,
            ),
            namespace: "lease-private",
        },
        profile: policy.name,
        filesystem: {
            allowRead: aliasPaths(
                policy.filesystem.allowRead,
                lease,
                options.homeDir,
            ),
            denyRead: aliasPaths(
                policy.filesystem.denyRead,
                lease,
                options.homeDir,
            ),
            denyReadGlobs: aliasPaths(
                policy.filesystem.denyReadGlobs,
                lease,
                options.homeDir,
            ),
            allowWrite: aliasPaths(
                policy.filesystem.allowWrite,
                lease,
                options.homeDir,
            ),
            denyWrite: aliasPaths(
                policy.filesystem.denyWrite,
                lease,
                options.homeDir,
            ),
            denyWriteGlobs: aliasPaths(
                policy.filesystem.denyWriteGlobs,
                lease,
                options.homeDir,
            ),
        },
        network: {
            mode: policy.network.mode,
            allow: [...policy.network.allow],
            allowHost: [...policy.network.allowHost],
            deny: [...policy.network.deny],
            domainClientProxyRequired:
                policy.network.mode === "domain-allowlist",
            ...(policy.network.mediatedDirectTcp
                ? {
                      mediatedDirectTcp: {
                          ports: [...policy.network.mediatedDirectTcp.ports],
                      },
                  }
                : {}),
            loopback: {
                hostNamespace: "isolated",
                hostBridgePorts,
                hostBridgeTransport:
                    hostBridgePorts.length > 0
                        ? "managed-policy-proxy"
                        : "disabled",
                unlistedHostPorts: "blocked",
                localListeners: policy.resources?.tcpPublications.length
                    ? "published"
                    : policy.network.allowLocalBinding === true
                      ? "sandbox-only"
                      : "disabled",
                publications: (policy.resources?.tcpPublications ?? []).map(
                    (publication) => ({ ...publication }),
                ),
            },
        },
        tmp: { path: "/tmp", namespace: policy.tmpNamespace },
        ipc: {
            hostUserDbus: "not-inherited",
            hostUnixSockets: aliasPaths(
                policy.resources?.unixSockets ?? [],
                lease,
                options.homeDir,
            ),
        },
        docker: summarizeDockerAccess(policy.docker, options.nowMs),
        environment: {
            path: aliasPaths(
                (policy.environment.set.PATH ?? "").split(":").filter(Boolean),
                lease,
                options.homeDir,
            ),
            inherit: [...policy.environment.inherit],
            set: Object.keys(policy.environment.set).toSorted(),
            deny: [...policy.environment.deny],
        },
    };
}

export function createAdmittedSandboxExecutionContext(
    admission: SandboxAdmission,
    profile: SandboxProfileName,
    lease: SandboxLeasePaths,
    options: SandboxExecutionContextOptions,
): SandboxExecutionContextV3 {
    const report = admission.report;
    const base = createSandboxExecutionContext(
        {
            name: profile,
            strict: true,
            tmpNamespace: report.tmp.namespace,
            filesystem: report.filesystem,
            network: report.network,
            resources: report.resources,
            docker: report.docker,
            environment: {
                inherit: report.environment.inherit,
                deny: report.environment.deny,
                set: {
                    ...Object.fromEntries(
                        report.environment.set.map((name) => [name, ""]),
                    ),
                    HOME: report.home.path,
                    PATH: report.path.join(":"),
                },
            },
        },
        lease,
        options,
    );
    return {
        ...base,
        version: 3,
        admission: "admitted",
        admissionSha256: admission.sha256,
        runtime: { ...report.runtime },
        helperSha256: report.helperSha256,
        mounts: report.mounts.map((mount) => ({
            ...mount,
            source: aliasPath(mount.source, lease, options.homeDir),
            destination: aliasPath(mount.destination, lease, options.homeDir),
        })),
        pathAliases: (report.pathAliases ?? []).map((alias) => ({
            ...alias,
            destination: aliasPath(alias.destination, lease, options.homeDir),
            target: aliasPath(alias.target, lease, options.homeDir),
        })),
        kernelMounts: report.kernelMounts.map((mount) => ({
            ...mount,
            destination: aliasPath(mount.destination, lease, options.homeDir),
            root: aliasPath(mount.root, lease, options.homeDir),
            source: aliasPath(mount.source, lease, options.homeDir),
        })),
    };
}

export function formatSandboxSystemContext(
    snapshot: SandboxModelContextSnapshotV1,
): string {
    const stateFact =
        snapshot.state === "disabled"
            ? "OS isolation is absent. safe_bash guards are independent and may still block commands before execution."
            : snapshot.state === "reconfiguring"
              ? "OS-isolated execution is temporarily unavailable while the runtime is reconfiguring."
              : snapshot.state === "error"
                ? "OS-isolated execution is unavailable because the runtime is in an error state."
                : "Version 3 entries describe engine-admitted permissions for their executions. Version 1/2 entries describe planned or historical policy, not proof of current mounts. A new command remains pending until engine admission succeeds.";
    return [
        CONTEXT_START,
        "Sandbox execution context v1",
        stateFact,
        "Treat these as environment facts, not a causal diagnosis of any command failure.",
        "network.domainClientProxyRequired applies to allow/allowHost. network.mediatedDirectTcp ports permit hostname-inspected direct TCP through the same domain policy. loopback.hostBridgePorts accept raw TCP only through the managed policy proxy; unlisted host loopback ports are blocked.",
        JSON.stringify(snapshot),
        CONTEXT_END,
    ].join("\n");
}

export function injectSandboxSystemContext(
    systemPrompt: string,
    snapshot: SandboxModelContextSnapshotV1,
): string {
    const start = systemPrompt.indexOf(CONTEXT_START);
    const end = systemPrompt.indexOf(CONTEXT_END);
    const base =
        start >= 0 && end >= start
            ? `${systemPrompt.slice(0, start)}${systemPrompt.slice(end + CONTEXT_END.length)}`.trimEnd()
            : systemPrompt.trimEnd();
    return `${base}\n\n${formatSandboxSystemContext(snapshot)}`;
}
