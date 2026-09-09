import { dirname } from "node:path";

import { summarizeDockerAccess } from "../../sandbox/docker-presentation.ts";
import type {
    SandboxLeasePaths,
    SandboxPolicy,
    SandboxProfileName,
} from "../../sandbox/runtime/contracts.ts";
import type { ExecutionProvenance } from "../execution-provenance/types.ts";
import type { DockerAccessSummary } from "./docker-summary.ts";

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

export type SandboxModelContextState =
    | "enabled"
    | "disabled"
    | "reconfiguring"
    | "error";

export interface SandboxModelContextSnapshotV1 {
    version: 1;
    state: SandboxModelContextState;
    profiles?: SandboxProfileContextsV1;
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
    records: Map<string, SandboxExecutionContextV1>;
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

export function parseSandboxExecutionContext(
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

export function recordSandboxExecutionContext(
    id: string,
    context: SandboxExecutionContextV1,
): void {
    contextRegistry().records.set(id, structuredClone(context));
}

export function clearSandboxExecutionContexts(): void {
    contextRegistry().records.clear();
}

export function sandboxExecutionContextFromDetails(
    details: unknown,
): SandboxExecutionContextV1 | undefined {
    const record = recordValue(details);
    return parseSandboxExecutionContext(record?.sandboxExecutionContext);
}

export function resolveSandboxExecutionContext(
    id: string,
    details?: unknown,
): SandboxExecutionContextV1 | undefined {
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
    context: SandboxExecutionContextV1 | undefined,
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
): SandboxExecutionContextV1 | undefined {
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

/** Build model-visible facts from the exact policy passed to the backend. */
export function createSandboxExecutionContext(
    policy: SandboxPolicy,
    lease: SandboxLeasePaths,
    options: SandboxExecutionContextOptions,
): SandboxExecutionContextV1 {
    const hostBridgePorts = explicitLoopbackPorts(policy);
    return {
        version: 1,
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
            loopback: {
                hostNamespace: "isolated",
                hostBridgePorts,
                hostBridgeTransport:
                    hostBridgePorts.length > 0
                        ? "managed-policy-proxy"
                        : "disabled",
                unlistedHostPorts: "blocked",
                localListeners:
                    policy.network.allowLocalBinding === true
                        ? "sandbox-only"
                        : "disabled",
            },
        },
        tmp: { path: "/tmp", namespace: policy.tmpNamespace },
        ipc: {
            hostUserDbus: "unavailable",
            hostUnixSockets: "unavailable",
        },
        docker: summarizeDockerAccess(policy.docker, options.nowMs),
        environment: {
            inherit: [...policy.environment.inherit],
            set: Object.keys(policy.environment.set).toSorted(),
            deny: [...policy.environment.deny],
        },
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
                : "The listed profile rules are the effective OS sandbox boundaries.";
    return [
        CONTEXT_START,
        "Sandbox execution context v1",
        stateFact,
        "Treat these as environment facts, not a causal diagnosis of any command failure.",
        "network.domainClientProxyRequired applies to allow/allowHost. loopback.hostBridgePorts accept raw TCP only through the managed policy proxy; unlisted host loopback ports are blocked.",
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
