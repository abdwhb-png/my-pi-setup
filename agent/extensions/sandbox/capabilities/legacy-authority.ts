import { createHash } from "node:crypto";
import {
    closeSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
    CapabilityError,
    isCapabilityError,
} from "../../_shared/shell-capability-error.ts";
import { validatePiSandboxConfig } from "../runtime/policies.ts";

export {
    CAPABILITY_ERROR_CODES,
    CapabilityError,
    capabilityErrorMessage,
    isCapabilityError,
    type CapabilityErrorCode,
} from "../../_shared/shell-capability-error.ts";

export const HOST_CAPABILITIES = [
    "editor",
    "dependencies",
    "dev-services",
] as const;
export type HostCapability = (typeof HOST_CAPABILITIES)[number];
export type ShellProfile = "isolated" | "integrated" | "host";
export interface CapabilityGrants {
    domains: string[];
    hostDomains: string[];
    readPaths: string[];
    writePaths: string[];
    hostTmp: boolean;
    host: boolean;
    integrations: Partial<Record<HostCapability, Record<string, string>>>;
}
export interface ProjectCapabilities {
    projectRoot: string;
    profile: ShellProfile;
    grants: CapabilityGrants;
}
export interface CapabilityAuthority {
    version: 1;
    machineId: string;
    projects: ProjectCapabilities[];
}
export function emptyGrants(): CapabilityGrants {
    return {
        domains: [],
        hostDomains: [],
        readPaths: [],
        writePaths: [],
        hostTmp: false,
        host: false,
        integrations: {},
    };
}
export function expandCapabilityPath(value: string): string {
    return value === "~"
        ? homedir()
        : value.startsWith("~/")
          ? resolve(homedir(), value.slice(2))
          : resolve(value);
}
export function persistedCapabilityPath(value: string): string {
    const home = homedir();
    return value === home
        ? "~"
        : value.startsWith(`${home}/`)
          ? `~/${value.slice(home.length + 1)}`
          : value;
}
export function capabilityAuthorityPath(agentDir: string): string {
    return join(agentDir, "sandbox.capabilities.json");
}
export function localMachineId(): string {
    // Bind grants to this Linux/WSL installation and user, not a portable Pi directory.
    const identity = readFileSync("/etc/machine-id", "utf8").trim();
    if (!identity)
        throw new CapabilityError(
            "invalid-authority",
            "Machine identity is unavailable",
        );
    return createHash("sha256")
        .update(`${identity}:${process.getuid?.()}`)
        .digest("hex");
}
function invalid(message: string): never {
    throw new CapabilityError("invalid-authority", message);
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        invalid("Expected an object");
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record))
        if (!keys.includes(key)) invalid(`Unknown authority field: ${key}`);
    return record;
}
function strings(value: unknown): string[] {
    if (
        !Array.isArray(value) ||
        value.some((v) => typeof v !== "string" || !v || v.includes("\0"))
    )
        invalid("Expected nonempty strings");
    return [...new Set(value as string[])];
}
function boolean(value: unknown): boolean {
    if (typeof value !== "boolean") invalid("Expected a boolean");
    return value;
}
function localPaths(value: unknown): string[] {
    return strings(value).map((path) => {
        if (!isAbsolute(path) && path !== "~" && !path.startsWith("~/"))
            invalid("Expected absolute or home-relative capability paths");
        return expandCapabilityPath(path);
    });
}
export function parseShellProfile(value: unknown): ShellProfile {
    if (value !== "isolated" && value !== "integrated" && value !== "host")
        invalid("Unknown shell profile");
    return value;
}
export function parseGrants(value: unknown): CapabilityGrants {
    const raw = object(value, [
        "domains",
        "hostDomains",
        "readPaths",
        "writePaths",
        "hostTmp",
        "host",
        "integrations",
    ]);
    const integrations = object(raw.integrations, [...HOST_CAPABILITIES]);
    const result: CapabilityGrants["integrations"] = {};
    for (const name of HOST_CAPABILITIES) {
        if (integrations[name] === undefined) continue;
        const keys =
            name === "editor"
                ? ["launcher", "zed"]
                : name === "dependencies"
                  ? ["sfw", "npm", "pi"]
                  : ["dev-services"];
        const executables = object(integrations[name], keys);
        const paths: Record<string, string> = {};
        for (const [key, value] of Object.entries(executables)) {
            if (
                typeof value !== "string" ||
                (!isAbsolute(value) && !value.startsWith("~/")) ||
                value.includes("\0")
            )
                invalid(
                    "Executables must have local absolute or home-relative paths",
                );
            paths[key] = expandCapabilityPath(value);
        }
        result[name] = paths;
    }
    const domains = strings(raw.domains);
    const hostDomains = strings(raw.hostDomains);
    try {
        validatePiSandboxConfig({
            network: {
                allowedDomains: domains,
                allowedHostDomains: hostDomains,
            },
        });
    } catch {
        invalid("Invalid capability network destinations");
    }
    return {
        domains,
        hostDomains,
        readPaths: localPaths(raw.readPaths),
        writePaths: localPaths(raw.writePaths),
        hostTmp: boolean(raw.hostTmp),
        host: boolean(raw.host),
        integrations: result,
    };
}
function parseAuthority(raw: unknown): CapabilityAuthority {
    const value = object(raw, ["version", "machineId", "projects"]);
    if (
        value.version !== 1 ||
        typeof value.machineId !== "string" ||
        !value.machineId
    )
        invalid("Unsupported authority version or identity");
    if (!Array.isArray(value.projects)) invalid("Expected project grants");
    const roots = new Set<string>();
    const projects = value.projects.map((entry) => {
        const project = object(entry, ["projectRoot", "profile", "grants"]);
        if (
            typeof project.projectRoot !== "string" ||
            (!isAbsolute(project.projectRoot) &&
                !project.projectRoot.startsWith("~/"))
        )
            invalid("Expected a project root");
        const projectRoot = expandCapabilityPath(project.projectRoot);
        if (roots.has(projectRoot)) invalid("Duplicate project grants");
        roots.add(projectRoot);
        return {
            projectRoot,
            profile: parseShellProfile(project.profile),
            grants: parseGrants(project.grants),
        };
    });
    return { version: 1, machineId: value.machineId, projects };
}
export function readCapabilityAuthority(
    path: string,
    machineId = localMachineId(),
): CapabilityAuthority {
    // lstat also rejects dangling links; existsSync alone would silently treat them as absent.
    let metadata;
    try {
        metadata = lstatSync(path);
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
        )
            return { version: 1, machineId, projects: [] };
        throw error;
    }
    if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o077) !== 0 ||
        (process.getuid && metadata.uid !== process.getuid())
    )
        invalid(
            "Capability authority must be an owned regular file with mode 0600",
        );
    try {
        return parseAuthority(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
        if (isCapabilityError(error)) throw error;
        throw new CapabilityError(
            "invalid-authority",
            "Cannot parse capability authority",
        );
    }
}

/** Call only from an explicit user command. This API never obtains approval itself. */
