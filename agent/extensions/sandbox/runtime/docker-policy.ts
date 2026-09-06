/* oxlint-disable typescript/no-restricted-types -- sandbox.global.json and project overlays are untrusted JSON until this module validates every field. */
import {
    existsSync,
    lstatSync,
    readFileSync,
    realpathSync,
    statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import {
    DOCKER_OPERATIONS,
    SandboxExecutionError,
    type DockerOperation,
    type DockerTargetGrant,
    type DockerTargetSelector,
    type SandboxDockerPolicy,
} from "./contracts.ts";

export const DEFAULT_DOCKER_ENDPOINT = "unix:///var/run/docker.sock";

interface GlobalDockerGrant {
    projectRoot: string;
    policy: Exclude<SandboxDockerPolicy, { mode: "disabled" }>;
}

interface ProjectTargetNarrowing {
    selector: DockerTargetSelector;
    operations?: DockerOperation[];
    allowUnsafeTarget?: boolean;
}

type ProjectDockerNarrowing =
    | { mode: "disabled" }
    | { mode: "full" }
    | { mode: "targeted"; targets?: ProjectTargetNarrowing[] };

export interface ResolveDockerPolicyOptions {
    cwd: string;
    globalConfigPath: string;
    projectOverride?: unknown;
    homeDir?: string;
}

function invalid(cause: unknown): never {
    throw new SandboxExecutionError("invalid-policy", { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
    if (!isRecord(value)) invalid(new Error(`${field} must be an object`));
    return value;
}

function assertKnownFields(
    value: Record<string, unknown>,
    allowed: readonly string[],
    field: string,
): void {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
            invalid(new Error(`Unknown ${field} field`));
        }
    }
}

function nonEmptyString(value: unknown, field: string): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.trim() !== value ||
        value.includes("\0")
    ) {
        invalid(new Error(`${field} must be a non-empty string`));
    }
    return value;
}

function parseSelector(value: unknown): DockerTargetSelector {
    const selector = record(value, "Docker target selector");
    const type = selector.type;
    if (type === "container-name") {
        assertKnownFields(selector, ["type", "name"], "container selector");
        return {
            type,
            name: nonEmptyString(selector.name, "selector.name"),
        };
    }
    if (type === "compose-service") {
        assertKnownFields(
            selector,
            ["type", "project", "service"],
            "Compose selector",
        );
        return {
            type,
            project: nonEmptyString(selector.project, "selector.project"),
            service: nonEmptyString(selector.service, "selector.service"),
        };
    }
    return invalid(new Error("Unknown Docker target selector type"));
}

function parseOperations(value: unknown): DockerOperation[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
        invalid(new Error("Docker target operations must be an array"));
    }
    const operations: DockerOperation[] = [];
    const seen = new Set<DockerOperation>();
    for (const operation of value) {
        if (typeof operation !== "string") {
            invalid(new Error("Unknown Docker operation"));
        }
        const typedOperation = DOCKER_OPERATIONS.find(
            (candidate) => candidate === operation,
        );
        if (typedOperation === undefined) {
            invalid(new Error("Unknown Docker operation"));
        }
        if (seen.has(typedOperation)) {
            invalid(new Error("Duplicate Docker operation"));
        }
        seen.add(typedOperation);
        operations.push(typedOperation);
    }
    return operations;
}

function parseUnsafeFlag(
    value: unknown,
    required: boolean,
): boolean | undefined {
    if (value === undefined) return required ? false : undefined;
    if (typeof value !== "boolean") {
        invalid(new Error("allowUnsafeTarget must be boolean"));
    }
    return value;
}

function parseTargetFields(value: unknown): {
    selector: DockerTargetSelector;
    operations?: DockerOperation[];
    allowUnsafeTarget?: unknown;
} {
    const target = record(value, "Docker target");
    assertKnownFields(
        target,
        ["selector", "operations", "allowUnsafeTarget"],
        "Docker target",
    );
    return {
        selector: parseSelector(target.selector),
        operations: parseOperations(target.operations),
        allowUnsafeTarget: target.allowUnsafeTarget,
    };
}

function selectorKey(selector: DockerTargetSelector): string {
    return selector.type === "container-name"
        ? JSON.stringify([selector.type, selector.name])
        : JSON.stringify([selector.type, selector.project, selector.service]);
}

function parseTargetList<T>(
    value: unknown,
    parse: (target: unknown) => T & { selector: DockerTargetSelector },
): T[] {
    if (!Array.isArray(value)) {
        invalid(new Error("Docker targets must be an array"));
    }
    const targets = value.map(parse);
    const seen = new Set<string>();
    for (const target of targets) {
        const key = selectorKey(target.selector);
        if (seen.has(key)) invalid(new Error("Duplicate Docker target"));
        seen.add(key);
    }
    return targets;
}

function parseGlobalTargets(value: unknown): DockerTargetGrant[] {
    return parseTargetList(value, (target) => {
        const parsed = parseTargetFields(target);
        return {
            selector: parsed.selector,
            operations: parsed.operations,
            allowUnsafeTarget:
                parseUnsafeFlag(parsed.allowUnsafeTarget, true) ?? false,
        };
    });
}

function parseProjectTargets(value: unknown): ProjectTargetNarrowing[] {
    return parseTargetList(value, (target) => {
        const parsed = parseTargetFields(target);
        return {
            selector: parsed.selector,
            operations: parsed.operations,
            allowUnsafeTarget: parseUnsafeFlag(parsed.allowUnsafeTarget, false),
        };
    });
}

function normalizeEndpoint(value: unknown): string {
    if (value === undefined) return DEFAULT_DOCKER_ENDPOINT;
    const endpoint = nonEmptyString(value, "Docker endpoint");
    const path = endpoint.startsWith("unix://")
        ? endpoint.slice("unix://".length)
        : endpoint;
    if (endpoint.includes("://") && !endpoint.startsWith("unix://")) {
        invalid(new Error("Docker endpoint must be a local Unix socket"));
    }
    if (!isAbsolute(path)) {
        invalid(new Error("Docker Unix socket path must be absolute"));
    }
    return `unix://${resolve(path)}`;
}

export function expandDockerProjectRoot(path: string, home: string): string {
    if (path === "~") return home;
    if (path.startsWith("~/")) return resolve(home, path.slice(2));
    return path;
}

function canonicalDirectory(path: string, field: string): string {
    try {
        const canonical = realpathSync(path);
        if (!statSync(canonical).isDirectory()) {
            invalid(new Error(`${field} must name a directory`));
        }
        return canonical;
    } catch (error) {
        if (error instanceof SandboxExecutionError) throw error;
        return invalid(error);
    }
}

function readGlobalGrants(path: string, home: string): GlobalDockerGrant[] {
    if (!existsSync(path)) return [];
    let parsed: unknown;
    try {
        const metadata = lstatSync(path);
        const getuid = process.getuid?.();
        if (
            !metadata.isFile() ||
            metadata.isSymbolicLink() ||
            (metadata.mode & 0o022) !== 0 ||
            (getuid !== undefined && metadata.uid !== getuid)
        ) {
            invalid(new Error("Untrusted global Docker authority file"));
        }
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        if (error instanceof SandboxExecutionError) throw error;
        invalid(error);
    }

    const root = record(parsed, "sandbox.global.json");
    assertKnownFields(root, ["docker"], "global sandbox config");
    if (root.docker === undefined) return [];
    const docker = record(root.docker, "docker");
    assertKnownFields(docker, ["grants"], "global Docker config");
    if (!Array.isArray(docker.grants)) {
        invalid(new Error("docker.grants must be an array"));
    }

    const grants: GlobalDockerGrant[] = [];
    const roots = new Set<string>();
    for (const rawGrant of docker.grants) {
        const grant = record(rawGrant, "Docker grant");
        assertKnownFields(
            grant,
            ["projectRoot", "mode", "endpoint", "targets"],
            "Docker grant",
        );
        const configuredRoot = expandDockerProjectRoot(
            nonEmptyString(grant.projectRoot, "projectRoot"),
            home,
        );
        if (!isAbsolute(configuredRoot)) {
            invalid(new Error("projectRoot must be absolute or home-relative"));
        }
        const projectRoot = canonicalDirectory(configuredRoot, "projectRoot");
        if (roots.has(projectRoot)) {
            invalid(new Error("Duplicate Docker project root"));
        }
        roots.add(projectRoot);

        const endpoint = normalizeEndpoint(grant.endpoint);
        let policy: GlobalDockerGrant["policy"];
        if (grant.mode === "full") {
            if (grant.targets !== undefined) {
                invalid(new Error("Full Docker grants cannot declare targets"));
            }
            policy = { mode: "full", endpoint };
        } else if (grant.mode === "targeted") {
            policy = {
                mode: "targeted",
                endpoint,
                targets: parseGlobalTargets(grant.targets),
            };
        } else {
            invalid(new Error("Docker grant mode must be targeted or full"));
        }
        grants.push({ projectRoot, policy });
    }
    return grants;
}

function parseProjectOverride(
    value: unknown,
): ProjectDockerNarrowing | undefined {
    if (value === undefined) return undefined;
    const override = record(value, "project Docker override");
    assertKnownFields(override, ["mode", "targets"], "project Docker override");
    if (override.mode === "disabled" || override.mode === "full") {
        if (override.targets !== undefined) {
            invalid(new Error("This Docker mode cannot declare targets"));
        }
        return { mode: override.mode };
    }
    if (override.mode === "targeted") {
        return {
            mode: "targeted",
            targets:
                override.targets === undefined
                    ? undefined
                    : parseProjectTargets(override.targets),
        };
    }
    return invalid(new Error("Unknown project Docker mode"));
}

function narrowTargetedPolicy(
    globalPolicy: Extract<SandboxDockerPolicy, { mode: "targeted" }>,
    override: Extract<ProjectDockerNarrowing, { mode: "targeted" }>,
): SandboxDockerPolicy {
    if (override.targets === undefined) return globalPolicy;
    const globalTargets = new Map(
        globalPolicy.targets.map((target) => [
            selectorKey(target.selector),
            target,
        ]),
    );
    const targets = override.targets.map((target): DockerTargetGrant => {
        const granted = globalTargets.get(selectorKey(target.selector));
        if (!granted) invalid(new Error("Project added a Docker target"));
        const globallyAllowed = new Set(
            granted.operations ?? DOCKER_OPERATIONS,
        );
        if (
            target.operations?.some(
                (operation) => !globallyAllowed.has(operation),
            )
        ) {
            invalid(new Error("Project added a Docker operation"));
        }
        if (target.allowUnsafeTarget === true && !granted.allowUnsafeTarget) {
            invalid(new Error("Project added an unsafe Docker exception"));
        }
        return {
            selector: target.selector,
            operations: target.operations ?? granted.operations,
            allowUnsafeTarget:
                target.allowUnsafeTarget ?? granted.allowUnsafeTarget,
        };
    });
    return { ...globalPolicy, targets };
}

function narrowFullPolicy(
    globalPolicy: Extract<SandboxDockerPolicy, { mode: "full" }>,
    override: Extract<ProjectDockerNarrowing, { mode: "targeted" }>,
): SandboxDockerPolicy {
    if (override.targets === undefined) {
        invalid(
            new Error("Targeted narrowing of full Docker requires targets"),
        );
    }
    const targets = override.targets.map((target): DockerTargetGrant => {
        if (target.allowUnsafeTarget === true) {
            invalid(new Error("Project added an unsafe Docker exception"));
        }
        return {
            selector: target.selector,
            operations: target.operations,
            allowUnsafeTarget: false,
        };
    });
    return { mode: "targeted", endpoint: globalPolicy.endpoint, targets };
}

export function resolveDockerPolicy(
    options: ResolveDockerPolicyOptions,
): SandboxDockerPolicy {
    const home = options.homeDir ?? homedir();
    const cwd = canonicalDirectory(options.cwd, "cwd");
    const grants = readGlobalGrants(options.globalConfigPath, home);
    const globalPolicy =
        grants.find((grant) => grant.projectRoot === cwd)?.policy ??
        ({ mode: "disabled" } as const);
    const override = parseProjectOverride(options.projectOverride);
    if (!override) return globalPolicy;
    if (override.mode === "disabled") return { mode: "disabled" };
    if (globalPolicy.mode === "disabled") {
        invalid(new Error("Project attempted to enable Docker"));
    }
    if (override.mode === "full") {
        if (globalPolicy.mode !== "full") {
            invalid(new Error("Project attempted to expand Docker to full"));
        }
        return globalPolicy;
    }
    return globalPolicy.mode === "full"
        ? narrowFullPolicy(globalPolicy, override)
        : narrowTargetedPolicy(globalPolicy, override);
}

export function dockerPolicyHasUnsafeTargets(
    policy: SandboxDockerPolicy,
): boolean {
    return (
        policy.mode === "targeted" &&
        policy.targets.some((target) => target.allowUnsafeTarget)
    );
}
