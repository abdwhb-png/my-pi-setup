/**
 * Sandbox Extension - OS-level isolation runtime for Bash operations and
 * analysis workers.
 *
 * Uses the managed Zerobox fork to enforce filesystem, network, environment,
 * and process restrictions on Linux. Bash tool registration belongs to the
 * separate bash-execution extension.
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/settings.json under key "sandbox" (global)
 * - <cwd>/.pi/settings.json under key "sandbox" (project-local)
 * - legacy fallback: ~/.pi/agent/sandbox.json and <cwd>/.pi/sandbox.json
 *
 * Example .pi/settings.json:
 * ```json
 * {
 *   "sandbox": {
 *     "enabled": true,
 *     "network": {
 *       "allowedDomains": ["github.com", "*.github.com"],
 *       "deniedDomains": []
 *     },
 *     "filesystem": {
 *       "denyRead": ["~/.ssh", "~/.aws"],
 *       "allowWrite": ["."],
 *       "denyWrite": [".env"]
 *     }
 *   }
 * }
 * ```
 *
 * Usage:
 * - `pi -e ./sandbox` - sandbox enabled with default/config settings
 * - `pi -e ./sandbox --no-sandbox` - disable sandboxing
 * - `/sandbox` - show current sandbox configuration
 *
 * Linux requires the provenance-pinned ~/.pi/bin/zerobox binary, mkfifo,
 * prlimit, and Node with JSPI support for the Python analyzer.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
    SettingsManager,
    withFileMutationQueue,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    type BashOperations,
    getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
    createBashProcessSupervisor,
    type BashProcessSupervisor,
} from "../_shared/command-execution/exec";
import { createWidget } from "../_shared/fancy-footer";
import type { DockerAccessSummary } from "../_shared/sandbox-runtime/docker-summary.ts";
import {
    injectSandboxSystemContext,
    type SandboxModelContextSnapshotV1,
} from "../_shared/sandbox-runtime/execution-context.ts";
import {
    claimSandboxRuntime,
    getSandboxActiveExecutionCount,
    getSandboxRuntime,
    notifySandboxRuntimeUpdated,
    ownsSandboxRuntime,
    publishSandboxRuntime,
    releaseSandboxRuntime,
    whenSandboxRuntimeIdle,
    type SandboxAnalysisRuntime,
    type SandboxBashOperationOptions,
    type SandboxRuntimeSnapshot,
} from "../_shared/sandbox-runtime/index.ts";
import { createUiColors, type UiColorsCreation } from "../_shared/ui/ui-colors";
import {
    createAnalysisSandboxService,
    type AnalysisSandboxService,
} from "./analysis/client.ts";
import {
    capabilityAuthorityPath,
    localMachineId,
    parseShellProfile,
    readCapabilityAuthority,
    type ProjectCapabilities,
    type ShellProfile,
} from "./capabilities/authority.ts";
import { createCapabilityCommands } from "./capabilities/commands.ts";
import {
    resolveShellPolicy,
    shellSandboxFingerprint,
    type ShellCapabilityResolution,
} from "./capabilities/policy.ts";
import { protectsCapabilityAuthority } from "./capabilities/protection.ts";
import {
    activeShellOperations,
    currentShellPolicy,
    formatShellPolicy,
    publishShellRuntime,
    releaseShellRuntime,
} from "./capabilities/runtime.ts";
import {
    inspectDockerAccess,
    formatDockerAccess,
    type DockerTargetAccess,
} from "./docker-access.ts";
import {
    DOCKER_ACCESS_PROFILES,
    dockerSelectorLabel,
    summarizeDockerAccess,
    dockerSummaryLabel,
    formatDockerSummary,
    formatDockerGrantResult,
    formatActiveDocker,
} from "./docker-presentation.ts";
import {
    DOCKER_OPERATIONS,
    SandboxExecutionError,
    type SandboxCommand,
    type SandboxDockerPolicy,
    type DockerTargetGrant,
    type DockerTargetSelector,
} from "./runtime/contracts.ts";
import {
    dockerSelectorKey,
    dockerPolicyHasUnsafeTargets,
    DEFAULT_DOCKER_ENDPOINT,
    resolveDockerPolicy,
    saveTargetedDockerGrant,
} from "./runtime/docker-policy.ts";
import {
    type PiSandboxConfig,
    validatePiSandboxConfig,
} from "./runtime/policies.ts";
import {
    createSandboxService,
    type SandboxService,
} from "./runtime/service.ts";
import { createZeroboxBackend } from "./runtime/zerobox-backend.ts";

/** Footer widget state for the sandbox indicator. */
export type SandboxFooterState =
    | "on"
    | "restricted"
    | "off"
    | "error"
    | "reconfiguring";

export interface SandboxDockerFooterState {
    mode: "off" | "targeted" | "full";
    unsafe: boolean;
    summary?: DockerAccessSummary;
}

/** Shield glyph shown in the footer widget (same metaphor as the bash 🛡️ prefix). */
const SANDBOX_ICON = "🛡️";
const DOCKER_ICON = "🐳";
/** Warning glyph used in the footer widget when sandbox is disabled. */
const OFF_ICON = "⚠️";
const WIDGET_ID = "pi-sandbox";
const DOCKER_BREAK_GLASS_DEFAULT_MINUTES = 5;
const DOCKER_BREAK_GLASS_MIN_MINUTES = 1;
const DOCKER_BREAK_GLASS_MAX_MINUTES = 30;
const DOCKER_BREAK_GLASS_DURATION_USAGE =
    "Docker break-glass duration must be between 1m and 30m. Usage: /sandbox docker break-glass [5m|15m|30m]";
const ANALYSIS_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 300_000] as const;

function parseDockerBreakGlassDurationMinutes(
    value: string | undefined,
): number | undefined {
    if (value === undefined) return DOCKER_BREAK_GLASS_DEFAULT_MINUTES;
    const match = /^(\d+)m$/.exec(value);
    if (!match) return undefined;
    const minutes = Number(match[1]);
    return Number.isSafeInteger(minutes) &&
        minutes >= DOCKER_BREAK_GLASS_MIN_MINUTES &&
        minutes <= DOCKER_BREAK_GLASS_MAX_MINUTES
        ? minutes
        : undefined;
}

/** Return a bounded, path-safe state filename scoped to one public Pi session identity. */
export function sessionStateFilename(sessionId: string): string {
    if (!sessionId) throw new Error("Session id is required");
    const sessionKey = createHash("sha256").update(sessionId).digest("hex");
    return `sandbox-state.${sessionKey}.json`;
}

/** Env var that propagates the parent's sandbox status to spawned subagent children. */
export const ENV_SESSION_STATUS = "PI_SANDBOX_SESSION_STATUS";

/** Which config layer supplied the effective `enabled` flag. */
export type SandboxConfigSource =
    | "env"
    | "session-file"
    | "project-config"
    | "global-config"
    | "default";

/** Result of resolving `loadSandboxConfig` for one session. */
export interface LoadSandboxConfigResult {
    config: SandboxConfig;
    source: SandboxConfigSource;
    shell: ShellCapabilityResolution;
}

/** True when the resolved status came from any explicit source and disabled. */
export function explicitlyDisabled(result: LoadSandboxConfigResult): boolean {
    return result.source !== "default" && result.config.enabled === false;
}

/**
 * Read `PI_SANDBOX_SESSION_STATUS` and return a normalized status, or undefined.
 * Accepts `enabled` / `disabled` (case-insensitive); any other value is rejected.
 */
export function envSandboxStatus(): "enabled" | "disabled" | undefined {
    const raw = process.env[ENV_SESSION_STATUS];
    if (raw === undefined) return undefined;
    const normalized = raw.trim().toLowerCase();
    if (normalized === "enabled") return "enabled";
    if (normalized === "disabled") return "disabled";
    return undefined;
}

/**
 * Read `<sessionDir>/sandbox-state.<sessionKey>.json` and return the persisted status.
 * The old directory-wide `sandbox-state.json` is intentionally ignored because it
 * cannot be attributed safely to any one session.
 * Returns undefined when the file is missing, malformed, or its payload is invalid.
 */
export function loadSessionSandboxStatus(
    sessionDir: string,
    sessionId: string,
): "enabled" | "disabled" | undefined {
    if (!sessionDir || !sessionId) return undefined;
    const file = join(sessionDir, sessionStateFilename(sessionId));
    if (!existsSync(file)) return undefined;
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
        return undefined;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const enabled = (raw as { enabled?: unknown }).enabled;
    if (enabled === true) return "enabled";
    if (enabled === false) return "disabled";
    return undefined;
}

/**
 * Atomically persist the session's sandbox status to
 * `<sessionDir>/sandbox-state.<sessionKey>.json`.
 * Writes to a temp file in the same directory and renames over the target.
 * Best-effort: returns silently on a missing identity or write failure (logged to stderr).
 */
export function saveSessionSandboxStatus(
    sessionDir: string,
    sessionId: string,
    status: "enabled" | "disabled",
): void {
    if (!sessionDir || !sessionId) return;
    const body = JSON.stringify(
        {
            enabled: status === "enabled",
            updatedAt: new Date().toISOString(),
        },
        null,
        2,
    );
    try {
        const filename = sessionStateFilename(sessionId);
        const file = join(sessionDir, filename);
        const tmp = join(sessionDir, `.${filename}.tmp`);
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(tmp, body);
        renameSync(tmp, file);
    } catch (error) {
        console.error(`saveSessionSandboxStatus: ${errorMessage(error)}`);
    }
}

/**
 * Pure render for the sandbox footer widget.
 *
 * Returns a pre-themed composite string: a dim label (`🛡️ sandbox:`) followed
 * by the status value colored by severity (accent / warning / danger). Hidden
 * (null) when the sandbox is off. The widget contribution sets `styled: true`
 * so pi-fancy-footer uses this string verbatim instead of re-wrapping it.
 */
export function renderSandboxWidget(
    theme: import("@earendil-works/pi-coding-agent").Theme,
    state: SandboxFooterState,
    docker: SandboxDockerFooterState = { mode: "off", unsafe: false },
): string | null {
    const colors: UiColorsCreation = createUiColors(theme);
    const dockerLabel = colors.subtle(`${DOCKER_ICON}docker:`);
    const dockerValue = colorForDockerState(colors, docker);
    if (state === "off") {
        return `${colors.subtle(`${OFF_ICON}sandbox:`)} ${colors.warning(state)} ${dockerLabel} ${dockerValue}`;
    }
    const label = colors.subtle(`${SANDBOX_ICON}sandbox:`);
    const value = colorForState(colors, state);
    return `${label} ${value} ${dockerLabel} ${dockerValue}`;
}

function colorForDockerState(
    colors: UiColorsCreation,
    state: SandboxDockerFooterState,
): string {
    const value =
        state.mode === "full"
            ? "full · host control"
            : state.summary
              ? dockerSummaryLabel(state.summary)
              : `${state.mode}${state.unsafe ? " · host-access exception" : ""}`;
    if (state.mode === "full") return colors.danger(value);
    if (state.mode === "targeted") {
        return state.unsafe ? colors.warning(value) : colors.primary(value);
    }
    return colors.subtle(value);
}

export function dockerFooterState(
    policy: SandboxDockerPolicy,
    sandboxActive = true,
): SandboxDockerFooterState {
    if (!sandboxActive || policy.mode === "disabled") {
        return { mode: "off", unsafe: false };
    }
    if (policy.mode === "full") return { mode: "full", unsafe: true };
    return {
        mode: "targeted",
        unsafe: dockerPolicyHasUnsafeTargets(policy),
        summary: summarizeDockerAccess(policy),
    };
}

/** Show configured and active rights without exposing Engine credentials. */
export function renderSandboxStatusDetails(
    resolved: LoadSandboxConfigResult,
    sandboxActive: boolean,
    activeDocker?: DockerAccessSummary,
    runtimeState?: string,
): string {
    const { config, source } = resolved;
    const status = sandboxActive ? "ENABLED" : "DISABLED";
    const securityLabel = explicitlyDisabled(resolved) ? `${status} ⚠` : status;
    const dockerStatus = sandboxActive
        ? config.docker.mode === "disabled"
            ? "off"
            : config.docker.mode
        : "off (sandbox disabled)";
    const lines = [
        `Sandbox: ${securityLabel}`,
        `Source: ${source}`,
        formatShellPolicy(resolved.shell),
        "",
        "Network:",
        `  Allowed: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
        `  Host-local: ${config.network?.allowedHostDomains?.join(", ") || "(none)"}`,
        `  Denied: ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
        "",
        `Docker: ${dockerStatus}`,
        ...formatDockerSummary(
            "Configured Docker",
            summarizeDockerAccess(config.docker),
        ),
        ...(runtimeState
            ? formatActiveDocker(
                  summarizeDockerAccess(config.docker),
                  activeDocker,
                  runtimeState,
              )
            : []),
        ...(sandboxActive && config.docker.mode === "full"
            ? ["  Warning: full Docker access is equivalent to host control."]
            : []),
        "",
        "Filesystem:",
        `  Deny Read: ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
        `  Allow Write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
        `  Deny Write: ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
        "",
        "Use /sandbox profile isolated|integrated|host. The on/off aliases select isolated/host.",
        "Shell: ! <command> selected profile; !! <command> selected profile outside model context; !s <command> Sandbox; !!s <command> Sandbox outside model context.",
        "!s without a command fails closed and does not fall back to the host.",
    ];
    return lines.join("\n");
}

function colorForState(
    colors: UiColorsCreation,
    state: Exclude<SandboxFooterState, "off">,
): string {
    switch (state) {
        case "on":
            return colors.primary(state);
        case "restricted":
        case "reconfiguring":
            return colors.warning(state);
        case "error":
            return colors.danger(state);
    }
}

function getActiveDockerSummary(): DockerAccessSummary | undefined {
    const runtime = getSandboxRuntime();
    return runtime.state === "enabled" ? runtime.dockerAccess : undefined;
}

function activeDockerLines(configured: SandboxDockerPolicy): string[] {
    const runtime = getSandboxRuntime();
    return formatActiveDocker(
        summarizeDockerAccess(configured),
        runtime.state === "enabled" ? runtime.dockerAccess : undefined,
        runtime.state,
    );
}

export interface SandboxConfig extends PiSandboxConfig {}

const DEFAULT_CONFIG: SandboxConfig = {
    enabled: true,
    network: {
        allowLocalBinding: true,
        allowedHostDomains: [],
        allowedDomains: [],
        deniedDomains: [],
    },
    filesystem: {
        allowRead: [],
        denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
        allowWrite: ["."],
        denyWrite: [".env"],
    },
    environment: {
        allowedVariables: [],
        deniedVariables: [],
        variables: {},
    },
    docker: { mode: "disabled" },
};

type SandboxConfigLayer = Partial<Omit<SandboxConfig, "docker">> & {
    docker?: unknown;
    profile?: ShellProfile;
    integrations?: string[];
};

interface SandboxSettingsContainer {
    sandbox?: unknown;
}

export type DockerProjectPreference = "inherit" | "off" | "targeted" | "full";

interface SandboxSettingsReader {
    getGlobalSettings(): SandboxSettingsContainer;
    getProjectSettings(): SandboxSettingsContainer;
}

export interface LoadSandboxConfigOptions {
    agentDir?: string;
    settingsManager?: SandboxSettingsReader;
    /** Session directory containing the state file for `sessionId`. */
    sessionDir?: string;
    /** Public Pi session identity used to isolate state inside a shared session directory. */
    sessionId?: string;
    /** Explicit status override (e.g. from `PI_SANDBOX_SESSION_STATUS`); takes priority over the session file. */
    envOverride?: "enabled" | "disabled";
    /** Read legacy sandbox.json files when settings do not define Sandbox. */
    includeLegacy?: boolean;
    projectTrusted?: boolean;
    machineId?: string;
    sessionCapabilities?: ProjectCapabilities;
    profile?: ShellProfile;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function configurationErrorMessage(error: unknown): string {
    if (error instanceof SandboxExecutionError) {
        const cause = error.getCause();
        if (cause !== undefined) return errorMessage(cause);
    }
    return errorMessage(error);
}

interface ComposeProject {
    project: string;
    services: string[];
}

class DockerComposeUnavailableError extends Error {}

// oxlint-disable-next-line typescript/no-restricted-types -- Docker Compose JSON is untrusted until this function validates it.
function composeRecord(value: unknown, field: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`Docker Compose ${field} must be an object`);
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- object shape was checked above; fields remain untrusted until read.
    return value as Record<string, unknown>;
}

function parseDockerComposeConfig(output: string): ComposeProject {
    // oxlint-disable-next-line typescript/no-restricted-types -- JSON.parse returns untrusted data.
    let parsed: unknown;
    try {
        parsed = JSON.parse(output);
    } catch (error) {
        throw new Error(
            `Docker Compose returned invalid JSON: ${errorMessage(error)}`,
            { cause: error },
        );
    }
    const config = composeRecord(parsed, "configuration");
    if (
        typeof config.name !== "string" ||
        config.name.trim() !== config.name ||
        !config.name
    ) {
        throw new Error("Docker Compose configuration has no project name");
    }
    const services = composeRecord(config.services, "services");
    const names = Object.keys(services).toSorted();
    if (names.length === 0) {
        throw new Error("Docker Compose configuration has no services");
    }
    return { project: config.name, services: names };
}

async function discoverDockerComposeProject(
    cwd: string,
): Promise<ComposeProject> {
    return new Promise((resolveProject, rejectProject) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const settle = (callback: () => void) => {
            if (settled) return;
            settled = true;
            callback();
        };
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn("docker", ["compose", "config", "--format", "json"], {
                cwd,
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (error) {
            rejectProject(
                new DockerComposeUnavailableError(
                    `Docker Compose is unavailable: ${errorMessage(error)}`,
                    { cause: error },
                ),
            );
            return;
        }
        const stdoutStream = child.stdout;
        const stderrStream = child.stderr;
        if (stdoutStream === null || stderrStream === null) {
            child.kill();
            rejectProject(
                new DockerComposeUnavailableError(
                    "Docker Compose did not provide output streams",
                ),
            );
            return;
        }
        stdoutStream.on("data", (chunk: Buffer) => {
            if (stdout.length + chunk.length <= 1_000_000)
                stdout += chunk.toString();
        });
        stderrStream.on("data", (chunk: Buffer) => {
            if (stderr.length + chunk.length <= 8_000)
                stderr += chunk.toString();
        });
        child.on("error", (error) =>
            settle(() =>
                rejectProject(
                    new DockerComposeUnavailableError(
                        `Docker Compose is unavailable: ${errorMessage(error)}`,
                        { cause: error },
                    ),
                ),
            ),
        );
        child.on("close", (code) =>
            settle(() => {
                if (code !== 0) {
                    rejectProject(
                        new DockerComposeUnavailableError(
                            `Docker Compose is unavailable${stderr ? `: ${stderr.trim()}` : ""}`,
                        ),
                    );
                    return;
                }
                try {
                    resolveProject(parseDockerComposeConfig(stdout));
                } catch (error) {
                    rejectProject(error);
                }
            }),
        );
    });
}

async function selectDockerTarget(
    ctx: ExtensionContext,
): Promise<DockerTargetSelector | undefined> {
    try {
        const compose = await discoverDockerComposeProject(ctx.cwd);
        const choices = compose.services.map(
            (service) => `${compose.project} / ${service}`,
        );
        const selected = await ctx.ui.select(
            "Docker Compose service to authorize",
            choices,
        );
        if (selected === undefined) return undefined;
        const service = compose.services[choices.indexOf(selected)];
        if (service === undefined) return undefined;
        return { type: "compose-service", project: compose.project, service };
    } catch (error) {
        if (!(error instanceof DockerComposeUnavailableError)) throw error;
        const name = await ctx.ui.input(
            "Docker container to authorize",
            "Container name",
        );
        const normalized = name?.trim();
        if (!normalized) return undefined;
        return { type: "container-name", name: normalized };
    }
}

function renderDockerGrantDiff(cwd: string, grant: DockerTargetGrant): string {
    return [
        `Project: ${cwd}`,
        ...formatDockerSummary(
            "Proposed Docker grant",
            summarizeDockerAccess({
                mode: "targeted",
                endpoint: DEFAULT_DOCKER_ENDPOINT,
                targets: [grant],
            }),
        ),
        "This replaces the Docker grant for this project only.",
    ].join("\n");
}

interface DockerBreakGlassCandidate {
    target: DockerTargetGrant;
    access: DockerTargetAccess;
    container: DockerTargetAccess["containers"][number];
}

function dockerBreakGlassCandidates(
    policy: Extract<SandboxDockerPolicy, { mode: "targeted" }>,
    access: DockerTargetAccess[],
): DockerBreakGlassCandidate[] {
    const targets = new Map(
        policy.targets
            .filter(
                (target) =>
                    target.selector.type !== "ephemeral-container" &&
                    target.allowUnsafeTarget &&
                    (target.operations ?? DOCKER_OPERATIONS).includes("exec"),
            )
            .map((target) => [dockerSelectorKey(target.selector), target]),
    );
    return access.flatMap((targetAccess) => {
        const target = targets.get(dockerSelectorKey(targetAccess.selector));
        if (!target) return [];
        return targetAccess.containers
            .filter((container) => container.access === "accessible")
            .map((container) => ({
                target,
                access: {
                    selector: targetAccess.selector,
                    containers: [container],
                },
                container,
            }));
    });
}

function normalizeConfig(raw: unknown, source: string): SandboxConfigLayer {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(`Invalid ${source}`);
    }
    return raw as SandboxConfigLayer;
}

function readSettingsConfig(
    settings: SandboxSettingsContainer,
    source: "global" | "project",
): SandboxConfigLayer {
    const raw = settings.sandbox;
    return raw === undefined
        ? {}
        : normalizeConfig(raw, `${source} sandbox settings`);
}

function dockerOverrideForPreference(
    preference: DockerProjectPreference,
): { mode: "disabled" | "targeted" | "full" } | undefined {
    if (preference === "inherit") return undefined;
    return { mode: preference === "off" ? "disabled" : preference };
}

function parseDockerProjectPreference(
    value: string,
): DockerProjectPreference | undefined {
    if (
        value === "off" ||
        value === "targeted" ||
        value === "full" ||
        value === "inherit"
    ) {
        return value;
    }
    return undefined;
}

function configuredDockerPreference(
    config: SandboxConfigLayer,
): DockerProjectPreference {
    const docker = config.docker;
    if (
        typeof docker !== "object" ||
        docker === null ||
        Array.isArray(docker)
    ) {
        return "inherit";
    }
    if (!("mode" in docker)) return "inherit";
    const mode = docker.mode;
    if (mode === "disabled") return "off";
    if (mode === "targeted" || mode === "full") return mode;
    return "inherit";
}

/** Persist a validated Docker narrowing in project-local Pi settings. */
export async function persistProjectDockerPreference(
    cwd: string,
    preference: DockerProjectPreference,
    agentDir = getAgentDir(),
): Promise<LoadSandboxConfigResult> {
    const settingsPath = join(cwd, ".pi", "settings.json");
    return withFileMutationQueue(settingsPath, async () => {
        const current = existsSync(settingsPath)
            ? readFileSync(settingsPath, "utf8")
            : undefined;
        const parsed: unknown =
            current === undefined ? {} : JSON.parse(current);
        if (
            typeof parsed !== "object" ||
            parsed === null ||
            Array.isArray(parsed)
        ) {
            throw new Error("Invalid project settings");
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validated JSON object boundary.
        const projectSettings = parsed as Record<string, unknown>;
        const currentSandbox =
            projectSettings.sandbox === undefined
                ? readLegacyConfig(join(cwd, ".pi", "sandbox.json"))
                : normalizeConfig(
                      projectSettings.sandbox,
                      "project sandbox settings",
                  );
        const nextSandbox: Record<string, unknown> = { ...currentSandbox };
        const docker = dockerOverrideForPreference(preference);
        if (docker === undefined) delete nextSandbox.docker;
        else nextSandbox.docker = docker;

        const nextSettings = {
            ...projectSettings,
            sandbox: nextSandbox,
        };
        const settingsManager = SettingsManager.create(cwd, agentDir);
        const resolved = loadSandboxConfig(cwd, {
            agentDir,
            settingsManager: {
                getGlobalSettings: () =>
                    // SAFETY: Pi settings permit extension-owned keys absent from its generic Settings type.
                    settingsManager.getGlobalSettings() as unknown as SandboxSettingsContainer,
                getProjectSettings: () => nextSettings,
            },
        });
        const temporaryPath = join(
            cwd,
            ".pi",
            `.settings.json.${process.pid}.${randomUUID()}.tmp`,
        );
        mkdirSync(join(cwd, ".pi"), { recursive: true });
        try {
            writeFileSync(
                temporaryPath,
                JSON.stringify(nextSettings, null, 2),
                {
                    encoding: "utf8",
                    mode: 0o600,
                },
            );
            renameSync(temporaryPath, settingsPath);
        } catch (error) {
            if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
            throw error;
        }
        return resolved;
    });
}

function readLegacyConfig(path: string): SandboxConfigLayer {
    if (!existsSync(path)) return {};
    try {
        return normalizeConfig(
            JSON.parse(readFileSync(path, "utf-8")),
            `sandbox config: ${path}`,
        );
    } catch (error) {
        throw new Error(
            `Could not parse sandbox config ${path}: ${errorMessage(error)}`,
            { cause: error },
        );
    }
}

export function loadSandboxConfig(
    cwd: string,
    options: LoadSandboxConfigOptions = {},
): LoadSandboxConfigResult {
    const projectConfigPath = join(cwd, ".pi", "sandbox.json");
    const globalConfigPath = join(
        options.agentDir ?? getAgentDir(),
        "sandbox.json",
    );
    const globalAuthorityPath = join(
        options.agentDir ?? getAgentDir(),
        "sandbox.global.json",
    );

    let globalSettings: SandboxSettingsContainer;
    let projectSettings: SandboxSettingsContainer;
    try {
        if (options.settingsManager) {
            globalSettings = options.settingsManager.getGlobalSettings();
            projectSettings = options.settingsManager.getProjectSettings();
        } else {
            const manager = SettingsManager.create(cwd);
            // SAFETY: SettingsManager supports extension-owned keys not declared by its generic Settings type.
            globalSettings =
                manager.getGlobalSettings() as unknown as SandboxSettingsContainer;
            // SAFETY: SettingsManager supports extension-owned keys not declared by its generic Settings type.
            projectSettings =
                manager.getProjectSettings() as unknown as SandboxSettingsContainer;
        }
    } catch (error) {
        throw new Error(
            `Could not load sandbox settings: ${errorMessage(error)}`,
            { cause: error },
        );
    }

    const hasGlobalSettings = globalSettings.sandbox !== undefined;
    const hasProjectSettings = projectSettings.sandbox !== undefined;
    let globalConfig = readSettingsConfig(globalSettings, "global");
    let projectConfig = readSettingsConfig(projectSettings, "project");
    if (!hasGlobalSettings && options.includeLegacy !== false) {
        globalConfig = readLegacyConfig(globalConfigPath);
    }
    if (!hasProjectSettings && options.includeLegacy !== false) {
        projectConfig = readLegacyConfig(projectConfigPath);
    }
    if (options.projectTrusted === false) projectConfig = {};

    if (globalConfig.docker !== undefined) {
        throw new SandboxExecutionError("invalid-policy", {
            cause: new Error(
                "Global Docker authority belongs in sandbox.global.json",
            ),
        });
    }
    const projectDockerOverride = projectConfig.docker;
    const { docker: _globalDocker, ...globalBaseConfig } = globalConfig;
    const { docker: _projectDocker, ...projectBaseConfig } = projectConfig;

    const merged = deepMerge(
        deepMerge(DEFAULT_CONFIG, globalBaseConfig),
        projectBaseConfig,
    );

    let source: SandboxConfigSource;
    if (projectBaseConfig.enabled === undefined) {
        if (globalBaseConfig.enabled === undefined) {
            source = "default";
        } else {
            source = "global-config";
        }
    } else {
        source = "project-config";
    }

    if (options.envOverride !== undefined) {
        source = "env";
        merged.enabled = options.envOverride === "enabled";
    } else if (options.sessionDir && options.sessionId) {
        const sessionStatus = loadSessionSandboxStatus(
            options.sessionDir,
            options.sessionId,
        );
        if (sessionStatus !== undefined) {
            source = "session-file";
            merged.enabled = sessionStatus === "enabled";
        }
    }

    const docker = resolveDockerPolicy({
        cwd,
        globalConfigPath: globalAuthorityPath,
        projectOverride: projectDockerOverride,
    });
    const { docker: _defaultDocker, ...mergedBaseConfig } = merged;
    const authorityPath = capabilityAuthorityPath(
        options.agentDir ?? getAgentDir(),
    );
    const machineId = options.machineId ?? localMachineId();
    const authority = readCapabilityAuthority(authorityPath, machineId);
    const saved =
        authority.machineId === machineId
            ? authority.projects.find(
                  (p) => p.projectRoot === realpathSync(cwd),
              )
            : undefined;
    const requestedProfile =
        options.profile ??
        options.sessionCapabilities?.profile ??
        saved?.profile ??
        globalConfig.profile ??
        (merged.enabled === false ? "host" : undefined);
    const policy = resolveShellPolicy({
        cwd,
        config: validatePiSandboxConfig(mergedBaseConfig, docker),
        authority,
        authorityPath,
        machineId,
        requestedProfile:
            requestedProfile === undefined
                ? undefined
                : parseShellProfile(requestedProfile),
        projectProfile:
            projectConfig.profile === undefined
                ? undefined
                : parseShellProfile(projectConfig.profile),
        session: options.sessionCapabilities,
        hasLegacySettings: [globalConfig, projectConfig].some((layer) =>
            Object.keys(layer).some(
                (key) =>
                    !["profile", "integrations", "tmpNamespace"].includes(key),
            ),
        ),
        domainsRequested:
            globalConfig.network?.allowedDomains !== undefined ||
            projectConfig.network?.allowedDomains !== undefined,
        hostDomainsRequested:
            globalConfig.network?.allowedHostDomains !== undefined ||
            projectConfig.network?.allowedHostDomains !== undefined,
        tmpRequested:
            (projectConfig.tmpNamespace ?? globalConfig.tmpNamespace) === "host"
                ? "host"
                : (projectConfig.tmpNamespace ?? globalConfig.tmpNamespace) ===
                    "lease-private"
                  ? "private"
                  : undefined,
        integrationsRequested:
            projectConfig.integrations ?? globalConfig.integrations,
        writePathsRequested:
            projectConfig.filesystem?.allowWrite !== undefined ||
            globalConfig.filesystem?.allowWrite !== undefined,
    });
    return { ...policy, config: { ...policy.config, enabled: true }, source };
}

function deepMerge(
    base: SandboxConfig,
    overrides: SandboxConfigLayer,
): SandboxConfig {
    const result: SandboxConfig = { ...base };

    if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
    if (overrides.network) {
        result.network = { ...base.network, ...overrides.network };
        result.network.deniedDomains = [
            ...new Set([
                ...base.network.deniedDomains,
                ...(overrides.network.deniedDomains ?? []),
            ]),
        ];
    }
    if (overrides.filesystem) {
        result.filesystem = { ...base.filesystem, ...overrides.filesystem };
        result.filesystem.denyRead = [
            ...new Set([
                ...base.filesystem.denyRead,
                ...(overrides.filesystem.denyRead ?? []),
            ]),
        ];
        result.filesystem.denyWrite = [
            ...new Set([
                ...base.filesystem.denyWrite,
                ...(overrides.filesystem.denyWrite ?? []),
            ]),
        ];
    }
    if (overrides.environment) {
        result.environment = { ...base.environment, ...overrides.environment };
    }
    if (overrides.tmpNamespace !== undefined)
        result.tmpNamespace = overrides.tmpNamespace;

    return result;
}

export function createSandboxedBashOps(
    service: SandboxService,
    supervisor: BashProcessSupervisor,
    options: SandboxBashOperationOptions = {},
    profile: "bash-general" | "think-strict" = "bash-general",
): BashOperations {
    return supervisor.createOperations({
        onExecution: options.onExecution,
        execution: {
            status: "unknown",
            profile,
            backend: "zerobox",
            tmpNamespace: "unknown",
            phase: "setup",
            outcome: "pending",
        },
        stdin: options.stdin,
        detached: true,
        rewriteCommand: options.rewriteCommand,
        prepareSpawn: async ({ command, cwd }) => {
            const sandboxCommand: SandboxCommand = {
                file: "/bin/bash",
                args: ["-o", "pipefail", "-c", command],
                cwd,
                stdin: options.stdin,
            };
            const spawn = await (profile === "think-strict"
                ? service.prepareThinkBash(sandboxCommand)
                : service.prepareBash(sandboxCommand));
            if (spawn.sandboxContext) {
                options.onSandboxContext?.(spawn.sandboxContext);
            }
            return spawn;
        },
    });
}

export default function (pi: ExtensionAPI) {
    const runtimeOwner = Symbol("sandbox-extension-owner");
    const bashProcessSupervisor = createBashProcessSupervisor();
    claimSandboxRuntime(runtimeOwner);
    pi.on("tool_call", (event, ctx) => {
        if (event.toolName !== "write" && event.toolName !== "edit") return;
        const path = event.input.path;
        if (
            typeof path === "string" &&
            protectsCapabilityAuthority(
                path,
                ctx.cwd,
                capabilityAuthorityPath(getAgentDir()),
            )
        ) {
            return {
                block: true,
                reason: "Local capability authority can only be changed through an explicit user /sandbox capabilities command.",
            };
        }
    });
    let breakGlassExpiryTimer: ReturnType<typeof setTimeout> | undefined;

    const clearBreakGlassExpiry = (): void => {
        if (breakGlassExpiryTimer !== undefined) {
            clearTimeout(breakGlassExpiryTimer);
            breakGlassExpiryTimer = undefined;
        }
    };

    let transitionGeneration = 0;
    let analysisRetryTimer: ReturnType<typeof setTimeout> | undefined;
    let analysisRetryAttempt = 0;
    let analysisAttemptGeneration: number | undefined;

    const sendSandboxRuntimeFeedback = (
        ctx: ExtensionContext,
        content: string,
    ): void => {
        try {
            pi.sendMessage(
                {
                    customType: "sandbox-runtime-feedback",
                    content,
                    display: false,
                },
                { deliverAs: "steer" },
            );
        } catch (error) {
            ctx.ui.notify(
                `Sandbox could not notify the agent: ${errorMessage(error)}`,
                "warning",
            );
        }
    };

    const clearAnalysisRecovery = (): void => {
        if (analysisRetryTimer !== undefined) {
            clearTimeout(analysisRetryTimer);
            analysisRetryTimer = undefined;
        }
        analysisRetryAttempt = 0;
        analysisAttemptGeneration = undefined;
    };

    const beginTransition = (
        ctx?: ExtensionContext,
        initial = false,
        drain = false,
    ): number | undefined => {
        clearBreakGlassExpiry();
        clearAnalysisRecovery();
        transitionGeneration += 1;
        const generation = transitionGeneration;
        const published = publishSandboxRuntime(
            runtimeOwner,
            {
                state: initial ? "uninitialized" : "reconfiguring",
            },
            undefined,
            drain ? "drain" : "interrupt",
        );
        if (!published) return undefined;
        if (ctx && !initial && !drain) {
            const interruptedExecutions =
                getSandboxActiveExecutionCount(runtimeOwner);
            if (interruptedExecutions > 0) {
                const interruption =
                    interruptedExecutions === 1
                        ? "1 running Sandbox execution was interrupted and was not retried"
                        : `${interruptedExecutions} running Sandbox executions were interrupted and were not retried`;
                sendSandboxRuntimeFeedback(
                    ctx,
                    `Sandbox reconfiguration started. ${interruption}. Do not assume interrupted commands completed; retry them only after the new runtime is active and only if they are still needed.`,
                );
            }
        }
        if (ctx && !initial) updateSandboxStatus(ctx, "reconfiguring");
        return generation;
    };
    const isCurrentTransition = (generation: number): boolean =>
        transitionGeneration === generation;
    const publishError = (error: unknown) =>
        publishSandboxRuntime(
            runtimeOwner,
            { state: "error" },
            error instanceof Error ? error.message : String(error),
        );
    let sandboxService: SandboxService | null = null;
    let analysisService: AnalysisSandboxService | null = null;
    const pendingSandboxCleanup = new Set<SandboxService>();
    const pendingAnalysisCleanup = new Set<AnalysisSandboxService>();
    const inFlightSandboxCandidates = new Set<SandboxService>();
    const inFlightAnalysisCandidates = new Set<AnalysisSandboxService>();
    const serviceSnapshots = new Map<SandboxService, SandboxRuntimeSnapshot>();
    const retiredSandbox = new Set<SandboxService>();
    const retiredAnalysis = new Set<AnalysisSandboxService>();

    const createCleanupCoordinator = <T extends { shutdown(): Promise<void> }>(
        pending: Set<T>,
        inFlight: Set<T>,
    ) => {
        const running = new Map<T, Promise<void>>();
        return (service: T): Promise<void> => {
            const existing = running.get(service);
            if (existing) return existing;
            inFlight.delete(service);
            pending.add(service);
            const cleanup = Promise.resolve()
                .then(() => service.shutdown())
                .then(() => {
                    pending.delete(service);
                });
            running.set(service, cleanup);
            void cleanup.then(
                () => running.delete(service),
                () => running.delete(service),
            );
            return cleanup;
        };
    };
    const cleanupSandboxService = createCleanupCoordinator(
        pendingSandboxCleanup,
        inFlightSandboxCandidates,
    );
    const cleanupAnalysisService = createCleanupCoordinator(
        pendingAnalysisCleanup,
        inFlightAnalysisCandidates,
    );

    const attachCleanupFailure = (primary: unknown, cleanup: unknown): void => {
        if (primary instanceof SandboxExecutionError) {
            primary.attachCleanupError(cleanup);
        } else if (primary instanceof Error) {
            Object.defineProperty(primary, "cleanupError", {
                configurable: true,
                enumerable: false,
                value: cleanup,
            });
        }
    };

    const shutdownServices = async (
        excludedSandbox?: SandboxService,
        excludedAnalysis?: AnalysisSandboxService,
        includeRetired = false,
    ): Promise<void> => {
        const currentSandbox = sandboxService;
        const currentAnalysis = analysisService;
        const analysisTargets = [
            ...new Set([
                ...pendingAnalysisCleanup,
                ...inFlightAnalysisCandidates,
                ...(currentAnalysis ? [currentAnalysis] : []),
                ...(includeRetired ? retiredAnalysis : []),
            ]),
        ].filter(
            (service) =>
                service !== excludedAnalysis &&
                (includeRetired || !retiredAnalysis.has(service)),
        );
        const sandboxTargets = [
            ...new Set([
                ...pendingSandboxCleanup,
                ...inFlightSandboxCandidates,
                ...(currentSandbox ? [currentSandbox] : []),
                ...(includeRetired ? retiredSandbox : []),
            ]),
        ].filter(
            (service) =>
                service !== excludedSandbox &&
                (includeRetired || !retiredSandbox.has(service)),
        );
        const [analysisResults, sandboxResults] = await Promise.all([
            Promise.allSettled(analysisTargets.map(cleanupAnalysisService)),
            Promise.allSettled(sandboxTargets.map(cleanupSandboxService)),
        ]);
        let failure: unknown;
        analysisResults.forEach((result) => {
            if (result.status === "rejected" && failure === undefined) {
                failure = result.reason;
            } else if (result.status === "rejected") {
                attachCleanupFailure(failure, result.reason);
            }
        });
        sandboxResults.forEach((result) => {
            if (result.status === "rejected" && failure === undefined) {
                failure = result.reason;
            } else if (result.status === "rejected") {
                attachCleanupFailure(failure, result.reason);
            }
        });
        if (
            currentAnalysis &&
            !pendingAnalysisCleanup.has(currentAnalysis) &&
            analysisResults[analysisTargets.indexOf(currentAnalysis)]
                ?.status === "fulfilled"
        ) {
            if (analysisService === currentAnalysis) analysisService = null;
        }
        if (
            currentSandbox &&
            !pendingSandboxCleanup.has(currentSandbox) &&
            sandboxResults[sandboxTargets.indexOf(currentSandbox)]?.status ===
                "fulfilled"
        ) {
            if (sandboxService === currentSandbox) sandboxService = null;
        }
        if (failure !== undefined) throw failure;
    };

    const cleanupSandboxCandidate = async (
        candidate: SandboxService,
    ): Promise<void> => {
        if (
            !inFlightSandboxCandidates.has(candidate) &&
            !pendingSandboxCleanup.has(candidate)
        ) {
            return;
        }
        await cleanupSandboxService(candidate);
    };

    const startAnalysisAttempt = (
        ctx: ExtensionContext,
        generation: number,
        availability: SandboxAnalysisRuntime,
    ): void => {
        if (
            !isCurrentTransition(generation) ||
            analysisAttemptGeneration === generation
        ) {
            return;
        }
        const candidate = createAnalysisSandboxService();
        analysisAttemptGeneration = generation;
        inFlightAnalysisCandidates.add(candidate);

        void (async () => {
            try {
                await candidate.preflight();
                if (
                    !isCurrentTransition(generation) ||
                    sandboxService === null
                ) {
                    await cleanupAnalysisService(candidate).catch(() => {
                        // The next transition retries retained cleanup.
                    });
                    return;
                }
                analysisService = candidate;
                inFlightAnalysisCandidates.delete(candidate);
                availability.state = "ready";
                availability.service = candidate;
                delete availability.diagnostic;
                analysisRetryAttempt = 0;
                notifySandboxRuntimeUpdated(runtimeOwner);
            } catch (error) {
                await cleanupAnalysisService(candidate).catch(() => {
                    // Analysis cleanup must not disable a healthy Bash runtime.
                });
                if (!isCurrentTransition(generation)) return;
                availability.state = "retrying";
                delete availability.service;
                availability.diagnostic =
                    error instanceof Error ? error.message : String(error);
                ctx.ui.notify(
                    "Analysis indisponible, réessai en cours",
                    "warning",
                );
                const delay =
                    ANALYSIS_RETRY_DELAYS_MS[
                        Math.min(
                            analysisRetryAttempt,
                            ANALYSIS_RETRY_DELAYS_MS.length - 1,
                        )
                    ];
                analysisRetryAttempt += 1;
                analysisRetryTimer = setTimeout(() => {
                    analysisRetryTimer = undefined;
                    startAnalysisAttempt(ctx, generation, availability);
                }, delay);
                analysisRetryTimer.unref?.();
            } finally {
                if (analysisAttemptGeneration === generation) {
                    analysisAttemptGeneration = undefined;
                }
            }
        })();
    };

    const enableServices = async (
        cwd: string,
        config: SandboxConfig,
        generation: number,
        ctx: ExtensionContext,
        drain = false,
    ): Promise<boolean> => {
        const candidateSandbox = createSandboxService({
            backend: createZeroboxBackend(),
            config,
        });
        inFlightSandboxCandidates.add(candidateSandbox);
        const abandonStaleCandidate = async (): Promise<false> => {
            try {
                await cleanupSandboxCandidate(candidateSandbox);
            } catch {
                // Cleanup is retained for the next transition.
            }
            return false;
        };
        try {
            await candidateSandbox.startBashSession(cwd);
            if (!isCurrentTransition(generation)) {
                return abandonStaleCandidate();
            }
            if (drain && sandboxService) {
                const oldSandbox = sandboxService;
                const oldAnalysis = analysisService;
                const oldSnapshot = serviceSnapshots.get(oldSandbox);
                retiredSandbox.add(oldSandbox);
                if (oldAnalysis) retiredAnalysis.add(oldAnalysis);
                void (
                    oldSnapshot
                        ? whenSandboxRuntimeIdle(oldSnapshot)
                        : Promise.resolve()
                )
                    .then(async () => {
                        await cleanupSandboxService(oldSandbox);
                        if (oldAnalysis)
                            await cleanupAnalysisService(oldAnalysis);
                    })
                    .catch((error) =>
                        ctx.ui.notify(
                            `Retired runtime cleanup failed: ${errorMessage(error)}`,
                            "error",
                        ),
                    )
                    .finally(() => {
                        retiredSandbox.delete(oldSandbox);
                        if (oldAnalysis) retiredAnalysis.delete(oldAnalysis);
                        serviceSnapshots.delete(oldSandbox);
                    });
                analysisService = null;
                // Retry failed candidates without terminating admitted retired operations.
                await shutdownServices(candidateSandbox);
            } else await shutdownServices(candidateSandbox);
            if (!isCurrentTransition(generation)) {
                return abandonStaleCandidate();
            }
            const analysis: SandboxAnalysisRuntime = {
                state: "retrying",
                diagnostic: "Analysis starting",
            };
            const published = publishSandboxRuntime(runtimeOwner, {
                state: "enabled",
                sandboxFingerprint: shellSandboxFingerprint(config),
                contexts: candidateSandbox.getProfileContexts(),
                dockerAccess: summarizeDockerAccess(config.docker),
                createBashOperations: (options) =>
                    createSandboxedBashOps(
                        candidateSandbox,
                        bashProcessSupervisor,
                        options,
                    ),
                analysis,
                createThinkBashOperations: (options) =>
                    createSandboxedBashOps(
                        candidateSandbox,
                        bashProcessSupervisor,
                        options,
                        "think-strict",
                    ),
            });
            if (!published) {
                await cleanupSandboxCandidate(candidateSandbox);
                return false;
            }
            sandboxService = candidateSandbox;
            serviceSnapshots.set(candidateSandbox, getSandboxRuntime());
            inFlightSandboxCandidates.delete(candidateSandbox);
            analysisRetryAttempt = 0;
            startAnalysisAttempt(ctx, generation, analysis);
            return true;
        } catch (error) {
            try {
                await cleanupSandboxCandidate(candidateSandbox);
            } catch (cleanup) {
                attachCleanupFailure(error, cleanup);
            }
            if (!isCurrentTransition(generation)) return false;
            throw error;
        }
    };

    let selectedProfile: ShellProfile | undefined;
    const machineId =
        process.platform === "linux"
            ? localMachineId()
            : `unsupported-${process.platform}`;
    const loadShell = (
        ctx: ExtensionContext,
        session?: ProjectCapabilities,
        profile?: ShellProfile,
    ) =>
        loadSandboxConfig(ctx.cwd, {
            projectTrusted: ctx.isProjectTrusted(),
            machineId,
            sessionDir: ctx.sessionManager?.getSessionDir(),
            sessionId: ctx.sessionManager?.getSessionId(),
            envOverride: envSandboxStatus(),
            sessionCapabilities: session,
            profile: profile ?? selectedProfile,
        });
    const capabilityCommands = createCapabilityCommands({
        agentDir: getAgentDir(),
        machineId,
        load: (ctx: ExtensionContext, session, profile) =>
            loadShell(ctx, session, profile).shell,
        apply: async (ctx, session, profile) => {
            selectedProfile = profile;
            const resolved = loadShell(ctx, session, profile);
            publishShellRuntime(
                runtimeOwner,
                () => loadShell(ctx, capabilityCommands.session()).shell,
            );
            const generation = beginTransition(ctx, false, true);
            if (generation === undefined) return;
            try {
                if (
                    !(await enableServices(
                        ctx.cwd,
                        resolved.config,
                        generation,
                        ctx,
                        true,
                    )) ||
                    !isCurrentTransition(generation)
                )
                    return;
                sandboxEnabled = true;
                updateSandboxStatus(
                    ctx,
                    resolved.shell.profile === "host" ? "off" : "on",
                    resolved.config.docker,
                );
            } catch (error) {
                if (!isCurrentTransition(generation)) return;
                publishError(error);
                updateSandboxStatus(ctx, "error");
                throw error;
            }
        },
    });

    pi.registerFlag("no-sandbox", {
        description:
            "Request the host shell profile using an existing local authorization",
        type: "boolean",
        default: false,
    });

    pi.on("before_agent_start", (event) => {
        const runtime = getSandboxRuntime();
        const snapshot: SandboxModelContextSnapshotV1 = {
            version: 1,
            state:
                runtime.state === "uninitialized"
                    ? "reconfiguring"
                    : runtime.state,
            ...(runtime.state === "enabled" && runtime.contexts
                ? { profiles: runtime.contexts }
                : {}),
        };
        let shellContext: string;
        try {
            const policy = currentShellPolicy();
            shellContext = policy
                ? formatShellPolicy(policy)
                : "Shell capabilities unavailable. Shell calls are blocked. Native file tools remain on the host.";
        } catch (error) {
            shellContext = `Shell capabilities unavailable: ${errorMessage(error)}`;
        }
        const cleanPrompt = event.systemPrompt
            .replace(
                /\n?<!-- pi:shell-capabilities:start -->[\s\S]*?<!-- pi:shell-capabilities:end -->/g,
                "",
            )
            .trimEnd();
        return {
            systemPrompt: `${injectSandboxSystemContext(cleanPrompt, snapshot).trimEnd()}\n<!-- pi:shell-capabilities:start -->\n${shellContext}\n<!-- pi:shell-capabilities:end -->`,
        };
    });

    let sandboxEnabled = false;
    let sandboxFooterState: SandboxFooterState = "off";
    let sandboxDockerFooterState: SandboxDockerFooterState = {
        mode: "off",
        unsafe: false,
    };
    const w = createWidget(pi, {
        id: WIDGET_ID,
        label: "Sandbox",
        description:
            "Shows whether sandboxed bash execution is enabled for the current session.",
        row: 1,
        order: 13,
        align: "right",
        grow: false,
        styled: true,
        render: (ctx) =>
            renderSandboxWidget(
                ctx.theme,
                sandboxFooterState,
                sandboxDockerFooterState,
            ),
    });

    function updateSandboxStatus(
        ctx: ExtensionContext,
        status: SandboxFooterState,
        docker?: SandboxDockerPolicy,
    ): void {
        sandboxFooterState = status;
        sandboxDockerFooterState = dockerFooterState(
            docker ?? { mode: "disabled" },
            status === "on",
        );
        w.update(ctx);
    }

    function notifySandboxEnabled(
        ctx: ExtensionContext,
        message: string,
        docker: SandboxDockerPolicy,
    ): void {
        if (docker.mode === "full") {
            ctx.ui.notify(
                `${message}. Docker full access is active and is equivalent to host control.`,
                "warning",
            );
            return;
        }
        ctx.ui.notify(
            [
                message,
                ...formatDockerSummary(
                    "Active Docker",
                    summarizeDockerAccess(docker),
                ),
            ].join("\n"),
            "info",
        );
    }

    function scheduleBreakGlassExpiry(
        ctx: ExtensionContext,
        baseConfig: SandboxConfig,
        expiresAtMs: number,
        activationGeneration: number,
        container: { id: string; name: string },
    ): void {
        const delay = Math.max(1, expiresAtMs - Date.now());
        breakGlassExpiryTimer = setTimeout(() => {
            breakGlassExpiryTimer = undefined;
            if (
                !ownsSandboxRuntime(runtimeOwner) ||
                !isCurrentTransition(activationGeneration)
            ) {
                return;
            }
            const generation = beginTransition(ctx);
            if (generation === undefined) return;
            sendSandboxRuntimeFeedback(
                ctx,
                `Docker break-glass expired for ${container.name} (${container.id}). Arbitrary Docker exec is no longer authorized for this container. Do not retry an exec that depends on this exception unless the user activates a new break-glass grant.`,
            );
            bashProcessSupervisor.shutdown();
            void (async () => {
                try {
                    await shutdownServices();
                    if (!isCurrentTransition(generation)) return;
                    const enabled = await enableServices(
                        ctx.cwd,
                        baseConfig,
                        generation,
                        ctx,
                    );
                    if (!isCurrentTransition(generation) || !enabled) return;
                    sandboxEnabled = true;
                    updateSandboxStatus(ctx, "on", baseConfig.docker);
                    ctx.ui.notify(
                        "Docker break-glass expired. Arbitrary exec is disabled; any running Sandbox commands were interrupted and were not retried.",
                        "info",
                    );
                } catch (error) {
                    if (!isCurrentTransition(generation)) return;
                    sandboxEnabled = false;
                    publishError(error);
                    updateSandboxStatus(ctx, "error");
                    ctx.ui.notify(
                        `Docker break-glass expired, but Sandbox reconfiguration failed: ${configurationErrorMessage(error)}`,
                        "error",
                    );
                    sendSandboxRuntimeFeedback(
                        ctx,
                        `Sandbox reconfiguration after Docker break-glass expiration failed. Sandbox execution is unavailable until recovery.`,
                    );
                }
            })();
        }, delay);
        breakGlassExpiryTimer.unref?.();
    }

    // Resolve local shell authority independently from strict engine startup.
    pi.on("session_start", async (_event, ctx) => {
        if (!ownsSandboxRuntime(runtimeOwner)) return;
        claimSandboxRuntime(runtimeOwner);
        const noSandbox = pi.getFlag("no-sandbox") as boolean;
        capabilityCommands.reset();
        selectedProfile = noSandbox ? "host" : undefined;
        publishShellRuntime(
            runtimeOwner,
            () => loadShell(ctx, capabilityCommands.session()).shell,
        );
        const generation = beginTransition(ctx, true);
        if (generation === undefined) return;
        bashProcessSupervisor.shutdown();

        let resolved: LoadSandboxConfigResult;
        try {
            resolved = loadShell(ctx, capabilityCommands.session());
        } catch (error) {
            sandboxEnabled = false;
            let reportedError = error;
            try {
                await shutdownServices();
            } catch (cleanup) {
                attachCleanupFailure(error, cleanup);
                reportedError = new AggregateError(
                    [error, cleanup],
                    `${errorMessage(error)}; cleanup failed: ${errorMessage(cleanup)}`,
                );
            }
            if (!isCurrentTransition(generation)) return;
            publishError(reportedError);
            updateSandboxStatus(ctx, "error");
            ctx.ui.notify(
                `Sandbox configuration failed: ${errorMessage(reportedError)}`,
                "error",
            );
            return;
        }

        const { config } = resolved;
        if (resolved.shell.state !== "ready")
            ctx.ui.notify(
                resolved.shell.diagnostic ?? resolved.shell.state,
                "warning",
            );

        if (process.platform !== "linux") {
            sandboxEnabled = false;
            const error = `Sandbox not supported on ${process.platform}`;
            await shutdownServices();
            if (!isCurrentTransition(generation)) return;
            publishError(error);
            updateSandboxStatus(ctx, "restricted");
            ctx.ui.notify(error, "warning");
            return;
        }

        try {
            const enabled = await enableServices(
                ctx.cwd,
                config,
                generation,
                ctx,
            );
            if (!isCurrentTransition(generation) || !enabled) return;
            sandboxEnabled = true;
            updateSandboxStatus(
                ctx,
                resolved.shell.state !== "ready"
                    ? "restricted"
                    : resolved.shell.profile === "host"
                      ? "off"
                      : "on",
                config.docker,
            );
            notifySandboxEnabled(ctx, "Sandbox initialized", config.docker);
        } catch (err) {
            if (!isCurrentTransition(generation)) return;
            sandboxEnabled = false;
            publishError(err);
            updateSandboxStatus(ctx, "error");
            ctx.ui.notify(
                `Sandbox initialization failed: ${err instanceof Error ? err.message : String(err)}`,
                "error",
            );
        }
    });

    pi.on("session_shutdown", async () => {
        releaseShellRuntime(runtimeOwner);
        const generation = beginTransition();
        bashProcessSupervisor.shutdown();
        try {
            await shutdownServices(undefined, undefined, true);
        } catch (error) {
            if (generation !== undefined && isCurrentTransition(generation)) {
                publishError(error);
            }
            throw error;
        }
        if (generation === undefined || !isCurrentTransition(generation)) {
            return;
        }
        releaseSandboxRuntime(runtimeOwner);
    });

    pi.registerCommand("sandbox", {
        description:
            "Configure sandbox or show status (/sandbox, /sandbox on|off, /sandbox docker ...)",
        getArgumentCompletions: (prefix: string) => {
            const values = [
                "profile isolated",
                "profile integrated",
                "profile host",
                "capabilities",
                "capabilities migrate",
                "capabilities grant",
                "capabilities revoke",
                "doctor",
                "on",
                "off",
                "docker",
                "docker grant",
                "docker break-glass",
                "docker break-glass 5m",
                "docker break-glass 15m",
                "docker break-glass 30m",
                "docker off",
                "docker targeted",
                "docker full",
                "docker inherit",
            ];
            const trimmed = prefix.trimStart().toLowerCase();
            if (!trimmed) {
                return values
                    .filter(
                        (value) =>
                            !value.includes(" ") ||
                            value.startsWith("profile "),
                    )
                    .map((value) => ({ value, label: value }));
            }
            const filtered = values.filter((value) =>
                value.startsWith(trimmed),
            );
            return filtered.length > 0
                ? filtered.map((value) => ({ value, label: value }))
                : null;
        },
        handler: async (args, ctx) => {
            if (await capabilityCommands.handle(args, ctx)) return;
            const arg = args.trim().toLowerCase();

            if (arg === "doctor") {
                const agentDir = getAgentDir();
                const authorityPath = join(agentDir, "sandbox.global.json");
                try {
                    const resolved = loadSandboxConfig(ctx.cwd, {
                        agentDir,
                        sessionDir: ctx.sessionManager?.getSessionDir(),
                        sessionId: ctx.sessionManager?.getSessionId(),
                        envOverride: envSandboxStatus(),
                        includeLegacy: false,
                    });
                    let accessLines: string[] = [];
                    let shellLines: string;
                    try {
                        shellLines = formatShellPolicy(
                            loadShell(ctx, capabilityCommands.session()).shell,
                        );
                    } catch (error) {
                        shellLines = `Shell capabilities unavailable: ${configurationErrorMessage(error)}`;
                    }
                    if (resolved.config.docker.mode === "targeted") {
                        try {
                            accessLines = formatDockerAccess(
                                await inspectDockerAccess(
                                    ctx.cwd,
                                    resolved.config.docker,
                                ),
                            );
                        } catch (error) {
                            accessLines = [
                                `Docker target inspection unavailable: ${configurationErrorMessage(error)}`,
                            ];
                        }
                    }
                    ctx.ui.notify(
                        [
                            "Sandbox doctor",
                            shellLines,
                            ...activeShellOperations().map(
                                (op) =>
                                    `Admitted operation #${op.id}: ${op.profile}${op.capability ? ` / ${op.capability}` : ""}; finishes under its original admission.`,
                            ),
                            `Docker authority: ${authorityPath} (${existsSync(authorityPath) ? "valid" : "not configured"})`,
                            `Effective Sandbox: ${resolved.config.enabled ? "on" : "off"} (${resolved.source})`,
                            ...formatDockerSummary(
                                "Saved Docker grant",
                                summarizeDockerAccess(
                                    resolveDockerPolicy({
                                        cwd: ctx.cwd,
                                        globalConfigPath: authorityPath,
                                    }),
                                ),
                            ),
                            ...formatDockerSummary(
                                "Configured Docker",
                                summarizeDockerAccess(resolved.config.docker),
                            ),
                            ...activeDockerLines(resolved.config.docker),
                            ...accessLines,
                            "Target visibility checks do not execute the granted operations.",
                            "Next: /sandbox docker grant",
                        ].join("\n"),
                        "info",
                    );
                } catch (error) {
                    ctx.ui.notify(
                        [
                            "Sandbox doctor",
                            `Docker authority: ${authorityPath} (invalid)`,
                            `Problem: ${configurationErrorMessage(error)}`,
                            "Next: /sandbox docker grant",
                        ].join("\n"),
                        "error",
                    );
                }
                return;
            }

            if (arg === "docker") {
                try {
                    const agentDir = getAgentDir();
                    const settingsManager = SettingsManager.create(
                        ctx.cwd,
                        agentDir,
                    );
                    const projectSettings =
                        settingsManager.getProjectSettings() as SandboxSettingsContainer;
                    let projectConfig = readSettingsConfig(
                        projectSettings,
                        "project",
                    );
                    if (projectSettings.sandbox === undefined) {
                        projectConfig = readLegacyConfig(
                            join(ctx.cwd, ".pi", "sandbox.json"),
                        );
                    }
                    const resolved = loadSandboxConfig(ctx.cwd, {
                        agentDir,
                        settingsManager: {
                            // SAFETY: Pi settings permit extension-owned keys that are absent from its generic Settings type.
                            getGlobalSettings: () =>
                                settingsManager.getGlobalSettings() as unknown as SandboxSettingsContainer,
                            // SAFETY: Same extension-owned project key boundary.
                            getProjectSettings: () =>
                                settingsManager.getProjectSettings() as unknown as SandboxSettingsContainer,
                        },
                        sessionDir: ctx.sessionManager?.getSessionDir(),
                        sessionId: ctx.sessionManager?.getSessionId(),
                        envOverride: envSandboxStatus(),
                    });
                    const authority = resolveDockerPolicy({
                        cwd: ctx.cwd,
                        globalConfigPath: join(agentDir, "sandbox.global.json"),
                    });
                    const preference =
                        configuredDockerPreference(projectConfig);
                    ctx.ui.notify(
                        [
                            ...formatDockerSummary(
                                "Saved Docker grant",
                                summarizeDockerAccess(authority),
                            ),
                            `Project preference: ${preference}`,
                            ...formatDockerSummary(
                                "Configured Docker",
                                summarizeDockerAccess(resolved.config.docker),
                            ),
                            ...activeDockerLines(resolved.config.docker),
                        ].join("\n"),
                        "info",
                    );
                } catch (error) {
                    ctx.ui.notify(
                        `Docker configuration failed: ${configurationErrorMessage(error)}`,
                        "error",
                    );
                }
                return;
            }

            if (
                arg === "docker break-glass" ||
                arg.startsWith("docker break-glass ")
            ) {
                const breakGlassMatch =
                    /^docker break-glass(?:\s+(\S+))?$/.exec(arg);
                const durationMinutes = parseDockerBreakGlassDurationMinutes(
                    breakGlassMatch?.[1],
                );
                if (!breakGlassMatch || durationMinutes === undefined) {
                    ctx.ui.notify(DOCKER_BREAK_GLASS_DURATION_USAGE, "error");
                    return;
                }
                if (!ctx.isProjectTrusted()) {
                    ctx.ui.notify(
                        "Docker break-glass requires a trusted project",
                        "error",
                    );
                    return;
                }
                if (
                    !sandboxEnabled ||
                    getSandboxRuntime().state !== "enabled"
                ) {
                    ctx.ui.notify(
                        "Docker break-glass requires an active Sandbox runtime",
                        "error",
                    );
                    return;
                }

                let baseConfig: SandboxConfig;
                let candidate: DockerBreakGlassCandidate;
                try {
                    const resolved = loadSandboxConfig(ctx.cwd, {
                        sessionDir: ctx.sessionManager?.getSessionDir(),
                        sessionId: ctx.sessionManager?.getSessionId(),
                        envOverride: envSandboxStatus(),
                    });
                    baseConfig = resolved.config;
                    if (baseConfig.docker.mode !== "targeted") {
                        ctx.ui.notify(
                            "Docker break-glass is available only for targeted host-access grants",
                            "error",
                        );
                        return;
                    }
                    const access = await inspectDockerAccess(
                        ctx.cwd,
                        baseConfig.docker,
                    );
                    const candidates = dockerBreakGlassCandidates(
                        baseConfig.docker,
                        access,
                    );
                    if (candidates.length === 0) {
                        ctx.ui.notify(
                            "No running host-access target has Administration requested. Run /sandbox docker grant first.",
                            "error",
                        );
                        return;
                    }
                    if (candidates.length === 1) {
                        candidate = candidates[0];
                    } else {
                        const labels = candidates.map(
                            ({ container }) =>
                                `${container.name} (${container.id.slice(0, 12)})`,
                        );
                        const selected = await ctx.ui.select(
                            "Container for temporary arbitrary exec",
                            labels,
                        );
                        const selectedIndex =
                            selected === undefined
                                ? -1
                                : labels.indexOf(selected);
                        if (selectedIndex < 0) {
                            ctx.ui.notify(
                                "Docker break-glass cancelled",
                                "info",
                            );
                            return;
                        }
                        candidate = candidates[selectedIndex];
                    }
                } catch (error) {
                    ctx.ui.notify(
                        `Docker break-glass inspection failed: ${configurationErrorMessage(error)}`,
                        "error",
                    );
                    return;
                }

                const expiresAtMs = Date.now() + durationMinutes * 60 * 1000;
                const durationLabel = `${durationMinutes} minute${durationMinutes === 1 ? "" : "s"}`;
                const accepted = await ctx.ui.confirm(
                    "Temporarily allow arbitrary Docker exec?",
                    [
                        `Target: ${dockerSelectorLabel(candidate.target.selector)}`,
                        `Exact container: ${candidate.container.name} (${candidate.container.id})`,
                        ...formatDockerAccess([candidate.access]),
                        "Arbitrary commands can modify or delete data exposed through the host access listed above, including read-write host bind mounts.",
                        `This authorization is kept only in the current Pi session, applies only to this container ID, and expires after ${durationLabel}.`,
                        "Expiration interrupts running Sandbox commands; they are not retried.",
                    ].join("\n"),
                );
                if (!accepted) {
                    ctx.ui.notify("Docker break-glass cancelled", "info");
                    return;
                }

                if (baseConfig.docker.mode !== "targeted") return;
                const runtimeDocker: SandboxDockerPolicy = {
                    ...baseConfig.docker,
                    targets: [
                        ...baseConfig.docker.targets,
                        {
                            selector: {
                                type: "ephemeral-container",
                                id: candidate.container.id,
                                unsafeExecExpiresAtMs: expiresAtMs,
                            },
                            operations: ["exec"],
                            allowUnsafeTarget: true,
                        },
                    ],
                };
                const runtimeConfig: SandboxConfig = {
                    ...baseConfig,
                    docker: runtimeDocker,
                };
                const generation = beginTransition(ctx);
                if (generation === undefined) return;
                bashProcessSupervisor.shutdown();
                try {
                    await shutdownServices();
                    if (!isCurrentTransition(generation)) return;
                    const enabled = await enableServices(
                        ctx.cwd,
                        runtimeConfig,
                        generation,
                        ctx,
                    );
                    if (!isCurrentTransition(generation) || !enabled) return;
                    sandboxEnabled = true;
                    updateSandboxStatus(ctx, "on", runtimeDocker);
                    scheduleBreakGlassExpiry(
                        ctx,
                        baseConfig,
                        expiresAtMs,
                        generation,
                        {
                            id: candidate.container.id,
                            name: candidate.container.name,
                        },
                    );
                    ctx.ui.notify(
                        [
                            `Break-glass exec active for container ${candidate.container.name}.`,
                            `Exact container ID: ${candidate.container.id}`,
                            `Expires: ${new Date(expiresAtMs).toISOString()}`,
                            ...formatDockerAccess([candidate.access]),
                            ...formatDockerSummary(
                                "Active Docker",
                                summarizeDockerAccess(runtimeDocker),
                            ),
                        ].join("\n"),
                        "warning",
                    );
                    sendSandboxRuntimeFeedback(
                        ctx,
                        `Docker break-glass is active for ${candidate.container.name} (${candidate.container.id}) until ${new Date(expiresAtMs).toISOString()}. Arbitrary Docker exec is temporarily authorized only for this exact container ID. Retry a previously blocked or interrupted Docker exec only if it is still needed.`,
                    );
                } catch (error) {
                    if (!isCurrentTransition(generation)) return;
                    sandboxEnabled = false;
                    publishError(error);
                    updateSandboxStatus(ctx, "error");
                    ctx.ui.notify(
                        `Docker break-glass activation failed: ${configurationErrorMessage(error)}`,
                        "error",
                    );
                }
                return;
            }

            if (arg === "docker grant") {
                if (!ctx.isProjectTrusted()) {
                    ctx.ui.notify(
                        "Docker grants require a trusted project",
                        "error",
                    );
                    return;
                }
                let target: DockerTargetSelector | undefined;
                try {
                    target = await selectDockerTarget(ctx);
                } catch (error) {
                    ctx.ui.notify(
                        `Docker discovery failed: ${configurationErrorMessage(error)}`,
                        "error",
                    );
                    return;
                }
                if (target === undefined) {
                    ctx.ui.notify("Docker grant cancelled", "info");
                    return;
                }
                const selectedProfile = await ctx.ui.select(
                    "Docker access profile",
                    DOCKER_ACCESS_PROFILES.map(({ label }) => label),
                );
                const profile = DOCKER_ACCESS_PROFILES.find(
                    ({ label }) => label === selectedProfile,
                );
                if (profile === undefined) {
                    ctx.ui.notify("Docker grant cancelled", "info");
                    return;
                }
                const grant: DockerTargetGrant = {
                    selector: target,
                    operations: profile.operations,
                    allowUnsafeTarget: false,
                };
                let accessLines: string[];
                try {
                    const policy = {
                        mode: "targeted" as const,
                        endpoint: DEFAULT_DOCKER_ENDPOINT,
                        targets: [grant],
                    };
                    let access = await inspectDockerAccess(ctx.cwd, policy);
                    const excluded = access
                        .flatMap((item) => item.containers)
                        .filter((container) => container.access === "excluded");
                    if (excluded.length > 0) {
                        const exceptionPolicy: SandboxDockerPolicy = {
                            ...policy,
                            targets: [{ ...grant, allowUnsafeTarget: true }],
                        };
                        const accepted = await ctx.ui.confirm(
                            "Authorize this Docker target despite host access?",
                            [
                                ...formatDockerSummary(
                                    "Effective Docker rights with this exception",
                                    summarizeDockerAccess(exceptionPolicy),
                                ),
                                "The paths below are existing container mounts: host source → container destination. Only mount metadata was inspected.",
                                ...formatDockerAccess(access),
                                "This exception authorizes containers matching this selector, including future replacements, despite their host access.",
                                "Arbitrary exec remains unavailable for host-access targets. When Administration is requested, only the fixed read-only probes test -r, stat and ls are available.",
                                "Use /sandbox docker break-glass for a temporary arbitrary exec authorization bound to one current container ID.",
                                "Keep this exception limited to a container you trust.",
                            ].join("\n"),
                        );
                        if (!accepted) {
                            ctx.ui.notify("Docker grant cancelled", "info");
                            return;
                        }
                        grant.allowUnsafeTarget = true;
                        access = await inspectDockerAccess(ctx.cwd, policy);
                        if (
                            access.some((item) =>
                                item.containers.some(
                                    (container) =>
                                        container.access === "excluded",
                                ),
                            )
                        ) {
                            throw new Error(
                                "Docker target remains excluded with the exception; no grant was saved",
                            );
                        }
                    }
                    accessLines = formatDockerAccess(access);
                } catch (error) {
                    ctx.ui.notify(
                        `Docker grant inspection failed: ${configurationErrorMessage(error)}`,
                        "error",
                    );
                    return;
                }
                const confirmed = await ctx.ui.confirm(
                    "Save Docker grant?",
                    [
                        renderDockerGrantDiff(ctx.cwd, grant),
                        ...accessLines,
                    ].join("\n"),
                );
                if (!confirmed) {
                    ctx.ui.notify("Docker grant cancelled", "info");
                    return;
                }
                const authorityPath = join(
                    getAgentDir(),
                    "sandbox.global.json",
                );
                try {
                    await withFileMutationQueue(authorityPath, async () => {
                        if (!ctx.isProjectTrusted())
                            throw new Error(
                                "Docker grants require a trusted project",
                            );
                        saveTargetedDockerGrant({
                            cwd: ctx.cwd,
                            globalConfigPath: authorityPath,
                            target: grant,
                        });
                    });
                } catch (error) {
                    ctx.ui.notify(
                        `Docker grant failed: ${configurationErrorMessage(error)}`,
                        "error",
                    );
                    return;
                }
                if (!sandboxEnabled) {
                    ctx.ui.notify(
                        formatDockerGrantResult(
                            summarizeDockerAccess({
                                mode: "targeted",
                                endpoint: DEFAULT_DOCKER_ENDPOINT,
                                targets: [grant],
                            }),
                        ),
                        "info",
                    );
                    return;
                }
                const generation = beginTransition(ctx);
                if (generation === undefined) return;
                bashProcessSupervisor.shutdown();
                try {
                    await shutdownServices();
                    if (!isCurrentTransition(generation)) return;
                    const { config } = loadSandboxConfig(ctx.cwd, {
                        sessionDir: ctx.sessionManager?.getSessionDir(),
                        sessionId: ctx.sessionManager?.getSessionId(),
                        envOverride: envSandboxStatus(),
                    });
                    const enabled = await enableServices(
                        ctx.cwd,
                        config,
                        generation,
                        ctx,
                    );
                    if (!isCurrentTransition(generation) || !enabled) return;
                    sandboxEnabled = true;
                    updateSandboxStatus(ctx, "on", config.docker);
                    ctx.ui.notify(
                        formatDockerGrantResult(
                            summarizeDockerAccess({
                                mode: "targeted",
                                endpoint: DEFAULT_DOCKER_ENDPOINT,
                                targets: [grant],
                            }),
                            summarizeDockerAccess(config.docker),
                        ),
                        "info",
                    );
                } catch (error) {
                    if (!isCurrentTransition(generation)) return;
                    sandboxEnabled = false;
                    publishError(error);
                    updateSandboxStatus(ctx, "error");
                    ctx.ui.notify(
                        formatDockerGrantResult(
                            summarizeDockerAccess({
                                mode: "targeted",
                                endpoint: DEFAULT_DOCKER_ENDPOINT,
                                targets: [grant],
                            }),
                            undefined,
                            configurationErrorMessage(error),
                        ),
                        "error",
                    );
                }
                return;
            }

            if (arg.startsWith("docker ")) {
                const preference = parseDockerProjectPreference(
                    arg.slice("docker ".length),
                );
                if (preference === undefined) {
                    ctx.ui.notify(
                        "Usage: /sandbox docker [off|targeted|full|inherit]",
                        "error",
                    );
                    return;
                }
                if (!ctx.isProjectTrusted()) {
                    ctx.ui.notify(
                        "Docker project preference requires a trusted project",
                        "error",
                    );
                    return;
                }

                let resolved: LoadSandboxConfigResult;
                try {
                    resolved = await persistProjectDockerPreference(
                        ctx.cwd,
                        preference,
                    );
                } catch (error) {
                    ctx.ui.notify(
                        `Docker configuration failed: ${configurationErrorMessage(error)}`,
                        "error",
                    );
                    return;
                }

                if (!sandboxEnabled) {
                    updateSandboxStatus(ctx, "off");
                    ctx.ui.notify(
                        `Docker project preference saved: ${preference}`,
                        "info",
                    );
                    return;
                }

                const generation = beginTransition(ctx);
                if (generation === undefined) return;
                bashProcessSupervisor.shutdown();
                try {
                    await shutdownServices();
                    if (!isCurrentTransition(generation)) return;
                    const enabled = await enableServices(
                        ctx.cwd,
                        resolved.config,
                        generation,
                        ctx,
                    );
                    if (!isCurrentTransition(generation) || !enabled) return;
                    sandboxEnabled = true;
                    updateSandboxStatus(ctx, "on", resolved.config.docker);
                    notifySandboxEnabled(
                        ctx,
                        `Docker project preference saved: ${preference}`,
                        resolved.config.docker,
                    );
                } catch (error) {
                    if (!isCurrentTransition(generation)) return;
                    sandboxEnabled = false;
                    publishError(error);
                    updateSandboxStatus(ctx, "error");
                    ctx.ui.notify(
                        `Docker preference saved, but sandbox reconfiguration failed: ${errorMessage(error)}`,
                        "error",
                    );
                }
                return;
            }

            // /sandbox (no args) — show status
            if (!arg) {
                let resolved: LoadSandboxConfigResult;
                try {
                    resolved = loadSandboxConfig(ctx.cwd, {
                        sessionDir: ctx.sessionManager?.getSessionDir(),
                        sessionId: ctx.sessionManager?.getSessionId(),
                        envOverride: envSandboxStatus(),
                    });
                } catch (error) {
                    publishError(error);
                    updateSandboxStatus(ctx, "error");
                    ctx.ui.notify(
                        `Sandbox configuration failed: ${errorMessage(error)}`,
                        "error",
                    );
                    return;
                }
                ctx.ui.notify(
                    renderSandboxStatusDetails(
                        resolved,
                        sandboxEnabled,
                        getActiveDockerSummary(),
                        getSandboxRuntime().state,
                    ),
                    "info",
                );
                return;
            }

            ctx.ui.notify(
                "Usage: /sandbox [profile isolated|integrated|host | capabilities | doctor | on | off | docker ...]",
                "error",
            );
        },
    });
}
