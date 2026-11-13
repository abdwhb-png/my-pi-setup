import {
    closeSync,
    constants,
    fchmodSync,
    fstatSync,
    openSync,
    existsSync,
    lstatSync,
    readFileSync,
    readlinkSync,
    realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
    extensionConfigPath,
    assertExtensionConfigMigrated,
    CONFIG_OWNERS,
} from "../../_shared/config-loader.ts";
import type { SandboxMode } from "../../_shared/shell-runtime/contracts.ts";
import { SandboxExecutionError } from "../runtime/contracts.ts";
import {
    normalizeMediatedDirectTcpPorts,
    validatePiSandboxConfig,
} from "../runtime/policies.ts";
import {
    validateGlobalInstallations,
    parseInstallationSelection,
} from "./installations.ts";
import { withSandboxPublicationLockSync } from "./publication-lock.ts";
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
export function assertSandboxConfigMigrated(
    agentDir: string,
    cwd?: string,
): void {
    assertExtensionConfigMigrated("sandbox", { scope: "global", agentDir });
    if (cwd)
        assertExtensionConfigMigrated("sandbox", { scope: "project", cwd });
    const paths = [
        sandboxConfigPath(agentDir),
        join(agentDir, CONFIG_OWNERS.sandbox.legacyFile),
    ];
    if (paths.some((path) => existsSync(path + ".migration")))
        throw new SandboxExecutionError("invalid-policy", {
            cause: new Error(
                "Sandbox migration is incomplete. Run /sandbox recover before editing its configuration.",
            ),
        });
}

export function sandboxConfigPath(agentDir: string): string {
    return extensionConfigPath("sandbox", { scope: "global", agentDir });
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
export interface SandboxConfigurationIssue {
    scope: "global" | "project";
    path: string;
    reason: "permissions" | "owner" | "file-type" | "read" | "json" | "schema";
    detail: string;
    mode?: number;
    uid?: number;
    identity?: string;
}
export function sandboxConfigurationIssue(
    error: unknown,
): SandboxConfigurationIssue | undefined {
    if (
        typeof error !== "object" ||
        error === null ||
        !("configurationIssue" in error)
    )
        return undefined;
    return isConfigurationIssue(error.configurationIssue)
        ? error.configurationIssue
        : undefined;
}
function isConfigurationIssue(
    value: unknown,
): value is SandboxConfigurationIssue {
    return (
        typeof value === "object" &&
        value !== null &&
        "scope" in value &&
        (value.scope === "global" || value.scope === "project") &&
        "path" in value &&
        typeof value.path === "string" &&
        "detail" in value &&
        typeof value.detail === "string" &&
        "reason" in value &&
        typeof value.reason === "string" &&
        [
            "permissions",
            "owner",
            "file-type",
            "read",
            "json",
            "schema",
        ].includes(value.reason) &&
        (!("mode" in value) || typeof value.mode === "number") &&
        (!("uid" in value) || typeof value.uid === "number") &&
        (!("identity" in value) || typeof value.identity === "string")
    );
}
export function formatSandboxConfigurationIssue(
    issue: SandboxConfigurationIssue,
): string {
    const quotedPath = "'" + issue.path.replace(/'/g, "'\"'\"'") + "'";
    const action =
        issue.reason === "permissions"
            ? ` Use /sandbox repair to review a targeted permission repair. Manual alternative: chmod ${issue.scope === "global" ? "go-w" : "o-w"} ${quotedPath}; then /sandbox retry.`
            : " Correct this file, then use /sandbox retry.";
    return `Cannot load ${issue.scope} sandbox configuration: ${issue.path}. ${issue.detail}${action}`;
}
function configFailure(issue: SandboxConfigurationIssue): never {
    const detail = formatSandboxConfigurationIssue(issue);
    throw Object.assign(
        new SandboxExecutionError("invalid-policy", {
            cause: new Error(detail),
            diagnostic: detail,
        }),
        { configurationIssue: issue },
    );
}
function fileIssue(
    path: string,
    scope: SandboxConfigurationIssue["scope"],
): SandboxConfigurationIssue | undefined {
    const m = lstatSync(path);
    const mode = m.mode & 0o777;
    const base = {
        path,
        scope,
        mode,
        uid: m.uid,
        identity: `${m.dev}:${m.ino}:${m.mode}:${m.size}:${m.mtimeMs}:${m.ctimeMs}`,
    };
    if (!m.isFile() || m.isSymbolicLink())
        return {
            ...base,
            reason: "file-type",
            detail: "Expected a regular file, not a symbolic link or directory.",
        };
    if (process.getuid && m.uid !== process.getuid())
        return {
            ...base,
            reason: "owner",
            detail: `Owner UID ${m.uid} differs from current UID ${process.getuid()}.`,
        };
    const forbidden = scope === "global" ? 0o022 : 0o002;
    if (mode & forbidden)
        return {
            ...base,
            reason: "permissions",
            detail: `Mode 0${mode.toString(8)} permits ${scope === "global" ? "group or public" : "public"} writes; expected no such write permissions.`,
        };
    return undefined;
}
export function repairSandboxConfigPermissions(
    issue: SandboxConfigurationIssue,
    globalPath: string,
    projectPath: string,
): void {
    const path = issue.scope === "global" ? globalPath : projectPath;
    if (path !== issue.path || issue.reason !== "permissions")
        throw new Error(
            "This configuration problem cannot be repaired automatically.",
        );
    withSandboxPublicationLockSync(globalPath, () => {
        const current = fileIssue(path, issue.scope);
        if (
            !current ||
            current.reason !== "permissions" ||
            current.identity !== issue.identity
        )
            throw new Error(
                "Configuration changed while reviewing permissions. Refresh and review again.",
            );
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const m = fstatSync(fd);
            if (
                `${m.dev}:${m.ino}:${m.mode}:${m.size}:${m.mtimeMs}:${m.ctimeMs}` !==
                    issue.identity ||
                !m.isFile() ||
                !process.getuid ||
                m.uid !== process.getuid()
            )
                throw new Error(
                    "Configuration changed before repair; no permissions were modified.",
                );
            fchmodSync(
                fd,
                m.mode & 0o7777 & ~(issue.scope === "global" ? 0o022 : 0o002),
            );
        } finally {
            closeSync(fd);
        }
    });
}
function readJson(path: string, description: string): unknown {
    const scope = description.startsWith("global") ? "global" : "project";
    try {
        const issue = fileIssue(path, scope);
        if (issue) configFailure(issue);
        const bytes = readFileSync(path, "utf8");
        try {
            return JSON.parse(bytes);
        } catch {
            configFailure({
                scope,
                path,
                reason: "json",
                detail: "Invalid JSON. Edit the file to correct its syntax; configuration contents are hidden.",
            });
        }
    } catch (error) {
        if (error instanceof SandboxExecutionError) throw error;
        configFailure({
            scope,
            path,
            reason: "read",
            detail: `File could not be read (${typeof error === "object" && error && "code" in error ? String(error.code) : "I/O error"}).`,
        });
    }
}
export function parseHostLoopback(value: unknown): boolean {
    if (value === undefined) return false;
    const config = record(value, "global.network.hostLoopback");
    known(config, ["allowed"], "global.network.hostLoopback");
    if (typeof config.allowed !== "boolean")
        invalid("global.network.hostLoopback.allowed must be a boolean");
    return config.allowed;
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
    const configuredNetwork =
        layer.network === undefined
            ? undefined
            : record(layer.network, scope + ".network");
    if (configuredNetwork !== undefined) {
        known(
            configuredNetwork,
            [
                "allowedDomains",
                "allowedHostDomains",
                "deniedDomains",
                "allowLocalBinding",
                "mediatedDirectTcp",
                ...(scope === "global" ? ["hostLoopback"] : []),
            ],
            scope + ".network",
        );
        if (scope === "global")
            parseHostLoopback(configuredNetwork.hostLoopback);
        if (configuredNetwork.mediatedDirectTcp !== undefined) {
            const direct = record(
                configuredNetwork.mediatedDirectTcp,
                `${scope}.network.mediatedDirectTcp`,
            );
            const switchName = scope === "global" ? "allowed" : "enabled";
            known(
                direct,
                [switchName, "ports"],
                `${scope}.network.mediatedDirectTcp`,
            );
            if (typeof direct[switchName] !== "boolean")
                invalid(
                    `${scope}.network.mediatedDirectTcp.${switchName} must be a boolean`,
                );
            let ports: number[];
            try {
                ports = normalizeMediatedDirectTcpPorts(
                    direct.ports,
                    `${scope}.network.mediatedDirectTcp.ports`,
                );
            } catch (error) {
                invalid(error instanceof Error ? error.message : String(error));
            }
            if (direct[switchName] && ports.length === 0)
                invalid(
                    `${scope}.network.mediatedDirectTcp requires at least one port when ${switchName} is true`,
                );
            if (!direct[switchName] && ports.length > 0)
                invalid(
                    `${scope}.network.mediatedDirectTcp cannot declare ports when ${switchName} is false`,
                );
        }
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
                "denyWriteExceptions",
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
    const {
        mediatedDirectTcp: _mediatedDirectTcp,
        hostLoopback: _hostLoopback,
        ...ordinaryNetwork
    } = configuredNetwork ?? {};
    validatePiSandboxConfig({
        ...generic,
        network: ordinaryNetwork,
        ...(ordinaryFilesystem === undefined
            ? {}
            : { filesystem: ordinaryFilesystem }),
        environment: ordinaryEnvironment,
    });
    return layer as SandboxConfigLayer;
}
function readGlobalSandboxConfigValue(
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
        configFailure({
            scope: "global",
            path,
            reason: "read",
            detail: `Could not inspect configuration: ${error instanceof Error ? error.message : String(error)}`,
        });
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
function readProjectSandboxConfigValue(
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
        configFailure({
            scope: "project",
            path,
            reason: "read",
            detail: `Could not inspect configuration: ${error instanceof Error ? error.message : String(error)}`,
        });
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
        known(docker, ["enabled", "targets", "engineInfo"], "project docker");
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

export function readGlobalSandboxConfig(path: string, machineId: string) {
    try {
        return readGlobalSandboxConfigValue(path, machineId);
    } catch (error) {
        if (
            sandboxConfigurationIssue(error) ||
            (error instanceof SandboxExecutionError &&
                error.code !== "invalid-policy")
        )
            throw error;
        const cause =
            error instanceof SandboxExecutionError
                ? (error.getCause() ?? error)
                : error;
        configFailure({
            scope: "global",
            path,
            reason: "schema",
            detail:
                cause instanceof Error
                    ? cause.message
                    : "Invalid configuration schema.",
        });
    }
}

export function readProjectSandboxConfig(path: string) {
    try {
        return readProjectSandboxConfigValue(path);
    } catch (error) {
        if (
            sandboxConfigurationIssue(error) ||
            (error instanceof SandboxExecutionError &&
                error.code !== "invalid-policy")
        )
            throw error;
        const cause =
            error instanceof SandboxExecutionError
                ? (error.getCause() ?? error)
                : error;
        configFailure({
            scope: "project",
            path,
            reason: "schema",
            detail:
                cause instanceof Error
                    ? cause.message
                    : "Invalid configuration schema.",
        });
    }
}
