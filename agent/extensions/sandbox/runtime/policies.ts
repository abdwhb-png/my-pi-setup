import { isIP } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";

import {
    SandboxExecutionError,
    type SandboxDockerPolicy,
    type SandboxLeasePaths,
    type SandboxNetworkPolicy,
    type SandboxPolicy,
} from "./contracts.ts";

export const BASH_SAFE_PATH_SEGMENTS = [
    "~/.pi/bin",
    "~/.bun/bin",
    "~/miniconda3/condabin",
    "~/.local/share/pnpm",
    "~/.cargo/bin",
    "~/.local/bin",
    "~/.config/herd-lite/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    "/home/linuxbrew/.linuxbrew/sbin",
    "/usr/local/go/bin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/usr/sbin",
    "/bin",
    "/sbin",
] as const;

export const DEFAULT_BASH_INHERITED_VARIABLES = [
    "USER",
    "SHELL",
    "TERM",
    "LANG",
    "COLORTERM",
    "NO_COLOR",
] as const;

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
    deniedDomains: string[];
}

interface PiEnvironmentConfig {
    allowedVariables: string[];
    deniedVariables: string[];
    variables: Record<string, string>;
}

export interface PiSandboxConfig {
    enabled?: boolean;
    filesystem: PiFilesystemConfig;
    network: PiNetworkConfig;
    environment: PiEnvironmentConfig;
    docker: SandboxDockerPolicy;
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

export function validatePiSandboxConfig(
    raw: unknown,
    docker: SandboxDockerPolicy = { mode: "disabled" },
): PiSandboxConfig {
    if (!isRecord(raw)) invalid(new Error("Sandbox config must be an object"));
    for (const field of ASRT_ONLY_FIELDS) {
        if (Object.hasOwn(raw, field))
            unsupported(new Error(`ASRT field: ${field}`));
    }
    assertKnownFields(raw, ["enabled", "filesystem", "network", "environment"]);
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
        allowRead: stringArray(filesystem.allowRead, "filesystem.allowRead"),
        denyRead: stringArray(filesystem.denyRead, "filesystem.denyRead"),
        allowWrite: stringArray(filesystem.allowWrite, "filesystem.allowWrite"),
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
        "deniedDomains",
        "allowLocalBinding",
        "allowAllUnixSockets",
    ]);
    if (
        network.allowLocalBinding === true ||
        network.allowAllUnixSockets === true
    ) {
        unsupported(new Error("Inbound or Unix socket access requested"));
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
        allowedDomains: normalizeNetworkRules(
            stringArray(network.allowedDomains, "network.allowedDomains"),
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

    return {
        enabled: raw.enabled as boolean | undefined,
        filesystem: normalizedFilesystem,
        network: normalizedNetwork,
        environment: {
            allowedVariables,
            deniedVariables,
            variables: envVariables(environment.variables),
        },
        docker,
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
    return path === parent || path.startsWith(`${parent}/`);
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

export function buildBashPath(): string {
    return BASH_SAFE_PATH_SEGMENTS.map(expandHome).join(delimiter);
}

export function createBashPolicy(input: BashPolicyInput): SandboxPolicy {
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
    const leaseParent = dirname(input.lease.root);
    const fixedDeniedRoots = [
        "/tmp",
        "/private/tmp",
        "/proc/1/root",
        "/mnt/c",
        leaseParent,
    ];
    const configuredAllowRead =
        input.config.filesystem.allowRead.length > 0
            ? input.config.filesystem.allowRead.map((path) =>
                  normalizePath(path, input.cwd),
              )
            : ["/"];
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
    assertAllowsDoNotOverrideDenies(configuredAllowRead, [
        ...configuredDenyRead.exact,
        ...fixedDeniedRoots,
    ]);
    assertAllowsDoNotOverrideDenies(configuredAllowWrite, [
        ...configuredDenyRead.exact,
        ...configuredDenyWrite.exact,
        ...fixedDeniedRoots,
    ]);

    return {
        name: "bash-general",
        strict: true,
        filesystem: {
            allowRead: unique([
                ...configuredAllowRead,
                input.lease.homeDir,
                input.lease.tmpDir,
                input.lease.proxyRunsDir,
            ]),
            denyRead: unique([
                ...configuredDenyRead.exact,
                ...fixedDeniedRoots,
            ]),
            denyReadGlobs: configuredDenyRead.globs,
            allowWrite: unique([
                ...configuredAllowWrite,
                input.lease.homeDir,
                input.lease.tmpDir,
            ]),
            denyWrite: unique([
                ...configuredDenyWrite.exact,
                ...fixedDeniedRoots,
            ]),
            denyWriteGlobs: configuredDenyWrite.globs,
        },
        network: {
            mode: allow.length === 0 ? "deny-all" : "domain-allowlist",
            allow,
            deny: input.config.network.deniedDomains,
        },
        environment: {
            inherit,
            set: {
                ...inheritedVariables,
                ...configuredVariables,
                PATH: buildBashPath(),
                HOME: input.lease.homeDir,
                TMPDIR: input.lease.tmpDir,
            },
            deny: input.config.environment.deniedVariables,
        },
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
        filesystem: {
            allowRead: unique([
                ...input.readablePaths.map((path) =>
                    normalizePath(path, input.cwd),
                ),
                input.lease.homeDir,
                input.lease.tmpDir,
            ]),
            denyRead: [leaseParent],
            denyReadGlobs: [],
            allowWrite: [input.lease.homeDir, input.lease.tmpDir],
            denyWrite: [leaseParent],
            denyWriteGlobs: [],
        },
        network: { mode: "deny-all", allow: [], deny: [] },
        environment: {
            inherit: [],
            set: {
                PATH: "/usr/local/bin:/usr/bin:/bin",
                HOME: input.lease.homeDir,
                TMPDIR: input.lease.tmpDir,
            },
            deny: [],
        },
        docker: { mode: "disabled" },
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
