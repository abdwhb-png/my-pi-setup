import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { SandboxMode } from "../../_shared/shell-runtime/contracts.ts";
import { SandboxExecutionError } from "../runtime/contracts.ts";
import { validatePiSandboxConfig } from "../runtime/policies.ts";
import {
    validateGlobalInstallations,
    parseInstallationSelection,
} from "./installations.ts";
export { localMachineId } from "../../_shared/sandbox-runtime/machine-identity.ts";

export {
    CAPABILITY_ERROR_CODES,
    CapabilityError,
    capabilityErrorMessage,
    isCapabilityError,
    type CapabilityErrorCode,
} from "../../_shared/shell-capability-error.ts";
export {
    emptyGrants,
    type CapabilityGrants,
    type SandboxMode,
    type ShellProfile,
} from "../../_shared/shell-runtime/contracts.ts";
export interface SandboxConfigLayer {
    /** Global authorization only; never a session mode selection. */
    host?: { allowed: boolean };
    mode?: SandboxMode;
    network?: Record<string, unknown>;
    filesystem?: Record<string, unknown>;
    environment?: Record<string, unknown>;
    tmpNamespace?: "host" | "lease-private";
    docker?: unknown;
    resources?: unknown;
}
export interface GlobalSandboxConfig extends SandboxConfigLayer {
    version: 2;
    machineId: string;
}

const PATH_GLOB_META = /[*?[\]{}]/;

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
export function sandboxConfigPath(agentDir: string): string {
    return resolve(agentDir, "sandbox.json");
}
function invalid(message: string): never {
    throw new SandboxExecutionError("invalid-policy", {
        cause: new Error(message),
        diagnostic: message,
    });
}
function record(value: unknown, scope: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        invalid(`${scope} must be an object`);
    return value as Record<string, unknown>;
}
function known(
    value: Record<string, unknown>,
    fields: readonly string[],
    scope: string,
): void {
    for (const key of Object.keys(value))
        if (!fields.includes(key)) invalid(`Unknown ${scope} field: ${key}`);
}
function stableLiteralPaths(
    filesystem: NonNullable<SandboxConfigLayer["filesystem"]>,
    key: "denyReadWhenExternal" | "denyWriteWhenExternal",
): void {
    const value = filesystem[key];
    const field = `global filesystem.${key}`;
    if (value === undefined) return;
    if (!Array.isArray(value)) invalid(`${field} must be a string array`);
    for (const path of value) {
        if (typeof path !== "string")
            invalid(`${field} must be a string array`);
        if (
            PATH_GLOB_META.test(path) ||
            (path !== "~" && !path.startsWith("~/") && !isAbsolute(path))
        )
            invalid(
                `${field} entries must be absolute or home-relative literal paths`,
            );
    }
}
function ordinaryFilesystemFields(
    filesystem: NonNullable<SandboxConfigLayer["filesystem"]>,
): NonNullable<SandboxConfigLayer["filesystem"]> {
    const {
        denyReadWhenExternal: _denyReadWhenExternal,
        denyWriteWhenExternal: _denyWriteWhenExternal,
        ...ordinary
    } = filesystem;
    return ordinary;
}
function safeFile(path: string, description: string): void {
    const metadata = lstatSync(path);
    const uid = process.getuid?.();
    if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o022) !== 0 ||
        (uid !== undefined && metadata.uid !== uid)
    )
        invalid(`Untrusted ${description}`);
}
function readJson(path: string, description: string): unknown {
    try {
        safeFile(path, description);
        return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        if (error instanceof SandboxExecutionError) throw error;
        invalid(
            `Could not parse ${description}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}
function validateLayer(
    layer: Record<string, unknown>,
    scope: "global" | "project",
): SandboxConfigLayer {
    known(
        layer,
        [
            "mode",
            ...(scope === "global" ? ["host"] : []),
            "network",
            "filesystem",
            "environment",
            "tmpNamespace",
            "docker",
            "resources",
        ],
        `${scope} sandbox config`,
    );
    if (layer.host !== undefined) {
        const host = record(layer.host, "global host");
        known(host, ["allowed"], "global host");
        if (typeof host.allowed !== "boolean")
            invalid("global host.allowed must be a boolean");
    }
    if (
        layer.mode !== undefined &&
        layer.mode !== "sandbox" &&
        layer.mode !== "host"
    )
        invalid(`${scope} mode must be sandbox or host`);
    if (
        layer.tmpNamespace !== undefined &&
        layer.tmpNamespace !== "host" &&
        layer.tmpNamespace !== "lease-private"
    )
        invalid(`${scope} tmpNamespace is invalid`);
    for (const field of ["network", "filesystem", "environment"] as const)
        if (layer[field] !== undefined)
            record(layer[field], `${scope}.${field}`);
    if (layer.network !== undefined) {
        known(
            record(layer.network, scope + ".network"),
            [
                "allowedDomains",
                "allowedHostDomains",
                "deniedDomains",
                "allowLocalBinding",
            ],
            scope + ".network",
        );
    }
    const configuredFilesystem =
        layer.filesystem === undefined
            ? undefined
            : record(layer.filesystem, scope + ".filesystem");
    if (configuredFilesystem !== undefined) {
        known(
            configuredFilesystem,
            [
                "allowRead",
                "denyRead",
                "allowWrite",
                "denyWrite",
                ...(scope === "global"
                    ? ["denyReadWhenExternal", "denyWriteWhenExternal"]
                    : []),
            ],
            scope + ".filesystem",
        );
        if (scope === "global") {
            stableLiteralPaths(configuredFilesystem, "denyReadWhenExternal");
            stableLiteralPaths(configuredFilesystem, "denyWriteWhenExternal");
        }
    }
    if (layer.environment !== undefined) {
        known(
            record(layer.environment, scope + ".environment"),
            [
                "allowedVariables",
                "deniedVariables",
                "variables",
                "path",
                "installations",
            ],
            scope + ".environment",
        );
    }
    if (layer.resources !== undefined) {
        known(
            record(layer.resources, scope + ".resources"),
            ["unixSockets", "tcpPublications"],
            scope + ".resources",
        );
    }
    const {
        mode: _mode,
        host: _host,
        docker: _docker,
        filesystem: _filesystem,
        ...generic
    } = layer;
    const ordinaryFilesystem =
        configuredFilesystem === undefined
            ? undefined
            : ordinaryFilesystemFields(configuredFilesystem);
    const environment =
        layer.environment === undefined
            ? undefined
            : record(layer.environment, `${scope}.environment`);
    if (scope === "global")
        validateGlobalInstallations(environment?.installations);
    else parseInstallationSelection(environment?.installations, scope);
    const { installations: _installations, ...ordinaryEnvironment } =
        environment ?? {};
    validatePiSandboxConfig({
        ...generic,
        ...(ordinaryFilesystem === undefined
            ? {}
            : { filesystem: ordinaryFilesystem }),
        environment: ordinaryEnvironment,
    });
    return layer as SandboxConfigLayer;
}
export function readGlobalSandboxConfig(
    path: string,
    machineId: string,
): GlobalSandboxConfig | undefined {
    try {
        lstatSync(path);
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
        )
            return undefined;
        invalid(
            `Could not inspect global sandbox.json: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    const root = record(
        readJson(path, "global sandbox.json"),
        "global sandbox.json",
    );
    known(
        root,
        [
            "$schema",
            "version",
            "machineId",
            "mode",
            "host",
            "network",
            "filesystem",
            "environment",
            "tmpNamespace",
            "docker",
            "resources",
        ],
        "global sandbox config",
    );
    if (root.version !== 2) invalid("global sandbox.json version must be 2");
    if (typeof root.machineId !== "string" || !root.machineId)
        invalid("global sandbox.json machineId is required");
    if (root.machineId !== machineId)
        invalid("global sandbox.json belongs to another machine");
    if (root.$schema !== undefined && typeof root.$schema !== "string")
        invalid("global $schema must be a string");
    const {
        $schema: _schema,
        version: _version,
        machineId: _machineId,
        ...layer
    } = root;
    return { version: 2, machineId, ...validateLayer(layer, "global") };
}
export function readProjectSandboxConfig(
    path: string,
): SandboxConfigLayer | undefined {
    try {
        lstatSync(path);
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
        )
            return undefined;
        invalid(
            `Could not inspect project sandbox.json: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    const root = record(
        readJson(path, "project sandbox.json"),
        "project sandbox.json",
    );
    for (const field of ["version", "machineId", "$schema"])
        if (Object.hasOwn(root, field))
            invalid(`${field} is reserved to global sandbox.json`);
    const layer = validateLayer(root, "project");
    if (layer.docker !== undefined) {
        const docker = record(layer.docker, "project docker");
        known(docker, ["enabled", "targets"], "project docker");
        if (docker.enabled !== undefined && typeof docker.enabled !== "boolean")
            invalid("project docker.enabled must be boolean");
    }
    return layer;
}
export function canonicalPotentialPath(
    path: string,
    remainingLinks = 40,
): string {
    if (remainingLinks < 0) invalid("Cannot resolve a symbolic-link cycle");
    const suffix: string[] = [];
    let parent = path;
    while (true) {
        try {
            const metadata = lstatSync(parent);
            const canonical = metadata.isSymbolicLink()
                ? canonicalPotentialPath(
                      resolve(dirname(parent), readlinkSync(parent)),
                      remainingLinks - 1,
                  )
                : realpathSync(parent);
            return join(canonical, ...suffix);
        } catch (error) {
            if (
                !(error instanceof Error) ||
                !("code" in error) ||
                (error.code !== "ENOENT" && error.code !== "ENOTDIR")
            )
                throw error;
            const next = dirname(parent);
            if (next === parent) throw error;
            suffix.unshift(basename(parent));
            parent = next;
        }
    }
}
export function canonicalProjectPath(
    value: string,
    projectRoot: string,
): string {
    const expanded =
        value === "~" || value.startsWith("~/")
            ? expandCapabilityPath(value)
            : value;
    return canonicalPotentialPath(
        isAbsolute(expanded)
            ? resolve(expanded)
            : resolve(projectRoot, expanded),
    );
}
