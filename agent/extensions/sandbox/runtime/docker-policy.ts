/* Global policy authorizes Docker. Projects activate it and select their targets. */
import {
    DOCKER_OPERATIONS,
    SandboxExecutionError,
    type DockerOperation,
    type DockerTargetGrant,
    type DockerTargetSelector,
    type SandboxDockerPolicy,
} from "./contracts.ts";

export const DEFAULT_DOCKER_ENDPOINT = "unix:///var/run/docker.sock";
export interface ResolveDockerPolicyOptions {
    globalConfig?: unknown;
    projectConfig?: unknown;
}
function invalid(message: string): never {
    throw new SandboxExecutionError("invalid-policy", {
        cause: new Error(message),
        diagnostic: message,
    });
}
function record(value: unknown, field: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        invalid(`${field} must be an object`);
    return value as Record<string, unknown>;
}
function known(
    value: Record<string, unknown>,
    fields: readonly string[],
    field: string,
): void {
    for (const key of Object.keys(value))
        if (!fields.includes(key)) invalid(`Unknown ${field} field`);
}
function string(value: unknown, field: string): string {
    if (
        typeof value !== "string" ||
        !value ||
        value.trim() !== value ||
        value.includes("\0")
    )
        invalid(`${field} must be a non-empty string`);
    return value;
}
function operations(value: unknown): DockerOperation[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value))
        invalid("Docker target operations must be an array");
    const parsed = value.map((operation) => {
        if (
            typeof operation !== "string" ||
            !DOCKER_OPERATIONS.includes(operation as DockerOperation)
        )
            invalid("Unknown Docker operation");
        return operation as DockerOperation;
    });
    if (new Set(parsed).size !== parsed.length)
        invalid("Duplicate Docker operation");
    return parsed;
}
function selector(value: unknown): DockerTargetSelector {
    const input = record(value, "Docker target selector");
    if (input.type === "container-name") {
        known(input, ["type", "name"], "container selector");
        return {
            type: "container-name",
            name: string(input.name, "selector.name"),
        };
    }
    if (input.type === "compose-service") {
        known(input, ["type", "project", "service"], "Compose selector");
        return {
            type: "compose-service",
            project: string(input.project, "selector.project"),
            service: string(input.service, "selector.service"),
        };
    }
    invalid("Unknown Docker target selector type");
}
function target(value: unknown): DockerTargetGrant {
    const input = record(value, "Docker target");
    known(
        input,
        ["selector", "operations", "allowUnsafeTarget"],
        "Docker target",
    );
    if (
        input.allowUnsafeTarget !== undefined &&
        typeof input.allowUnsafeTarget !== "boolean"
    )
        invalid("allowUnsafeTarget must be boolean");
    return {
        selector: selector(input.selector),
        operations: operations(input.operations),
        allowUnsafeTarget: input.allowUnsafeTarget === true,
    };
}
interface DockerCeiling {
    allowed: boolean;
    mode: "targeted" | "full";
    endpoint: string;
    operations?: DockerOperation[];
    unsafeTargets: DockerTargetSelector[];
}
function parseCeiling(value: unknown): DockerCeiling {
    const docker = record(value === undefined ? {} : value, "global docker");
    known(
        docker,
        ["allowed", "mode", "endpoint", "operations", "unsafeTargets"],
        "global docker",
    );
    if (docker.allowed !== undefined && typeof docker.allowed !== "boolean")
        invalid("global docker.allowed must be boolean");
    const mode = docker.mode ?? "targeted";
    if (mode !== "full" && mode !== "targeted")
        invalid("global docker.mode must be targeted or full");
    const endpoint =
        docker.endpoint === undefined
            ? DEFAULT_DOCKER_ENDPOINT
            : string(docker.endpoint, "Docker endpoint");
    if (!endpoint.startsWith("unix:///") || endpoint.includes("\0"))
        invalid("Docker endpoint must be a local Unix socket");
    const limits = operations(docker.operations);
    if (mode === "full" && limits !== undefined)
        invalid("Full Docker policy cannot limit operations");
    if (
        docker.unsafeTargets !== undefined &&
        !Array.isArray(docker.unsafeTargets)
    )
        invalid("global docker.unsafeTargets must be an array");
    const unsafeTargets = (
        Array.isArray(docker.unsafeTargets) ? docker.unsafeTargets : []
    ).map(selector);
    if (
        new Set(unsafeTargets.map(dockerSelectorKey)).size !==
        unsafeTargets.length
    )
        invalid("Duplicate unsafe Docker target");
    return {
        allowed: docker.allowed === true,
        mode,
        endpoint,
        operations: limits,
        unsafeTargets,
    };
}
function parseProject(value: unknown): {
    enabled: boolean;
    targets?: DockerTargetGrant[];
} {
    const project = record(value, "project docker");
    known(project, ["enabled", "targets"], "project docker");
    if (project.enabled !== undefined && typeof project.enabled !== "boolean")
        invalid("project docker.enabled must be boolean");
    const targets =
        project.targets === undefined
            ? undefined
            : (() => {
                  if (!Array.isArray(project.targets))
                      invalid("project docker.targets must be an array");
                  const parsed = project.targets.map((value) => {
                      if (
                          Object.hasOwn(
                              record(value, "Docker target"),
                              "allowUnsafeTarget",
                          )
                      ) {
                          invalid(
                              "Project cannot add a Docker unsafe exception",
                          );
                      }
                      return target(value);
                  });
                  if (
                      new Set(
                          parsed.map((item) =>
                              dockerSelectorKey(item.selector),
                          ),
                      ).size !== parsed.length
                  )
                      invalid("Duplicate Docker target");
                  return parsed;
              })();
    return { enabled: project.enabled === true, targets };
}
export function dockerSelectorKey(selector: DockerTargetSelector): string {
    if (selector.type === "container-name")
        return JSON.stringify([selector.type, selector.name]);
    if (selector.type === "compose-service")
        return JSON.stringify([
            selector.type,
            selector.project,
            selector.service,
        ]);
    return JSON.stringify([
        selector.type,
        selector.id,
        selector.unsafeExecExpiresAtMs,
    ]);
}
export function resolveDockerPolicy(
    options: ResolveDockerPolicyOptions,
): SandboxDockerPolicy {
    const ceiling = parseCeiling(options.globalConfig);
    if (options.projectConfig === undefined) return { mode: "disabled" };
    const project = parseProject(options.projectConfig);
    if (!project.enabled || !ceiling.allowed) return { mode: "disabled" };
    if (project.targets === undefined && ceiling.mode === "full")
        return { mode: "full", endpoint: ceiling.endpoint };
    const permitted = new Set(ceiling.operations ?? DOCKER_OPERATIONS);
    const unsafe = new Set(ceiling.unsafeTargets.map(dockerSelectorKey));
    const targets = (project.targets ?? []).map((item) => {
        if (item.operations?.some((operation) => !permitted.has(operation)))
            invalid("Project added a Docker operation beyond global limits");
        return {
            ...item,
            operations: item.operations ?? ceiling.operations,
            allowUnsafeTarget: unsafe.has(dockerSelectorKey(item.selector)),
        };
    });
    return { mode: "targeted", endpoint: ceiling.endpoint, targets };
}
export function dockerPolicyHasUnsafeTargets(
    policy: SandboxDockerPolicy,
): boolean {
    return (
        policy.mode === "targeted" &&
        policy.targets.some((target) => target.allowUnsafeTarget)
    );
}
