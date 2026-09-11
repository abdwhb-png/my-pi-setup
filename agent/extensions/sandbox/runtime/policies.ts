import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
    SandboxExecutionError,
    type SandboxDockerPolicy,
    type SandboxLeasePaths,
    type SandboxNetworkPolicy,
    type SandboxPolicy,
    type SandboxResourcesPolicy,
    type SandboxTcpPublication,
} from "./contracts.ts";
import {
    buildShellPath,
    expandShellPathEntry,
    SHELL_SYSTEM_READ_PATHS,
} from "./shell-baseline.ts";

export const DEFAULT_BASH_INHERITED_VARIABLES = [
    "USER",
    "SHELL",
    "TERM",
    "LANG",
    "COLORTERM",
    "NO_COLOR",
] as const;

/** Logical HOME mounted from the current private lease by Zerobox. */
export const SANDBOX_PRIVATE_HOME = "/home/sandbox";

const ASRT_ONLY_FIELDS = [
    "ignoreViolations",
    "enableWeakerNestedSandbox",
    "enableWeakerNetworkIsolation",
    "allowAppleEvents",
] as const;
const GLOB_META = /[*?[\]{}]/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UPSTREAM_PROXY_VARIABLES = new Set([
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
]);
const DOCKER_CONNECTION_VARIABLES = new Set([
    "DOCKER_HOST",
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
]);

interface PiFilesystemConfig {
    allowRead: string[];
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
}

interface PiNetworkConfig {
    allowedDomains: string[];
    allowedHostDomains: string[];
    deniedDomains: string[];
    allowLocalBinding: boolean;
}

interface PiEnvironmentConfig {
    allowedVariables: string[];
    deniedVariables: string[];
    variables: Record<string, string>;
    path: string[];
}

export interface PiSandboxResources extends SandboxResourcesPolicy {}

export interface PiSandboxConfig {
    tmpNamespace?: "host" | "lease-private";
    enabled?: boolean;
    filesystem: PiFilesystemConfig;
    network: PiNetworkConfig;
    environment: PiEnvironmentConfig;
    docker: SandboxDockerPolicy;
    resources?: PiSandboxResources;
}

export interface PolicyInput {
    cwd: string;
    lease: SandboxLeasePaths;
}

export interface BashPolicyInput extends PolicyInput {
    config: PiSandboxConfig;
    hostEnv?: NodeJS.ProcessEnv;
}

export interface AnalysisPolicyInput extends PolicyInput {
    readablePaths: string[];
}

interface ParsedNetworkRule {
    host: string;
    port?: number;
    wildcard: boolean;
    loopback: boolean;
}

function unsupported(cause?: unknown): never {
    throw new SandboxExecutionError("unsupported-capability", { cause });
}

function invalid(cause?: unknown): never {
    throw new SandboxExecutionError("invalid-policy", { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownFields(
    value: Record<string, unknown>,
    allowed: readonly string[],
): void {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) invalid(new Error(`Unknown field: ${key}`));
    }
}

function stringArray(value: unknown, field: string): string[] {
    if (value === undefined) return [];
    if (
        !Array.isArray(value) ||
        value.some((entry) => typeof entry !== "string")
    ) {
        invalid(new Error(`${field} must be a string array`));
    }
    return [
        ...new Set(
            value.filter((entry): entry is string => typeof entry === "string"),
        ),
    ];
}

function envVariables(value: unknown): Record<string, string> {
    if (value === undefined) return {};
    if (!isRecord(value))
        invalid(new Error("environment.variables must be an object"));
    const result: Record<string, string> = {};
    for (const [name, configuredValue] of Object.entries(value)) {
        if (!ENV_NAME.test(name) || typeof configuredValue !== "string") {
            invalid(new Error("Invalid environment variable"));
        }
        result[name] = configuredValue;
    }
    return result;
}

function isBackendReservedVariable(name: string): boolean {
    return (
        name === "PATH" ||
        name === "HOME" ||
        name === "TMPDIR" ||
        DOCKER_CONNECTION_VARIABLES.has(name) ||
        UPSTREAM_PROXY_VARIABLES.has(name) ||
        name.startsWith("ZEROBOX_")
    );
}

function parsePort(value: string): number {
    if (!/^\d+$/.test(value)) invalid(new Error("Invalid network port"));
    const port = Number(value);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        invalid(new Error("Invalid network port"));
    }
    return port;
}

function parseNetworkRule(rawRule: string): ParsedNetworkRule {
    const rule = rawRule.trim().toLowerCase();
    if (!rule || /[\s/@]/.test(rule) || rule.includes("://")) {
        invalid(new Error("Invalid network rule"));
    }

    let host: string;
    let port: number | undefined;
    const bracketed = /^\[([^\]]+)](?::(\d+))?$/.exec(rule);
    if (bracketed) {
        host = bracketed[1];
        if (bracketed[2] !== undefined) port = parsePort(bracketed[2]);
    } else {
        const colonCount = rule.split(":").length - 1;
        if (colonCount === 1) {
            const separator = rule.lastIndexOf(":");
            host = rule.slice(0, separator);
            port = parsePort(rule.slice(separator + 1));
        } else {
            host = rule;
        }
    }

    const wildcard = host.startsWith("*.");
    const bareHost = wildcard ? host.slice(2) : host;
    const loopback =
        bareHost === "localhost" ||
        bareHost === "127.0.0.1" ||
        bareHost === "::1";
    if (loopback) {
        if (wildcard || port === undefined)
            unsupported(new Error("Loopback requires a port"));
        return { host: "localhost", port, wildcard: false, loopback: true };
    }
    if (isIP(bareHost) !== 0) {
        unsupported(new Error("Non-loopback IP literals are not supported"));
    }
    if (
        !bareHost ||
        bareHost.startsWith(".") ||
        bareHost.endsWith(".") ||
        bareHost.includes("..") ||
        !/^[a-z0-9._-]+$/.test(bareHost)
    ) {
        invalid(new Error("Invalid network host"));
    }
    return { host: bareHost, port, wildcard, loopback: false };
}

function formatNetworkRule(rule: ParsedNetworkRule): string {
    const host = `${rule.wildcard ? "*." : ""}${rule.host}`;
    return rule.port === undefined ? host : `${host}:${rule.port}`;
}

function normalizeNetworkRules(rules: string[]): string[] {
    return [
        ...new Set(
            rules.map((rule) => formatNetworkRule(parseNetworkRule(rule))),
        ),
    ];
}

function normalizeHostDomainRules(rules: string[]): string[] {
    return [
        ...new Set(
            rules.map((rawRule) => {
                const rule = parseNetworkRule(rawRule);
                if (rule.loopback) {
                    unsupported(
                        new Error(
                            "Host domain rules require a DNS hostname, not loopback",
                        ),
                    );
                }
                if (rule.port === undefined) {
                    unsupported(
                        new Error("Host domain rules require an explicit port"),
                    );
                }
                return formatNetworkRule(rule);
            }),
        ),
    ];
}

function validateExactPaths(paths: string[]): void {
    for (const path of paths) {
        if (!path || path.includes("\0"))
            invalid(new Error("Invalid filesystem path"));
        if (GLOB_META.test(path))
            unsupported(new Error("Dynamic filesystem glob"));
    }
}

function validateDenyPaths(paths: string[]): void {
    for (const path of paths) {
        if (!path || path.includes("\0")) {
            invalid(new Error("Invalid filesystem deny path"));
        }
    }
}

interface ParsedSocketAddress {
    address: string;
    host: string;
    family: 4 | 6;
}

function parseSocketAddress(
    value: unknown,
    field: string,
): ParsedSocketAddress {
    if (typeof value !== "string" || !value || /\s/.test(value))
        invalid(new Error(`${field} must be an IP socket address`));
    const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(value);
    const plain = /^([^:]+):(\d+)$/.exec(value);
    const match = bracketed ?? plain;
    if (!match) invalid(new Error(`${field} must be an IP socket address`));
    const detectedFamily = isIP(match[1]!);
    if (
        detectedFamily === 0 ||
        (bracketed !== null && detectedFamily !== 6) ||
        (plain !== null && detectedFamily !== 4)
    )
        invalid(new Error(`${field} must be an IP socket address`));
    const family: 4 | 6 = detectedFamily === 4 ? 4 : 6;
    let host = match[1]!;
    if (family === 6) {
        try {
            const canonical = new URL(`http://[${host}]/`).hostname;
            host = canonical.slice(1, -1);
        } catch {
            invalid(new Error(`${field} must be an IP socket address`));
        }
    }
    if (host === "0.0.0.0" || host === "::")
        invalid(new Error(`${field} must be a non-wildcard IP socket address`));
    const port = Number(match[2]);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
        invalid(new Error(`${field} must have a non-zero port`));
    return {
        address: family === 6 ? `[${host}]:${port}` : `${host}:${port}`,
        host,
        family,
    };
}

function socketAddress(value: unknown, field: string): string {
    return parseSocketAddress(value, field).address;
}

function loopbackSocketAddress(value: unknown, field: string): string {
    const address = parseSocketAddress(value, field);
    const loopback =
        address.family === 6
            ? address.host === "::1"
            : Number(address.host.split(".", 1)[0]) === 127;
    if (!loopback) invalid(new Error(`${field} must target private loopback`));
    return address.address;
}

export function normalizeSandboxResources(value: unknown): PiSandboxResources {
    if (value === undefined) return { unixSockets: [], tcpPublications: [] };
    if (!isRecord(value)) invalid(new Error("resources must be an object"));
    assertKnownFields(value, ["unixSockets", "tcpPublications"]);
    const unixSockets = stringArray(
        value.unixSockets,
        "resources.unixSockets",
    ).map(expandHome);
    for (const socket of unixSockets) {
        if (
            !isAbsolute(socket) ||
            socket.includes("\0") ||
            GLOB_META.test(socket)
        )
            invalid(
                new Error(
                    "resources.unixSockets must contain absolute exact paths",
                ),
            );
    }
    const tcpPublications =
        value.tcpPublications === undefined
            ? []
            : (() => {
                  if (!Array.isArray(value.tcpPublications))
                      invalid(
                          new Error(
                              "resources.tcpPublications must be an array",
                          ),
                      );
                  return value.tcpPublications.map(
                      (entry): SandboxTcpPublication => {
                          if (!isRecord(entry))
                              invalid(
                                  new Error(
                                      "TCP publication must be an object",
                                  ),
                              );
                          assertKnownFields(entry, [
                              "transport",
                              "scope",
                              "listen",
                              "target",
                          ]);
                          if (entry.transport === "udp")
                              unsupported(
                                  new Error("UDP publications are unavailable"),
                              );
                          if (entry.transport !== "tcp")
                              invalid(
                                  new Error(
                                      "TCP publication transport must be tcp",
                                  ),
                              );
                          if (entry.scope !== "host" && entry.scope !== "lan")
                              invalid(
                                  new Error(
                                      "TCP publication scope must be host or lan",
                                  ),
                              );
                          const listen = socketAddress(
                              entry.listen,
                              "TCP publication listen",
                          );
                          if (entry.scope === "host")
                              loopbackSocketAddress(
                                  entry.listen,
                                  "host TCP publication listen",
                              );
                          return {
                              transport: "tcp",
                              scope: entry.scope,
                              listen,
                              target: loopbackSocketAddress(
                                  entry.target,
                                  "TCP publication target",
                              ),
                          };
                      },
                  );
              })();
    const tuples = tcpPublications.map(
        (item) =>
            `${item.transport}\0${item.scope}\0${item.listen}\0${item.target}`,
    );
    if (new Set(tuples).size !== tuples.length)
        invalid(new Error("Duplicate TCP publication"));
    return { unixSockets: unique(unixSockets), tcpPublications };
}

export function validatePiSandboxConfig(
    raw: unknown,
    docker: SandboxDockerPolicy = { mode: "disabled" },
): PiSandboxConfig {
    if (!isRecord(raw)) invalid(new Error("Sandbox config must be an object"));
    for (const field of ASRT_ONLY_FIELDS) {
        if (Object.hasOwn(raw, field))
            unsupported(new Error(`ASRT field: ${field}`));
    }
    assertKnownFields(raw, [
        "enabled",
        "filesystem",
        "network",
        "environment",
        "tmpNamespace",
        "resources",
    ]);
    if (
        raw.tmpNamespace !== undefined &&
        raw.tmpNamespace !== "host" &&
        raw.tmpNamespace !== "lease-private"
    )
        invalid(new Error("Invalid temporary namespace"));
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
        invalid(new Error("enabled must be boolean"));
    }

    const filesystem = raw.filesystem ?? {};
    if (!isRecord(filesystem))
        invalid(new Error("filesystem must be an object"));
    assertKnownFields(filesystem, [
        "allowRead",
        "denyRead",
        "allowWrite",
        "denyWrite",
    ]);
    const normalizedFilesystem: PiFilesystemConfig = {
        allowRead:
            filesystem.allowRead === undefined
                ? ["."]
                : stringArray(filesystem.allowRead, "filesystem.allowRead"),
        denyRead: stringArray(filesystem.denyRead, "filesystem.denyRead"),
        allowWrite:
            filesystem.allowWrite === undefined
                ? ["."]
                : stringArray(filesystem.allowWrite, "filesystem.allowWrite"),
        denyWrite: stringArray(filesystem.denyWrite, "filesystem.denyWrite"),
    };
    validateExactPaths([
        ...normalizedFilesystem.allowRead,
        ...normalizedFilesystem.allowWrite,
    ]);
    validateDenyPaths([
        ...normalizedFilesystem.denyRead,
        ...normalizedFilesystem.denyWrite,
    ]);

    const network = raw.network ?? {};
    if (!isRecord(network)) invalid(new Error("network must be an object"));
    assertKnownFields(network, [
        "allowedDomains",
        "allowedHostDomains",
        "deniedDomains",
        "allowLocalBinding",
        "allowAllUnixSockets",
    ]);
    if (network.allowAllUnixSockets === true) {
        unsupported(new Error("Host Unix socket access requested"));
    }
    if (
        network.allowLocalBinding !== undefined &&
        typeof network.allowLocalBinding !== "boolean"
    ) {
        invalid(new Error("allowLocalBinding must be boolean"));
    }
    if (
        network.allowAllUnixSockets !== undefined &&
        typeof network.allowAllUnixSockets !== "boolean"
    ) {
        invalid(new Error("allowAllUnixSockets must be boolean"));
    }
    const normalizedNetwork: PiNetworkConfig = {
        allowLocalBinding: network.allowLocalBinding !== false,
        allowedDomains: normalizeNetworkRules(
            stringArray(network.allowedDomains, "network.allowedDomains"),
        ),
        allowedHostDomains: normalizeHostDomainRules(
            stringArray(
                network.allowedHostDomains,
                "network.allowedHostDomains",
            ),
        ),
        deniedDomains: normalizeNetworkRules(
            stringArray(network.deniedDomains, "network.deniedDomains"),
        ),
    };

    const environment = raw.environment ?? {};
    if (!isRecord(environment))
        invalid(new Error("environment must be an object"));
    assertKnownFields(environment, [
        "allowedVariables",
        "deniedVariables",
        "variables",
        "path",
    ]);
    const allowedVariables = stringArray(
        environment.allowedVariables,
        "environment.allowedVariables",
    );
    const deniedVariables = stringArray(
        environment.deniedVariables,
        "environment.deniedVariables",
    );
    for (const name of [...allowedVariables, ...deniedVariables]) {
        if (!ENV_NAME.test(name))
            invalid(new Error("Invalid environment variable name"));
    }
    const path = stringArray(environment.path, "environment.path");
    for (const entry of path) {
        if (
            entry.includes(":") ||
            GLOB_META.test(entry) ||
            !isAbsolute(expandShellPathEntry(entry))
        ) {
            invalid(
                new Error(
                    "environment.path entries must be absolute or home-relative",
                ),
            );
        }
    }

    return {
        enabled: raw.enabled as boolean | undefined,
        tmpNamespace: raw.tmpNamespace,
        filesystem: normalizedFilesystem,
        network: normalizedNetwork,
        environment: {
            allowedVariables,
            deniedVariables,
            variables: envVariables(environment.variables),
            path: unique(path.map(expandShellPathEntry)),
        },
        docker,
        resources: normalizeSandboxResources(raw.resources),
    };
}

function expandHome(path: string): string {
    if (path === "~") return homedir();
    if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
    return path;
}

function normalizePath(path: string, cwd: string): string {
    const expanded = expandHome(path);
    return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function splitDenyPaths(
    paths: string[],
    cwd: string,
): { exact: string[]; globs: string[] } {
    const exact: string[] = [];
    const globs: string[] = [];
    for (const path of paths) {
        if (GLOB_META.test(path)) {
            globs.push(expandHome(path));
        } else {
            exact.push(normalizePath(path, cwd));
        }
    }
    return { exact: unique(exact), globs: unique(globs) };
}

function unique(values: string[]): string[] {
    return [...new Set(values)];
}

function isEqualOrDescendant(path: string, parent: string): boolean {
    return parent === "/" || path === parent || path.startsWith(`${parent}/`);
}

function assertAllowsDoNotOverrideDenies(
    allows: string[],
    denies: string[],
): void {
    for (const allow of allows) {
        const conflictingDeny = denies.find((deny) =>
            isEqualOrDescendant(allow, deny),
        );
        if (conflictingDeny) {
            invalid(
                new Error(
                    `Allowed path ${allow} overrides denied path ${conflictingDeny}`,
                ),
            );
        }
    }
}

function assertNoLogicalPrivateHomeDeny(paths: string[], cwd: string): void {
    for (const path of paths) {
        const expanded = expandHome(path);
        const absolute = isAbsolute(expanded)
            ? expanded
            : resolve(cwd, expanded);
        const firstGlob = absolute.search(GLOB_META);
        const prefix = absolute.slice(0, firstGlob);
        const candidate =
            firstGlob === -1
                ? resolve(absolute)
                : resolve(
                      prefix === "/"
                          ? "/"
                          : prefix.endsWith("/")
                            ? prefix.slice(0, -1)
                            : dirname(prefix),
                  );
        if (
            isEqualOrDescendant(SANDBOX_PRIVATE_HOME, candidate) ||
            isEqualOrDescendant(candidate, SANDBOX_PRIVATE_HOME)
        ) {
            invalid(
                new Error(
                    "A filesystem deny cannot target the logical private HOME",
                ),
            );
        }
    }
}

export function buildBashPath(entries: string[] = []): string {
    return buildShellPath(entries);
}

export function createBashPolicy(input: BashPolicyInput): SandboxPolicy {
    return createShellPolicy(input, "bash-general");
}

export function createThinkPolicy(input: BashPolicyInput): SandboxPolicy {
    return createShellPolicy(input, "think-strict");
}

function createShellPolicy(
    input: BashPolicyInput,
    name: "bash-general" | "think-strict",
): SandboxPolicy {
    const strictHome = name === "think-strict";
    const privateTmp = strictHome || input.config.tmpNamespace !== "host";
    const hostEnv = input.hostEnv ?? process.env;
    const denied = new Set(input.config.environment.deniedVariables);
    const inherit = unique([
        ...DEFAULT_BASH_INHERITED_VARIABLES,
        ...input.config.environment.allowedVariables,
    ]).filter((name) => !denied.has(name) && !isBackendReservedVariable(name));
    const configuredVariables = Object.fromEntries(
        Object.entries(input.config.environment.variables).filter(
            ([name]) => !denied.has(name) && !isBackendReservedVariable(name),
        ),
    );
    const inheritedVariables = Object.fromEntries(
        inherit.flatMap((name) => {
            const value = hostEnv[name];
            return value === undefined ? [] : [[name, value]];
        }),
    );
    const allow = input.config.network.allowedDomains;
    const allowHost = input.config.network.allowedHostDomains;
    const leaseParent = dirname(input.lease.root);
    const fixedDeniedReadRoots = [
        // --private-tmp mounts the lease over /tmp after filesystem setup.
        // Masking /tmp first makes nested host denies (including Docker sockets)
        // impossible to materialize in bubblewrap's read-only intermediate root.
        "/proc/1/root",
        leaseParent,
        resolve(getAgentDir(), "sandbox.json"),
    ];
    const fixedDeniedWriteRoots = ["/mnt/c", ...fixedDeniedReadRoots];
    const configuredAllowRead = unique(
        input.config.filesystem.allowRead.map((path) =>
            normalizePath(path, input.cwd),
        ),
    );
    const configuredDenyRead = splitDenyPaths(
        input.config.filesystem.denyRead,
        input.cwd,
    );
    const configuredAllowWrite = input.config.filesystem.allowWrite.map(
        (path) => normalizePath(path, input.cwd),
    );
    const configuredDenyWrite = splitDenyPaths(
        input.config.filesystem.denyWrite,
        input.cwd,
    );
    assertNoLogicalPrivateHomeDeny(input.config.filesystem.denyRead, input.cwd);
    assertNoLogicalPrivateHomeDeny(
        input.config.filesystem.denyWrite,
        input.cwd,
    );
    assertAllowsDoNotOverrideDenies(configuredAllowRead, [
        ...configuredDenyRead.exact,
        ...fixedDeniedReadRoots,
    ]);
    assertAllowsDoNotOverrideDenies(configuredAllowWrite, [
        ...configuredDenyRead.exact,
        ...configuredDenyWrite.exact,
        ...fixedDeniedWriteRoots,
    ]);

    return {
        name,
        strict: true,
        tmpNamespace: privateTmp ? "lease-private" : "host",
        filesystem: {
            allowRead: unique([
                ...SHELL_SYSTEM_READ_PATHS,
                ...configuredAllowRead,
                ...(!privateTmp &&
                !configuredDenyRead.exact.some((path) =>
                    isEqualOrDescendant("/tmp", path),
                )
                    ? ["/tmp"]
                    : []),
                input.lease.homeDir,
                input.lease.tmpDir,
                input.lease.proxyRunsDir,
            ]),
            denyRead: unique([
                ...configuredDenyRead.exact,
                ...fixedDeniedReadRoots,
            ]),
            denyReadGlobs: configuredDenyRead.globs,
            allowWrite: unique([
                ...configuredAllowWrite,
                ...(!privateTmp &&
                ![
                    ...configuredDenyRead.exact,
                    ...configuredDenyWrite.exact,
                ].some((path) => isEqualOrDescendant("/tmp", path))
                    ? ["/tmp"]
                    : []),
                input.lease.homeDir,
                input.lease.tmpDir,
            ]),
            denyWrite: unique([
                ...configuredDenyWrite.exact,
                ...fixedDeniedWriteRoots,
            ]),
            denyWriteGlobs: configuredDenyWrite.globs,
        },
        network: {
            mode:
                allow.length === 0 && allowHost.length === 0
                    ? "deny-all"
                    : "domain-allowlist",
            allow,
            allowHost,
            deny: input.config.network.deniedDomains,
            allowLocalBinding: input.config.network.allowLocalBinding,
        },
        environment: {
            inherit,
            set: {
                ...inheritedVariables,
                ...configuredVariables,
                PATH: buildBashPath(input.config.environment.path),
                // Path expansion does not grant any additional filesystem access.
                HOME: SANDBOX_PRIVATE_HOME,
                XDG_CACHE_HOME: resolve(SANDBOX_PRIVATE_HOME, ".cache"),
                BUN_INSTALL_CACHE_DIR: resolve(
                    SANDBOX_PRIVATE_HOME,
                    ".bun/install/cache",
                ),
                npm_config_cache: resolve(SANDBOX_PRIVATE_HOME, ".npm"),
                // Do not load a host Docker context that could override the broker.
                DOCKER_CONFIG: SANDBOX_PRIVATE_HOME,
                TMPDIR: "/tmp",
            },
            deny: input.config.environment.deniedVariables,
        },
        resources:
            name === "bash-general"
                ? input.config.resources
                : { unixSockets: [], tcpPublications: [] },
        docker: input.config.docker,
    };
}

export function createAnalysisPolicy(
    input: AnalysisPolicyInput,
): SandboxPolicy {
    const leaseParent = dirname(input.lease.root);
    return {
        name: "analysis-strict",
        strict: true,
        tmpNamespace: "lease-private",
        filesystem: {
            allowRead: unique([
                ...input.readablePaths.map((path) =>
                    normalizePath(path, input.cwd),
                ),
                input.lease.homeDir,
                input.lease.tmpDir,
            ]),
            // The restricted analysis filesystem needs a /tmp mount point
            // before the backend overlays its private namespace.
            denyRead: ["/tmp", leaseParent],
            denyReadGlobs: [],
            allowWrite: [input.lease.homeDir, input.lease.tmpDir],
            denyWrite: ["/tmp", leaseParent],
            denyWriteGlobs: [],
        },
        network: { mode: "deny-all", allow: [], allowHost: [], deny: [] },
        environment: {
            inherit: [],
            set: {
                PATH: "/usr/local/bin:/usr/bin:/bin",
                HOME: SANDBOX_PRIVATE_HOME,
                TMPDIR: "/tmp",
            },
            deny: [],
        },
        docker: { mode: "disabled" },
        resources: { unixSockets: [], tcpPublications: [] },
    };
}

function networkRuleMatches(
    rule: string,
    hostname: string,
    port: number,
): boolean {
    const parsed = parseNetworkRule(rule);
    const normalizedHostname = hostname.toLowerCase().replace(/^\[|]$/g, "");
    const candidateHost =
        normalizedHostname === "127.0.0.1" || normalizedHostname === "::1"
            ? "localhost"
            : normalizedHostname;
    if (parsed.port !== undefined && parsed.port !== port) return false;
    if (parsed.loopback) return candidateHost === "localhost";
    if (parsed.wildcard) {
        return (
            candidateHost !== parsed.host &&
            candidateHost.endsWith(`.${parsed.host}`)
        );
    }
    return candidateHost === parsed.host;
}

export function isNetworkDestinationAllowed(
    policy: SandboxNetworkPolicy,
    hostname: string,
    port: number,
): boolean {
    if (policy.deny.some((rule) => networkRuleMatches(rule, hostname, port))) {
        return false;
    }
    if (policy.mode === "deny-all") return false;
    return policy.allow.some((rule) =>
        networkRuleMatches(rule, hostname, port),
    );
}
