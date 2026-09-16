/**
 * Sandbox Extension - OS-level isolation runtime for Bash operations and
 * analysis workers.
 *
 * Uses the managed Zerobox fork to enforce filesystem, network, environment,
 * and process restrictions on Linux. Bash tool registration belongs to the
 * separate bash-execution extension.
 *
 * Configuration: ~/.pi/agent/sandbox.json supplies global defaults and ceilings;
 * <project>/.pi/sandbox.json supplies optional project restrictions.
 * Use /sandbox for status and actions, /sandbox mode for explicit session mode
 * selection, and /sandbox doctor [executable] for read-only diagnostics.
 * Host execution requires global host.allowed; a configuration change never
 * selects host mode automatically.
 *
 * Linux requires the provenance-pinned ~/.pi/bin/zerobox binary, mkfifo,
 * prlimit, and Node with JSPI support for the Python analyzer.
 */

import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
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
    type AnalysisSandboxServiceOptions,
} from "./analysis/client.ts";
import { createAuthorityWatch } from "./capabilities/authority-watch.ts";
import {
    localMachineId,
    readGlobalSandboxConfig,
    readProjectSandboxConfig,
    sandboxConfigPath,
    type SandboxConfigLayer,
    type SandboxMode,
} from "./capabilities/authority.ts";
import { manageInstallations } from "./capabilities/installation-ui.ts";
import {
    formatMigrationPreview,
    previewLegacyMigration,
    publishLegacyMigration,
    recoverIncompleteMigration,
} from "./capabilities/migration.ts";
import {
    resolveShellPolicy,
    shellSandboxFingerprint,
    type ShellCapabilityResolution,
} from "./capabilities/policy.ts";
import { protectsCapabilityAuthority } from "./capabilities/protection.ts";
import { sandboxAccessRemoved } from "./capabilities/revocation.ts";
import {
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
    dockerSelectorLabel,
    summarizeDockerAccess,
    dockerSummaryLabel,
    formatDockerSummary,
    formatActiveDocker,
    formatBreakGlassRemaining,
    BREAK_GLASS_COUNTDOWN_WINDOW_MS,
} from "./docker-presentation.ts";
import { sandboxDoctor } from "./doctor.ts";
import { registerSandboxModelContext } from "./model-context.ts";
import {
    DOCKER_OPERATIONS,
    SandboxExecutionError,
    type SandboxCommand,
    type SandboxDockerPolicy,
    type DockerTargetGrant,
} from "./runtime/contracts.ts";
import { createDefaultSandboxBaseline } from "./runtime/default-config.ts";
import {
    dockerSelectorKey,
    dockerPolicyHasUnsafeTargets,
    dockerBreakGlassCeiling,
    resolveDockerPolicy,
} from "./runtime/docker-policy.ts";
import { type PiSandboxConfig } from "./runtime/policies.ts";
import {
    createSandboxService,
    type SandboxService,
    type SandboxServiceOptions,
} from "./runtime/service.ts";
import { PRIVATE_BASH } from "./runtime/shell-baseline.ts";
import {
    createZeroboxBackend,
    inspectManagedPrivateRuntime,
    type ZeroboxBackendOptions,
} from "./runtime/zerobox-backend.ts";

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
    /** Deadline of the live break-glass grant, when this session holds one. */
    breakGlassExpiresAtMs?: number;
}

/** Shield glyph shown in the footer widget (same metaphor as the bash 🛡️ prefix). */
const SANDBOX_ICON = "🛡️";
const DOCKER_ICON = "🐳";
/** Warning glyph used in the footer widget when sandbox is disabled. */
const OFF_ICON = "⚠️";
const WIDGET_ID = "pi-sandbox";
const DOCKER_BREAK_GLASS_DEFAULT_MINUTES = 5;
const DOCKER_BREAK_GLASS_MIN_MINUTES = 1;
/** Cadence of the per-second countdown during the final break-glass window. */
const BREAK_GLASS_COUNTDOWN_TICK_MS = 1_000;
/** Sample durations offered in the usage text, filtered by the effective ceiling. */
const DOCKER_BREAK_GLASS_SAMPLE_MINUTES = [5, 15, 30, 60] as const;

/**
 * Build the duration usage message from the effective global ceiling.
 * The ceiling is configuration, so the message cannot be a module constant.
 */
function dockerBreakGlassDurationUsage(maxMinutes: number): string {
    const samples = DOCKER_BREAK_GLASS_SAMPLE_MINUTES.filter(
        (minutes) => minutes <= maxMinutes,
    );
    const list =
        samples.length > 0
            ? samples.map((minutes) => `${minutes}m`).join("|")
            : `${DOCKER_BREAK_GLASS_DEFAULT_MINUTES}m`;
    return `Docker break-glass duration must be between ${DOCKER_BREAK_GLASS_MIN_MINUTES}m and ${maxMinutes}m. Usage: /sandbox docker break-glass [${list}]`;
}

/** Parse the `<N>m` duration syntax only; the ceiling is validated against configuration. */
function parseDockerBreakGlassDurationMinutes(
    value: string | undefined,
): number | undefined {
    if (value === undefined) return DOCKER_BREAK_GLASS_DEFAULT_MINUTES;
    const match = /^(\d+)m$/.exec(value);
    if (!match) return undefined;
    const minutes = Number(match[1]);
    return Number.isSafeInteger(minutes) ? minutes : undefined;
}
const ANALYSIS_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 300_000] as const;

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
    /**
     * Effective global ceiling for `/sandbox docker break-glass`. Kept out of
     * `config.docker`: that policy reaches the sandbox backend and the runtime
     * admission receipt, which must not carry display-only authority limits.
     */
    breakGlassMaxMinutes: number;
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

/** Render selected shell mode and policy independently of engine readiness. */
export function renderSandboxWidget(
    theme: import("@earendil-works/pi-coding-agent").Theme,
    state: SandboxFooterState,
    docker: SandboxDockerFooterState = { mode: "off", unsafe: false },
    shell?: Pick<ShellCapabilityResolution, "mode" | "profile">,
    admission: "pending" | "admitted" = "pending",
    nowMs = Date.now(),
): string | null {
    const colors: UiColorsCreation = createUiColors(theme);
    if (shell) {
        let runtime: string = state;
        if (state === "on")
            runtime =
                admission === "admitted" ? "admitted" : "pending admission";
        let value: string;
        let shellColor: string;
        if (shell.mode === "host") {
            const suffix =
                state === "error" || state === "reconfiguring"
                    ? ` · ${state}`
                    : "";
            value = `host · unsandboxed${suffix}`;
            shellColor = colors.warning(value);
        } else {
            value = `sandbox · ${shell.profile} · ${runtime}`;
            if (state === "error") shellColor = colors.danger(value);
            else if (state === "on") shellColor = colors.primary(value);
            else shellColor = colors.warning(value);
        }
        return `${colors.subtle("Shell:")} ${shellColor} | ${colors.subtle("Docker:")} ${colorForDockerState(colors, docker, nowMs)}`;
    }
    const dockerLabel = colors.subtle(`${DOCKER_ICON}docker:`);
    const dockerValue = colorForDockerState(colors, docker, nowMs);
    if (state === "off") {
        return `${colors.subtle(`${OFF_ICON}sandbox:`)} ${colors.warning(state)} ${dockerLabel} ${dockerValue}`;
    }
    const label = colors.subtle(`${SANDBOX_ICON}sandbox:`);
    const value = colorForState(colors, state);
    return `${label} ${value} ${dockerLabel} ${dockerValue}`;
}

/**
 * Docker value for the footer. A live break-glass grant owns the only
 * break-glass token, so the summary token is dropped while a deadline is
 * rendered.
 */
function dockerFooterValue(
    state: SandboxDockerFooterState,
    nowMs = Date.now(),
): string {
    const breakGlass =
        state.mode === "off" || state.breakGlassExpiresAtMs === undefined
            ? undefined
            : formatBreakGlassRemaining(state.breakGlassExpiresAtMs, nowMs);
    let value: string;
    if (state.mode === "full") {
        value = "full · host control";
    } else if (state.summary) {
        value = dockerSummaryLabel(
            breakGlass
                ? { ...state.summary, breakGlass: undefined }
                : state.summary,
        );
    } else {
        value = `${state.mode}${state.unsafe ? " · host-access exception" : ""}`;
    }
    return breakGlass === undefined
        ? value
        : `${value} · break-glass ${breakGlass}`;
}

function colorForDockerState(
    colors: UiColorsCreation,
    state: SandboxDockerFooterState,
    nowMs = Date.now(),
): string {
    const value = dockerFooterValue(state, nowMs);
    if (state.mode === "full") return colors.danger(value);
    if (state.mode === "targeted") {
        return state.unsafe ? colors.warning(value) : colors.primary(value);
    }
    return colors.subtle(value);
}

export function dockerFooterState(
    policy: SandboxDockerPolicy,
    sandboxActive = true,
    breakGlassExpiresAtMs?: number,
): SandboxDockerFooterState {
    if (!sandboxActive || policy.mode === "disabled") {
        return { mode: "off", unsafe: false };
    }
    if (policy.mode === "full") return { mode: "full", unsafe: true };
    const state: SandboxDockerFooterState = {
        mode: "targeted",
        unsafe: dockerPolicyHasUnsafeTargets(policy),
        summary: summarizeDockerAccess(policy),
    };
    if (breakGlassExpiresAtMs !== undefined) {
        state.breakGlassExpiresAtMs = breakGlassExpiresAtMs;
    }
    return state;
}

/** Show configured and active rights without exposing Engine credentials. */
export function renderSandboxStatusDetails(
    resolved: LoadSandboxConfigResult,
    sandboxActive: boolean,
    activeDocker?: DockerAccessSummary,
    runtimeState?: string,
): string {
    const { config, source } = resolved;
    let status = "DISABLED";
    if (resolved.shell.mode === "host") status = "HOST (unsandboxed)";
    else if (sandboxActive) status = "ENABLED";
    const securityLabel = explicitlyDisabled(resolved) ? `${status} ⚠` : status;
    let dockerStatus = "off (sandbox disabled)";
    if (resolved.shell.mode === "host") {
        dockerStatus = "off (shell mode is host)";
    } else if (sandboxActive) {
        dockerStatus =
            config.docker.mode === "disabled" ? "off" : config.docker.mode;
    }
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
        "Use /sandbox mode sandbox|host. Host mode requires an explicit current-session selection within the global ceiling.",
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

interface DockerBreakGlassCandidate {
    target: DockerTargetGrant;
    access: DockerTargetAccess;
    container: DockerTargetAccess["containers"][number];
}

interface ActiveDockerBreakGlass {
    id: number;
    selectorKey: string;
    expiresAtMs: number;
    container: { id: string; name: string };
    supervisors: Set<BashProcessSupervisor>;
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

export interface SandboxConfig extends PiSandboxConfig {}

export type DockerProjectPreference =
    | "on"
    | "off"
    | "inherit"
    | "targeted"
    | "full";

export interface LoadSandboxConfigOptions {
    agentDir?: string;
    /** Ephemeral restrictions and temporary user selections. Never persisted. */
    session?: SandboxConfigLayer;
    projectTrusted?: boolean;
    machineId?: string;
    /** @deprecated Historical settings are ignored after A2 migration. */
    settingsManager?: unknown;
    /** @deprecated Session files are ignored; use session for in-memory constraints. */
    sessionDir?: string;
    sessionId?: string;
    envOverride?: "enabled" | "disabled";
    includeLegacy?: boolean;
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

export function loadSandboxConfig(
    cwd: string,
    options: LoadSandboxConfigOptions = {},
): LoadSandboxConfigResult {
    const agentDir = options.agentDir ?? getAgentDir();
    const globalPath = sandboxConfigPath(agentDir);
    const projectPath = join(cwd, ".pi", "sandbox.json");
    const migrationMarker = `${globalPath}.migration`;
    if (existsSync(migrationMarker))
        throw new SandboxExecutionError("invalid-policy", {
            cause: new Error(
                "Sandbox migration is incomplete; resume or cancel it explicitly",
            ),
        });
    const machineId = options.machineId ?? localMachineId();
    const global = readGlobalSandboxConfig(globalPath, machineId);
    const project =
        options.projectTrusted === false
            ? undefined
            : readProjectSandboxConfig(projectPath);
    const docker = resolveDockerPolicy({
        globalConfig: global?.docker,
        projectConfig: project?.docker,
    });
    const baseline = createDefaultSandboxBaseline(docker);
    const policy = resolveShellPolicy({
        cwd,
        baseline,
        global,
        project,
        session: options.session,
        authorityPath: globalPath,
    });
    let source: SandboxConfigSource = "default";
    if (project) source = "project-config";
    else if (global) source = "global-config";
    return {
        ...policy,
        config: { ...policy.config, docker },
        source,
        breakGlassMaxMinutes: dockerBreakGlassCeiling(global?.docker),
    };
}

/** Persist only the project opt-in. The global Docker ceiling remains untouched. */
export async function persistProjectDockerPreference(
    cwd: string,
    preference: DockerProjectPreference,
    agentDir = getAgentDir(),
): Promise<LoadSandboxConfigResult> {
    const projectPath = join(cwd, ".pi", "sandbox.json");
    return withFileMutationQueue(projectPath, async () => {
        const current = readProjectSandboxConfig(projectPath) ?? {};
        const currentDocker = current.docker;
        const dockerFields =
            typeof currentDocker === "object" &&
            currentDocker !== null &&
            !Array.isArray(currentDocker)
                ? currentDocker
                : {};
        const next = {
            ...current,
            docker: { ...dockerFields, enabled: preference === "on" },
        };
        const global = readGlobalSandboxConfig(
            sandboxConfigPath(agentDir),
            localMachineId(),
        );
        const docker = resolveDockerPolicy({
            globalConfig: global?.docker,
            projectConfig: next.docker,
        });
        const baseline = createDefaultSandboxBaseline(docker);
        resolveShellPolicy({
            cwd,
            baseline,
            global,
            project: next,
            authorityPath: sandboxConfigPath(agentDir),
        });
        mkdirSync(dirname(projectPath), { recursive: true, mode: 0o700 });
        const temporaryPath = `${projectPath}.${process.pid}.tmp`;
        try {
            writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
                encoding: "utf8",
                mode: 0o600,
            });
            renameSync(temporaryPath, projectPath);
        } catch (error) {
            if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
            throw error;
        }
        return loadSandboxConfig(cwd, { agentDir });
    });
}

export function createSandboxedBashOps(
    service: Pick<SandboxService, "prepareBash" | "prepareThinkBash">,
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
                file: PRIVATE_BASH,
                args: [
                    "--noprofile",
                    "--norc",
                    "-o",
                    "pipefail",
                    "-c",
                    command,
                ],
                cwd,
                stdin: options.stdin,
            };
            const spawn = await (profile === "think-strict"
                ? service.prepareThinkBash(sandboxCommand)
                : service.prepareBash(sandboxCommand));
            return {
                ...spawn,
                supervise: (child) => {
                    const status = spawn.supervise(child);
                    return {
                        ...status,
                        ready: status.ready.then(() => {
                            const context =
                                spawn.getSandboxContext?.() ??
                                spawn.sandboxContext;
                            if (context) options.onSandboxContext?.(context);
                        }),
                    };
                },
            };
        },
    });
}

export interface SandboxExtensionOptions {
    zeroboxBackend?: ZeroboxBackendOptions;
    /** Test-owned Analysis host seam; production keeps the default host runner. */
    analysisServiceOptions?: AnalysisSandboxServiceOptions;
    sandboxServiceOptions?: Pick<
        SandboxServiceOptions,
        "createLease" | "recoverStaleLeases"
    >;
}

export function createSandboxExtension(
    pi: ExtensionAPI,
    options: SandboxExtensionOptions = {},
) {
    const runtimeOwner = Symbol("sandbox-extension-owner");
    const createConfiguredService = (config: SandboxConfig) =>
        createSandboxService({
            backend: createZeroboxBackend(options.zeroboxBackend),
            config,
            ...options.sandboxServiceOptions,
        });
    const bashProcessSupervisors = new Set<BashProcessSupervisor>();
    const shutdownBashProcesses = (): void => {
        for (const supervisor of bashProcessSupervisors) supervisor.shutdown();
    };
    claimSandboxRuntime(runtimeOwner);
    pi.on("tool_call", (event, ctx) => {
        if (event.toolName !== "write" && event.toolName !== "edit") return;
        const path = event.input.path;
        if (
            typeof path === "string" &&
            protectsCapabilityAuthority(
                path,
                ctx.cwd,
                sandboxConfigPath(getAgentDir()),
            )
        ) {
            return {
                block: true,
                reason: "Sandbox authority files can only be changed through an explicit user /sandbox command.",
            };
        }
    });
    const breakGlassExpiryTimers = new Map<
        number,
        ReturnType<typeof setTimeout>
    >();
    let activeDockerBreakGlass: ActiveDockerBreakGlass | undefined;
    let breakGlassSequence = 0;
    /** Countdown timers for the current grant: one arm timer and one ticker. */
    let breakGlassCountdownArm: ReturnType<typeof setTimeout> | undefined;
    let breakGlassCountdownTick: ReturnType<typeof setInterval> | undefined;

    const stopBreakGlassCountdown = (): void => {
        if (breakGlassCountdownArm !== undefined) {
            clearTimeout(breakGlassCountdownArm);
            breakGlassCountdownArm = undefined;
        }
        if (breakGlassCountdownTick !== undefined) {
            clearInterval(breakGlassCountdownTick);
            breakGlassCountdownTick = undefined;
        }
    };

    const clearBreakGlassTimers = (): void => {
        for (const timer of breakGlassExpiryTimers.values())
            clearTimeout(timer);
        breakGlassExpiryTimers.clear();
        stopBreakGlassCountdown();
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
    const sandboxSupervisors = new Map<SandboxService, BashProcessSupervisor>();
    const sandboxConfigs = new Map<SandboxService, PiSandboxConfig>();
    const serviceSnapshots = new Map<SandboxService, SandboxRuntimeSnapshot>();
    const retiredSandbox = new Set<SandboxService>();
    const retiredAnalysis = new Set<AnalysisSandboxService>();
    let authorityWatch: ReturnType<typeof createAuthorityWatch> | undefined;

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
    const cleanupSandboxServiceBase = createCleanupCoordinator(
        pendingSandboxCleanup,
        inFlightSandboxCandidates,
    );
    const cleanupSandboxService = (service: SandboxService): Promise<void> => {
        const cleanup = cleanupSandboxServiceBase(service);
        void cleanup
            .finally(() => {
                const supervisor = sandboxSupervisors.get(service);
                if (supervisor) {
                    bashProcessSupervisors.delete(supervisor);
                    sandboxSupervisors.delete(service);
                }
                sandboxConfigs.delete(service);
            })
            .catch(() => {
                // The lifecycle caller owns the retained cleanup failure.
            });
        return cleanup;
    };
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
        for (const result of analysisResults) {
            if (result.status === "rejected" && failure === undefined) {
                failure = result.reason;
            } else if (result.status === "rejected") {
                attachCleanupFailure(failure, result.reason);
            }
        }
        for (const result of sandboxResults) {
            if (result.status === "rejected" && failure === undefined) {
                failure = result.reason;
            } else if (result.status === "rejected") {
                attachCleanupFailure(failure, result.reason);
            }
        }
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
        const candidate = createAnalysisSandboxService(
            options.analysisServiceOptions,
        );
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
                availability.service = {
                    run: async (request, signal) => {
                        const result = await candidate.run(request, signal);
                        const runtime = getSandboxRuntime();
                        if (
                            result.sandboxContext?.version === 3 &&
                            runtime.state === "enabled" &&
                            runtime.analysis === availability &&
                            runtime.contexts
                        ) {
                            runtime.contexts["analysis-strict"] =
                                result.sandboxContext;
                            notifySandboxRuntimeUpdated(runtimeOwner);
                        }
                        return result;
                    },
                    shutdown: () => candidate.shutdown(),
                };
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
                ctx.ui.notify("Analysis unavailable; retrying", "warning");
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
        const candidateSandbox = createConfiguredService(config);
        const candidateSupervisor = createBashProcessSupervisor();
        bashProcessSupervisors.add(candidateSupervisor);
        sandboxSupervisors.set(candidateSandbox, candidateSupervisor);
        sandboxConfigs.set(candidateSandbox, config);
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
            const observe = (
                executionOptions: SandboxBashOperationOptions,
            ): SandboxBashOperationOptions => ({
                ...executionOptions,
                onSandboxContext: (context) => {
                    executionOptions.onSandboxContext?.(context);
                    if (context.version === 3) {
                        notifySandboxRuntimeUpdated(runtimeOwner);
                        w.update(ctx);
                    }
                },
            });
            const published = publishSandboxRuntime(runtimeOwner, {
                state: "enabled",
                sandboxFingerprint: shellSandboxFingerprint(config),
                beforeAdmission: () => prepareShellExecution(ctx, ctx.cwd),
                contexts: candidateSandbox.getProfileContexts(),
                dockerAccess: summarizeDockerAccess(config.docker),
                createBashOperations: (options) =>
                    createSandboxedBashOps(
                        candidateSandbox,
                        candidateSupervisor,
                        observe(options),
                    ),
                analysis,
                createThinkBashOperations: (options) =>
                    createSandboxedBashOps(
                        candidateSandbox,
                        candidateSupervisor,
                        observe(options),
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

    let sessionConfig: SandboxConfigLayer | undefined;
    let modeSessionEpoch = 0;
    let pendingModeChange: Promise<void> | undefined;
    const waitForModeChange = async (): Promise<void> => {
        let pending = pendingModeChange;
        while (pending) {
            // oxlint-disable-next-line no-await-in-loop -- Observe queued mode requests in order before dispatching.
            await pending;
            if (pendingModeChange === pending) return;
            pending = pendingModeChange;
        }
    };
    const machineId =
        process.platform === "linux"
            ? localMachineId()
            : `unsupported-${process.platform}`;
    const loadBaseShell = (ctx: ExtensionContext, session = sessionConfig) =>
        loadSandboxConfig(ctx.cwd, {
            projectTrusted: ctx.isProjectTrusted(),
            machineId,
            session,
        });

    const applyActiveDockerBreakGlass = (
        resolved: LoadSandboxConfigResult,
    ): LoadSandboxConfigResult => {
        const active = activeDockerBreakGlass;
        if (!active) return resolved;
        if (active.expiresAtMs <= Date.now()) {
            activeDockerBreakGlass = undefined;
            stopBreakGlassCountdown();
            return resolved;
        }
        if (resolved.config.docker.mode !== "targeted") {
            activeDockerBreakGlass = undefined;
            stopBreakGlassCountdown();
            return resolved;
        }
        const baseTarget = resolved.config.docker.targets.find(
            (target) =>
                dockerSelectorKey(target.selector) === active.selectorKey &&
                (target.operations ?? DOCKER_OPERATIONS).includes("exec"),
        );
        // The resolved target carries only the exception from the current
        // global policy; project files cannot set allowUnsafeTarget.
        if (!baseTarget?.allowUnsafeTarget) {
            activeDockerBreakGlass = undefined;
            stopBreakGlassCountdown();
            return resolved;
        }
        const config: SandboxConfig = {
            ...resolved.config,
            docker: {
                ...resolved.config.docker,
                targets: [
                    ...resolved.config.docker.targets,
                    {
                        selector: {
                            type: "ephemeral-container",
                            id: active.container.id,
                            unsafeExecExpiresAtMs: active.expiresAtMs,
                        },
                        operations: ["exec"],
                        allowUnsafeTarget: true,
                    },
                ],
            },
        };
        return {
            ...resolved,
            config,
            shell: {
                ...resolved.shell,
                sandboxFingerprint: shellSandboxFingerprint(config),
            },
        };
    };

    const loadShell = (ctx: ExtensionContext, session = sessionConfig) =>
        applyActiveDockerBreakGlass(loadBaseShell(ctx, session));

    /** Revoke first. A replacement failure cannot resurrect admitted authority. */
    const revokeServices = async (
        ctx: ExtensionContext,
        reason: unknown,
    ): Promise<void> => {
        beginTransition(ctx);
        sandboxEnabled = false;
        publishError(reason);
        updateSandboxStatus(ctx, "error");
        shutdownBashProcesses();
        // Closing Analysis terminates its workers. Shell snapshots are awaited
        // before deleting leases, including descendants that retained descriptors.
        const analysisTargets = new Set([
            ...retiredAnalysis,
            ...inFlightAnalysisCandidates,
            ...pendingAnalysisCleanup,
            ...(analysisService ? [analysisService] : []),
        ]);
        await Promise.all([
            ...[...analysisTargets].map(cleanupAnalysisService),
            ...[...serviceSnapshots.values()].map(whenSandboxRuntimeIdle),
        ]);
        await shutdownServices(undefined, undefined, true);
        retiredSandbox.clear();
        retiredAnalysis.clear();
        serviceSnapshots.clear();
    };

    /** Only additive changes may retain the previous admitted generation. */
    const reconfigureServices = async (
        ctx: ExtensionContext,
        resolved: LoadSandboxConfigResult,
        presentation = resolved.shell,
    ): Promise<boolean> => {
        if (
            [...sandboxConfigs.values()].some((previous) =>
                sandboxAccessRemoved(previous, resolved.config, ctx.cwd),
            )
        ) {
            await revokeServices(
                ctx,
                new Error(
                    "Sandbox authority was revoked; replacement admission is required",
                ),
            );
        }
        const previous = getSandboxRuntime();
        const previousFooter = {
            state: sandboxFooterState,
            docker: sandboxDockerFooterState,
            shell: sandboxShellFooterState,
        };
        const generation = beginTransition(ctx, false, true);
        if (generation === undefined) return false;
        try {
            const enabled = await enableServices(
                ctx.cwd,
                resolved.config,
                generation,
                ctx,
                true,
            );
            if (!isCurrentTransition(generation) || !enabled) return false;
            sandboxEnabled = true;
            if (activeDockerBreakGlass && sandboxService) {
                const supervisor = sandboxSupervisors.get(sandboxService);
                if (supervisor)
                    activeDockerBreakGlass.supervisors.add(supervisor);
            }
            updateSandboxStatus(
                ctx,
                presentation.mode === "host" ? "off" : "on",
                resolved.config.docker,
                presentation,
            );
            if (activeDockerBreakGlass) {
                scheduleBreakGlassExpiry(ctx, activeDockerBreakGlass);
                scheduleBreakGlassCountdown(ctx, activeDockerBreakGlass);
            }
            return true;
        } catch (error) {
            if (isCurrentTransition(generation)) {
                sandboxEnabled = previous.state === "enabled";
                if (previous.state === "enabled")
                    publishSandboxRuntime(runtimeOwner, previous);
                else publishError(error);
                sandboxFooterState = previousFooter.state;
                sandboxDockerFooterState = previousFooter.docker;
                sandboxShellFooterState = previousFooter.shell;
                w.update(ctx);
            }
            throw error;
        }
    };

    const selectSessionMode = async (
        ctx: ExtensionContext,
        mode: SandboxMode,
    ): Promise<void> => {
        const epoch = modeSessionEpoch;
        const previous = pendingModeChange;
        // A later explicit request may recover from an earlier failed request.
        const change = Promise.resolve(previous)
            .catch(() => undefined)
            .then(async () => {
                const assertCurrentSession = () => {
                    if (
                        epoch !== modeSessionEpoch ||
                        !ownsSandboxRuntime(runtimeOwner)
                    )
                        throw new Error(
                            "The session changed before the requested mode could be applied",
                        );
                };
                assertCurrentSession();
                const nextSession = { ...sessionConfig, mode };
                const resolved = loadShell(ctx, nextSession);
                const fingerprint = shellSandboxFingerprint(resolved.config);
                const runtime = getSandboxRuntime();
                if (
                    runtime.state !== "enabled" ||
                    runtime.sandboxFingerprint !== fingerprint
                ) {
                    if (!(await reconfigureServices(ctx, resolved)))
                        throw new Error(
                            "The requested mode transition was superseded before it completed. Select the mode again after the current transition finishes",
                        );
                }
                assertCurrentSession();
                const latest = loadShell(ctx, nextSession);
                if (shellSandboxFingerprint(latest.config) !== fingerprint)
                    throw new Error(
                        "Sandbox configuration changed during mode selection. The requested mode was not applied",
                    );
                sessionConfig = nextSession;
                // Existing resolver closures read sessionConfig. Keep their identity stable for waiting calls.
                updateSandboxStatus(
                    ctx,
                    mode === "host" ? "off" : "on",
                    latest.config.docker,
                    latest.shell,
                );
                ctx.ui.notify(
                    `Session mode: ${latest.shell.mode} (${latest.shell.profile})`,
                    "info",
                );
            });
        pendingModeChange = change;
        try {
            await change;
        } catch (error) {
            if (
                epoch === modeSessionEpoch &&
                ownsSandboxRuntime(runtimeOwner)
            ) {
                try {
                    const applied = loadShell(ctx);
                    const runtime = getSandboxRuntime();
                    let modeState: SandboxFooterState = "error";
                    if (runtime.state === "enabled") {
                        modeState =
                            applied.shell.mode === "host" ? "off" : "on";
                    }
                    updateSandboxStatus(
                        ctx,
                        modeState,
                        applied.config.docker,
                        applied.shell,
                    );
                } catch {
                    updateSandboxStatus(ctx, "error");
                }
            }
            ctx.ui.notify(
                `Sandbox mode was not applied: ${configurationErrorMessage(error)}`,
                "error",
            );
        } finally {
            if (pendingModeChange === change) pendingModeChange = undefined;
        }
    };

    const prepareShellExecution = async (
        ctx: ExtensionContext,
        cwd: string,
    ): Promise<void> => {
        const projectRoot = realpathSync(ctx.cwd);
        const executionRoot = realpathSync(cwd);
        if (
            executionRoot !== projectRoot &&
            !executionRoot.startsWith(`${projectRoot}/`)
        )
            return;
        await waitForModeChange();
        await authorityWatch?.check();
        await waitForModeChange();
        const resolved = loadShell(ctx);
        const fingerprint = shellSandboxFingerprint(resolved.config);
        const runtime = getSandboxRuntime();
        if (
            runtime.state === "enabled" &&
            runtime.sandboxFingerprint === fingerprint
        ) {
            return;
        }
        if (!(await reconfigureServices(ctx, resolved))) {
            throw new Error(
                "Sandbox configuration changed but the replacement runtime was not admitted",
            );
        }
    };

    const prepareForcedSandboxExecution = async (
        ctx: ExtensionContext,
        cwd: string,
    ): Promise<void> => {
        const projectRoot = realpathSync(ctx.cwd);
        const executionRoot = realpathSync(cwd);
        if (
            executionRoot !== projectRoot &&
            !executionRoot.startsWith(`${projectRoot}/`)
        ) {
            return;
        }
        await waitForModeChange();
        await authorityWatch?.check();
        await waitForModeChange();
        const forced = loadShell(ctx, {
            ...sessionConfig,
            mode: "sandbox",
        });
        const runtime = getSandboxRuntime();
        if (
            runtime.state === "enabled" &&
            runtime.sandboxFingerprint ===
                shellSandboxFingerprint(forced.config)
        ) {
            return;
        }
        if (!(await reconfigureServices(ctx, forced, loadShell(ctx).shell))) {
            throw new Error(
                "Sandbox configuration changed but the replacement runtime was not admitted",
            );
        }
    };

    pi.registerFlag("no-sandbox", {
        description:
            "Request the host shell profile using an existing local authorization",
        type: "boolean",
        default: false,
    });

    registerSandboxModelContext(pi);

    let sandboxEnabled = false;
    let sandboxFooterState: SandboxFooterState = "off";
    let sandboxShellFooterState: Pick<
        ShellCapabilityResolution,
        "mode" | "profile"
    > = { mode: "sandbox", profile: "default" };
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
        render: (rctx) => renderSandboxFooter(rctx.theme),
    });

    function renderSandboxFooter(
        theme: import("@earendil-works/pi-coding-agent").Theme,
    ): string | null {
        return renderSandboxWidget(
            theme,
            sandboxFooterState,
            sandboxDockerFooterState,
            sandboxShellFooterState,
            getSandboxRuntime().state === "enabled" &&
                sandboxService?.getProfileContexts()["bash-general"].version ===
                    3
                ? "admitted"
                : "pending",
        );
    }

    /**
     * Refresh the widget with a freshly rendered countdown. Only the countdown
     * ticker passes fallback text, so a fallback footer stays hidden unless a
     * break-glass deadline is being counted down.
     */
    function refreshSandboxCountdown(ctx: ExtensionContext): void {
        w.update(ctx, renderSandboxFooter(ctx.ui.theme));
    }

    function updateSandboxStatus(
        ctx: ExtensionContext,
        status: SandboxFooterState,
        docker?: SandboxDockerPolicy,
        shell?: Pick<ShellCapabilityResolution, "mode" | "profile">,
    ): void {
        if (shell) sandboxShellFooterState = shell;
        else {
            // Retain the last selected state when configuration cannot be read.
            try {
                sandboxShellFooterState = loadShell(ctx).shell;
            } catch {
                /* The caller reports configuration failures. */
            }
        }
        sandboxFooterState = status;
        sandboxDockerFooterState = dockerFooterState(
            docker ?? { mode: "disabled" },
            status === "on" && sandboxShellFooterState.mode === "sandbox",
            activeDockerBreakGlass?.expiresAtMs,
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
        grant: ActiveDockerBreakGlass,
    ): void {
        const previousTimer = breakGlassExpiryTimers.get(grant.id);
        if (previousTimer) clearTimeout(previousTimer);
        const delay = Math.max(1, grant.expiresAtMs - Date.now());
        const timer = setTimeout(() => {
            breakGlassExpiryTimers.delete(grant.id);
            stopBreakGlassCountdown();
            if (!ownsSandboxRuntime(runtimeOwner)) return;
            const currentGrant = activeDockerBreakGlass;
            if (currentGrant?.id !== grant.id) {
                for (const supervisor of grant.supervisors)
                    supervisor.shutdown();
                sendSandboxRuntimeFeedback(
                    ctx,
                    `Docker break-glass expired for ${grant.container.name} (${grant.container.id}). The retired command runtime was interrupted; newer Sandbox runtimes were left active.`,
                );
                return;
            }
            activeDockerBreakGlass = undefined;
            const generation = beginTransition(ctx);
            if (generation === undefined) return;
            sendSandboxRuntimeFeedback(
                ctx,
                `Docker break-glass expired for ${grant.container.name} (${grant.container.id}). Arbitrary Docker exec is no longer authorized for this container. Do not retry an exec that depends on this exception unless the user activates a new break-glass grant.`,
            );
            for (const supervisor of grant.supervisors) supervisor.shutdown();
            void (async () => {
                try {
                    await shutdownServices();
                    if (!isCurrentTransition(generation)) return;
                    const resolved = loadBaseShell(ctx);
                    const enabled = await enableServices(
                        ctx.cwd,
                        resolved.config,
                        generation,
                        ctx,
                    );
                    if (!isCurrentTransition(generation) || !enabled) return;
                    sandboxEnabled = true;
                    updateSandboxStatus(ctx, "on", resolved.config.docker);
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
        timer.unref?.();
        breakGlassExpiryTimers.set(grant.id, timer);
    }

    /**
     * Drive the widget countdown for the final window before expiry. Outside
     * that window no timer runs; inside it the widget refreshes once per second
     * so the remaining time stays visible, including in fallback mode.
     */
    function scheduleBreakGlassCountdown(
        ctx: ExtensionContext,
        grant: ActiveDockerBreakGlass,
    ): void {
        stopBreakGlassCountdown();
        const remaining = grant.expiresAtMs - Date.now();
        if (remaining <= 0) return;
        const arm = (): void => {
            if (!ownsSandboxRuntime(runtimeOwner)) {
                stopBreakGlassCountdown();
                return;
            }
            if (activeDockerBreakGlass?.id !== grant.id) {
                stopBreakGlassCountdown();
                return;
            }
            // Render the boundary value immediately so the first visible second
            // is exact rather than one tick late.
            refreshSandboxCountdown(ctx);
            breakGlassCountdownTick = setInterval(() => {
                const current = activeDockerBreakGlass;
                if (
                    !ownsSandboxRuntime(runtimeOwner) ||
                    current?.id !== grant.id ||
                    current.expiresAtMs <= Date.now()
                ) {
                    stopBreakGlassCountdown();
                    return;
                }
                refreshSandboxCountdown(ctx);
            }, BREAK_GLASS_COUNTDOWN_TICK_MS);
            breakGlassCountdownTick.unref?.();
        };
        breakGlassCountdownArm = setTimeout(
            arm,
            Math.max(0, remaining - BREAK_GLASS_COUNTDOWN_WINDOW_MS),
        );
        breakGlassCountdownArm.unref?.();
    }

    // Resolve local shell authority independently from strict engine startup.
    pi.on("session_start", async (_event, ctx) => {
        if (!ownsSandboxRuntime(runtimeOwner)) return;
        modeSessionEpoch += 1;
        pendingModeChange = undefined;
        claimSandboxRuntime(runtimeOwner);
        const noSandbox = pi.getFlag("no-sandbox") as boolean;
        sessionConfig = noSandbox ? { mode: "host" } : undefined;
        authorityWatch?.close();
        const policies = new Map<string, SandboxConfig>();
        authorityWatch = createAuthorityWatch({
            paths: [
                sandboxConfigPath(getAgentDir()),
                join(ctx.cwd, ".pi/sandbox.json"),
            ],
            read: async () => {
                const resolved = loadShell(ctx);
                const key = shellSandboxFingerprint(resolved.config);
                policies.set(key, resolved.config);
                return { key, grants: [] };
            },
            compare: (previous, next) => {
                const before = policies.get(previous.key),
                    after = policies.get(next.key);
                const allowed = Boolean(
                    before &&
                    after &&
                    !sandboxAccessRemoved(before, after, ctx.cwd),
                );
                // Keep only the current comparison pair, never environment values in logs.
                for (const key of policies.keys())
                    if (key !== next.key && key !== previous.key)
                        policies.delete(key);
                return allowed;
            },
            hasActiveProcesses: () =>
                getSandboxActiveExecutionCount(runtimeOwner) > 0,
            onRevoked: async (reason) => {
                if (!ownsSandboxRuntime(runtimeOwner)) return;
                try {
                    const next = loadShell(ctx).config;
                    if (
                        ![...sandboxConfigs.values()].some((previous) =>
                            sandboxAccessRemoved(previous, next, ctx.cwd),
                        )
                    )
                        return;
                } catch {
                    // An unreadable authority invalidates every existing generation.
                }
                await revokeServices(
                    ctx,
                    reason ??
                        new Error(
                            "Sandbox authority was revoked; new admission is required",
                        ),
                );
            },
            onError: (error) => {
                publishError(error);
                updateSandboxStatus(ctx, "error");
                ctx.ui.notify(
                    `Sandbox authority monitoring failed: ${errorMessage(error)}`,
                    "error",
                );
            },
        });
        await authorityWatch.check();
        publishShellRuntime(
            runtimeOwner,
            () => loadShell(ctx).shell,
            (cwd) => prepareShellExecution(ctx, cwd),
            () => loadShell(ctx, { ...sessionConfig, mode: "sandbox" }).shell,
            (cwd) => prepareForcedSandboxExecution(ctx, cwd),
        );
        const generation = beginTransition(ctx, true);
        if (generation === undefined) return;
        shutdownBashProcesses();

        let resolved: LoadSandboxConfigResult;
        try {
            resolved = loadShell(ctx);
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
            let initializedState: SandboxFooterState = "on";
            if (resolved.shell.state !== "ready")
                initializedState = "restricted";
            else if (resolved.shell.mode === "host") initializedState = "off";
            updateSandboxStatus(ctx, initializedState, config.docker);
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
        modeSessionEpoch += 1;
        pendingModeChange = undefined;
        authorityWatch?.close();
        authorityWatch = undefined;
        releaseShellRuntime(runtimeOwner);
        clearBreakGlassTimers();
        activeDockerBreakGlass = undefined;
        const generation = beginTransition();
        shutdownBashProcesses();
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
            "Inspect shell policy, select the session mode, or configure Docker access",
        getArgumentCompletions: (prefix: string) => {
            const values = [
                "status",
                "mode",
                "doctor",
                "installations",
                "migrate",
                "recover",
                "docker",
                "docker on",
                "docker off",
                "docker break-glass",
                "docker break-glass 5m",
                "docker break-glass 15m",
                "docker break-glass 30m",
                "docker break-glass 60m",
                "mode sandbox",
                "mode host",
            ];
            const filtered = values.filter((value) =>
                value.startsWith(prefix.trimStart().toLowerCase()),
            );
            return filtered.length > 0
                ? filtered.map((value) => ({ value, label: value }))
                : null;
        },
        handler: async (args, ctx) => {
            let arg = args.trim().toLowerCase();
            if ((!arg || arg === "mode") && ctx.hasUI) {
                try {
                    const resolved = loadShell(ctx);
                    if (!arg) {
                        const choice = await ctx.ui.select(
                            renderSandboxStatusDetails(
                                resolved,
                                sandboxEnabled,
                                getActiveDockerSummary(),
                                getSandboxRuntime().state,
                            ),
                            [
                                "Change session mode",
                                "Inspect effective permissions",
                                "Manage local installations",
                                "Cancel",
                            ],
                        );
                        if (!choice || choice === "Cancel") return;
                        if (choice === "Change session mode") arg = "mode";
                        else if (choice === "Manage local installations")
                            arg = "installations";
                        else arg = "doctor";
                    }
                    if (arg === "mode") {
                        const hostChoice = resolved.shell.hostAllowed
                            ? "host"
                            : "host (unavailable: global host.allowed is false)";
                        const choice = await ctx.ui.select(
                            `Session mode: ${resolved.shell.mode}. The custom profile applies automatically from configuration.`,
                            ["sandbox", hostChoice, "Cancel"],
                        );
                        if (!choice || choice === "Cancel") return;
                        if (
                            choice === hostChoice &&
                            !resolved.shell.hostAllowed
                        ) {
                            ctx.ui.notify(
                                `Host mode is unavailable. Set host.allowed in ${sandboxConfigPath(getAgentDir())} to authorize it. The project cannot grant host access.`,
                                "warning",
                            );
                            return;
                        }
                        arg = `mode ${choice}`;
                    }
                } catch (error) {
                    ctx.ui.notify(
                        `Sandbox configuration failed: ${configurationErrorMessage(error)}`,
                        "error",
                    );
                    return;
                }
            }
            if (
                [
                    "2",
                    "p2",
                    "profile 2",
                    "profile p2",
                    "mode 2",
                    "mode p2",
                ].includes(arg)
            ) {
                ctx.ui.notify(
                    "The custom profile (formerly P2) is automatic when sandbox.json grants resources. Use /sandbox mode sandbox, then /sandbox doctor to inspect the effective policy.",
                    "info",
                );
                return;
            }
            if (arg === "mode sandbox" || arg === "mode host") {
                await selectSessionMode(
                    ctx,
                    arg === "mode host" ? "host" : "sandbox",
                );
                return;
            }
            if (arg === "installations") {
                await manageInstallations(ctx, {
                    agentDir: getAgentDir(),
                    machineId,
                    onChanged: async () => {
                        await reconfigureServices(ctx, loadShell(ctx));
                    },
                });
                return;
            }
            if (arg === "migrate") {
                if (!ctx.hasUI) {
                    ctx.ui.notify(
                        "Migration requires an interactive user decision",
                        "error",
                    );
                    return;
                }
                try {
                    const globalPath = sandboxConfigPath(getAgentDir());
                    const preview = previewLegacyMigration(
                        getAgentDir(),
                        machineId,
                        ctx.cwd,
                    );
                    if (!preview.required) {
                        loadShell(ctx);
                        ctx.ui.notify(
                            "Sandbox configuration is already current. No files were changed or archived.",
                            "info",
                        );
                        return;
                    }
                    const useProposed = "Apply the proposed global ceiling";
                    const useStrict = "Use the strict default global ceiling";
                    const choice = await ctx.ui.select(
                        `${formatMigrationPreview(preview)}\n\nChoose the global ceiling to publish.`,
                        [useProposed, useStrict, "Cancel"],
                    );
                    if (choice !== useProposed && choice !== useStrict) {
                        ctx.ui.notify("Sandbox migration cancelled", "info");
                        return;
                    }
                    const globalCeiling =
                        choice === useProposed ? preview.proposedGlobal : {};
                    const result = await withFileMutationQueue(
                        globalPath,
                        async () =>
                            publishLegacyMigration({
                                preview,
                                globalPath,
                                projectPath: join(
                                    ctx.cwd,
                                    ".pi",
                                    "sandbox.json",
                                ),
                                machineId,
                                globalCeiling,
                            }),
                    );
                    const resolved = loadShell(ctx);
                    await reconfigureServices(ctx, resolved);
                    ctx.ui.notify(
                        `Sandbox migration completed; archived ${result.archives.length} historic file(s).`,
                        "info",
                    );
                } catch (error) {
                    ctx.ui.notify(
                        `Sandbox migration failed: ${configurationErrorMessage(error)}`,
                        "error",
                    );
                }
                return;
            }
            if (arg === "recover") {
                if (!ctx.hasUI) {
                    ctx.ui.notify(
                        "Migration recovery changes sandbox.json only after verification. Run /sandbox recover interactively.",
                        "error",
                    );
                    return;
                }
                try {
                    const globalPath = sandboxConfigPath(getAgentDir());
                    const recovery = await withFileMutationQueue(
                        globalPath,
                        async () => recoverIncompleteMigration(globalPath),
                    );
                    if (!recovery) {
                        ctx.ui.notify(
                            "No interrupted sandbox migration was found.",
                            "info",
                        );
                        return;
                    }
                    const resolved = loadShell(ctx);
                    if (!(await reconfigureServices(ctx, resolved))) return;
                    ctx.ui.notify(
                        "Sandbox migration recovery " +
                            recovery.recovered +
                            ".",
                        "info",
                    );
                } catch (error) {
                    ctx.ui.notify(
                        "Sandbox migration recovery failed: " +
                            configurationErrorMessage(error),
                        "error",
                    );
                }
                return;
            }
            if (arg === "docker on" || arg === "docker off") {
                if (!ctx.isProjectTrusted()) {
                    ctx.ui.notify(
                        "Docker activation requires a trusted project",
                        "error",
                    );
                    return;
                }
                try {
                    const resolved = await persistProjectDockerPreference(
                        ctx.cwd,
                        arg === "docker on" ? "on" : "off",
                    );
                    if (!(await reconfigureServices(ctx, resolved))) return;
                    ctx.ui.notify(
                        `Docker project activation saved: ${resolved.config.docker.mode === "disabled" ? "off" : "on"}`,
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
                const match = /^docker break-glass(?:\s+(\S+))?$/.exec(arg);
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
                let durationMinutes: number;
                try {
                    const resolved = loadShell(ctx);
                    baseConfig = resolved.config;
                    // The ceiling is global configuration, so the range is
                    // validated only after the authority files are read.
                    const requested = parseDockerBreakGlassDurationMinutes(
                        match?.[1],
                    );
                    if (
                        !match ||
                        requested === undefined ||
                        requested < DOCKER_BREAK_GLASS_MIN_MINUTES ||
                        requested > resolved.breakGlassMaxMinutes
                    ) {
                        ctx.ui.notify(
                            dockerBreakGlassDurationUsage(
                                resolved.breakGlassMaxMinutes,
                            ),
                            "error",
                        );
                        return;
                    }
                    durationMinutes = requested;
                    if (baseConfig.docker.mode !== "targeted") {
                        ctx.ui.notify(
                            "Docker break-glass is available only for targeted host-access grants",
                            "error",
                        );
                        return;
                    }
                    const candidates = dockerBreakGlassCandidates(
                        baseConfig.docker,
                        await inspectDockerAccess(ctx.cwd, baseConfig, {
                            createService: createConfiguredService,
                        }),
                    );
                    if (candidates.length === 0) {
                        ctx.ui.notify(
                            "No accessible global Docker target permits break-glass exec.",
                            "error",
                        );
                        return;
                    }
                    if (candidates.length === 1) candidate = candidates[0]!;
                    else {
                        const labels = candidates.map(
                            ({ container }) =>
                                `${container.name} (${container.id.slice(0, 12)})`,
                        );
                        const selected = await ctx.ui.select(
                            "Container for temporary arbitrary exec",
                            labels,
                        );
                        const index =
                            selected === undefined
                                ? -1
                                : labels.indexOf(selected);
                        if (index < 0) {
                            ctx.ui.notify(
                                "Docker break-glass cancelled",
                                "info",
                            );
                            return;
                        }
                        candidate = candidates[index]!;
                    }
                } catch (error) {
                    ctx.ui.notify(
                        `Docker break-glass inspection failed: ${configurationErrorMessage(error)}`,
                        "error",
                    );
                    return;
                }
                const expiresAtMs = Date.now() + durationMinutes * 60_000;
                const accepted = await ctx.ui.confirm(
                    "Temporarily allow arbitrary Docker exec?",
                    [
                        `Target: ${dockerSelectorLabel(candidate.target.selector)}`,
                        `Exact container: ${candidate.container.name} (${candidate.container.id})`,
                        ...formatDockerAccess([candidate.access]),
                        `This current-session exception expires after ${durationMinutes} minute${durationMinutes === 1 ? "" : "s"}.`,
                        "Expiration interrupts running Sandbox commands; they are not retried.",
                    ].join("\n"),
                );
                if (!accepted) {
                    ctx.ui.notify("Docker break-glass cancelled", "info");
                    return;
                }
                // The selection/confirmation UI may have yielded while an
                // authority file was edited. Re-read both layers and inspect
                // the exact container before turning a temporary exception on.
                try {
                    const refreshed = loadBaseShell(ctx);
                    if (refreshed.config.docker.mode !== "targeted") {
                        ctx.ui.notify(
                            "Docker break-glass was not activated because the current authority no longer permits targeted host access.",
                            "error",
                        );
                        return;
                    }
                    const refreshedCandidate = dockerBreakGlassCandidates(
                        refreshed.config.docker,
                        await inspectDockerAccess(ctx.cwd, refreshed.config, {
                            createService: createConfiguredService,
                        }),
                    ).find(
                        (current) =>
                            current.container.id === candidate.container.id &&
                            dockerSelectorKey(current.target.selector) ===
                                dockerSelectorKey(candidate.target.selector),
                    );
                    if (!refreshedCandidate) {
                        ctx.ui.notify(
                            "Docker break-glass was not activated because the selected container is no longer authorized.",
                            "error",
                        );
                        return;
                    }
                    candidate = refreshedCandidate;
                    baseConfig = refreshed.config;
                } catch (error) {
                    ctx.ui.notify(
                        `Docker break-glass revalidation failed: ${configurationErrorMessage(error)}`,
                        "error",
                    );
                    return;
                }
                activeDockerBreakGlass = {
                    id: ++breakGlassSequence,
                    selectorKey: dockerSelectorKey(candidate.target.selector),
                    expiresAtMs,
                    container: {
                        id: candidate.container.id,
                        name: candidate.container.name,
                    },
                    supervisors: new Set(),
                };
                const runtimeResolved = loadShell(ctx);
                if (runtimeResolved.config.docker.mode !== "targeted") {
                    activeDockerBreakGlass = undefined;
                    ctx.ui.notify(
                        "Docker break-glass was not activated because the current authority no longer permits targeted host access.",
                        "error",
                    );
                    return;
                }
                const runtimeDocker = runtimeResolved.config.docker;
                const generation = beginTransition(ctx);
                if (generation === undefined) return;
                shutdownBashProcesses();
                try {
                    await shutdownServices();
                    if (!isCurrentTransition(generation)) return;
                    const enabled = await enableServices(
                        ctx.cwd,
                        runtimeResolved.config,
                        generation,
                        ctx,
                    );
                    if (!isCurrentTransition(generation) || !enabled) return;
                    sandboxEnabled = true;
                    if (sandboxService) {
                        const supervisor =
                            sandboxSupervisors.get(sandboxService);
                        if (supervisor)
                            activeDockerBreakGlass.supervisors.add(supervisor);
                    }
                    updateSandboxStatus(ctx, "on", runtimeDocker);
                    scheduleBreakGlassExpiry(ctx, activeDockerBreakGlass);
                    scheduleBreakGlassCountdown(ctx, activeDockerBreakGlass);
                    ctx.ui.notify(
                        `Break-glass exec active for container ${candidate.container.name}.`,
                        "warning",
                    );
                } catch (error) {
                    if (!isCurrentTransition(generation)) return;
                    activeDockerBreakGlass = undefined;
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
            try {
                const resolved = loadShell(ctx);
                if (arg === "doctor" || arg.startsWith("doctor ")) {
                    const runtime = getSandboxRuntime();
                    const context =
                        runtime.state === "enabled" &&
                        runtime.sandboxFingerprint ===
                            resolved.shell.sandboxFingerprint
                            ? runtime.contexts?.["bash-general"]
                            : undefined;
                    let bundle:
                        | Awaited<
                              ReturnType<typeof inspectManagedPrivateRuntime>
                          >
                        | undefined;
                    let distributionDiagnostic = "";
                    try {
                        bundle = await inspectManagedPrivateRuntime(
                            options.zeroboxBackend,
                        );
                    } catch (error) {
                        distributionDiagnostic = `\nRuntime verification failed: ${errorMessage(error)}`;
                    }
                    ctx.ui.notify(
                        sandboxDoctor(
                            resolved,
                            arg === "doctor"
                                ? undefined
                                : args.trim().slice(7).trim(),
                            context,
                            bundle,
                        ) + distributionDiagnostic,
                        "info",
                    );
                    return;
                }
                if (
                    !arg ||
                    arg === "status" ||
                    arg === "mode" ||
                    arg === "docker"
                ) {
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
                    `Usage: /sandbox [status | doctor [executable] | installations | migrate | recover | mode [sandbox|host] | docker [on|off|break-glass [1m-${resolved.breakGlassMaxMinutes}m]]]`,
                    "error",
                );
            } catch (error) {
                ctx.ui.notify(
                    `Sandbox configuration failed: ${configurationErrorMessage(error)}`,
                    "error",
                );
            }
        },
    });
}

export default createSandboxExtension;
