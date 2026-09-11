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

import { spawn } from "node:child_process";
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
    type AnalysisSandboxServiceOptions,
} from "./analysis/client.ts";
import {
    localMachineId,
    readGlobalSandboxConfig,
    readProjectSandboxConfig,
    sandboxConfigPath,
    type SandboxConfigLayer,
    type SandboxMode,
} from "./capabilities/authority.ts";
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
import { sandboxDoctor } from "./doctor.ts";
import {
    DOCKER_OPERATIONS,
    SandboxExecutionError,
    type SandboxCommand,
    type SandboxDockerPolicy,
    type DockerTargetGrant,
    type DockerTargetSelector,
} from "./runtime/contracts.ts";
import { createDefaultSandboxBaseline } from "./runtime/default-config.ts";
import {
    dockerSelectorKey,
    dockerPolicyHasUnsafeTargets,
    DEFAULT_DOCKER_ENDPOINT,
    resolveDockerPolicy,
} from "./runtime/docker-policy.ts";
import { type PiSandboxConfig } from "./runtime/policies.ts";
import {
    createSandboxService,
    type SandboxService,
    type SandboxServiceOptions,
} from "./runtime/service.ts";
import {
    createZeroboxBackend,
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

/** Render selected shell mode and policy independently of engine readiness. */
export function renderSandboxWidget(
    theme: import("@earendil-works/pi-coding-agent").Theme,
    state: SandboxFooterState,
    docker: SandboxDockerFooterState = { mode: "off", unsafe: false },
    shell?: Pick<ShellCapabilityResolution, "mode" | "profile">,
): string | null {
    const colors: UiColorsCreation = createUiColors(theme);
    if (shell) {
        const runtime = state === "on" ? "ready" : state;
        const value =
            shell.mode === "host"
                ? `host · unsandboxed${state === "error" || state === "reconfiguring" ? ` · ${state}` : ""}`
                : `sandbox · ${shell.profile} · ${runtime}`;
        return `${colors.subtle("Shell:")} ${shell.mode === "host" ? colors.warning(value) : state === "error" ? colors.danger(value) : state === "on" ? colors.primary(value) : colors.warning(value)} | ${colors.subtle("Docker:")} ${colorForDockerState(colors, docker)}`;
    }
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
    const status =
        resolved.shell.mode === "host"
            ? "HOST (unsandboxed)"
            : sandboxActive
              ? "ENABLED"
              : "DISABLED";
    const securityLabel = explicitlyDisabled(resolved) ? `${status} ⚠` : status;
    const dockerStatus =
        resolved.shell.mode === "host"
            ? "off (shell mode is host)"
            : sandboxActive
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

function activeDockerLines(configured: SandboxDockerPolicy): string[] {
    const runtime = getSandboxRuntime();
    return formatActiveDocker(
        summarizeDockerAccess(configured),
        runtime.state === "enabled" ? runtime.dockerAccess : undefined,
        runtime.state,
    );
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

function resourceAccessRemoved(
    previous: PiSandboxConfig,
    next: PiSandboxConfig,
): boolean {
    const previousResources = previous.resources ?? {
        unixSockets: [],
        tcpPublications: [],
    };
    const nextResources = next.resources ?? {
        unixSockets: [],
        tcpPublications: [],
    };
    const nextSockets = new Set(nextResources.unixSockets);
    if (
        previousResources.unixSockets.some((socket) => !nextSockets.has(socket))
    )
        return true;
    const publicationKey = (
        publication: (typeof previousResources.tcpPublications)[number],
    ) =>
        `${publication.transport}\0${publication.scope}\0${publication.listen}\0${publication.target}`;
    const nextPublications = new Set(
        nextResources.tcpPublications.map(publicationKey),
    );
    return previousResources.tcpPublications.some(
        (publication) => !nextPublications.has(publicationKey(publication)),
    );
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
    const source: SandboxConfigSource = project
        ? "project-config"
        : global
          ? "global-config"
          : "default";
    return { ...policy, config: { ...policy.config, docker }, source };
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

    const clearBreakGlassExpiry = (): void => {
        for (const timer of breakGlassExpiryTimers.values())
            clearTimeout(timer);
        breakGlassExpiryTimers.clear();
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
            const published = publishSandboxRuntime(runtimeOwner, {
                state: "enabled",
                sandboxFingerprint: shellSandboxFingerprint(config),
                contexts: candidateSandbox.getProfileContexts(),
                dockerAccess: summarizeDockerAccess(config.docker),
                createBashOperations: (options) =>
                    createSandboxedBashOps(
                        candidateSandbox,
                        candidateSupervisor,
                        options,
                    ),
                analysis,
                createThinkBashOperations: (options) =>
                    createSandboxedBashOps(
                        candidateSandbox,
                        candidateSupervisor,
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
            // A drained runtime can continue only while its resource grants are
            // still valid. Its process tree owns any Unix socket or TCP bridge.
            for (const [service, supervisor] of sandboxSupervisors) {
                if (service === candidateSandbox) continue;
                const previousConfig = sandboxConfigs.get(service);
                if (
                    previousConfig &&
                    resourceAccessRemoved(previousConfig, config)
                ) {
                    supervisor.shutdown();
                }
            }
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
            return resolved;
        }
        if (resolved.config.docker.mode !== "targeted") {
            activeDockerBreakGlass = undefined;
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

    /**
     * Start a candidate before retiring the admitted runtime. Commands already
     * admitted to the old snapshot drain; a failed candidate restores that
     * snapshot instead of silently changing the active mode.
     */
    const reconfigureServices = async (
        ctx: ExtensionContext,
        resolved: LoadSandboxConfigResult,
        presentation = resolved.shell,
    ): Promise<boolean> => {
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
            }
            return true;
        } catch (error) {
            if (isCurrentTransition(generation)) {
                sandboxEnabled = previous.state === "enabled";
                publishSandboxRuntime(runtimeOwner, previous);
                sandboxFooterState = previousFooter.state;
                sandboxDockerFooterState = previousFooter.docker;
                sandboxShellFooterState = previousFooter.shell;
                w.update(ctx);
            }
            throw error;
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
            !executionRoot.startsWith(projectRoot + "/")
        )
            return;
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
            !executionRoot.startsWith(projectRoot + "/")
        ) {
            return;
        }
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
        render: (ctx) =>
            renderSandboxWidget(
                ctx.theme,
                sandboxFooterState,
                sandboxDockerFooterState,
                sandboxShellFooterState,
            ),
    });

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

    // Resolve local shell authority independently from strict engine startup.
    pi.on("session_start", async (_event, ctx) => {
        if (!ownsSandboxRuntime(runtimeOwner)) return;
        claimSandboxRuntime(runtimeOwner);
        const noSandbox = pi.getFlag("no-sandbox") as boolean;
        sessionConfig = noSandbox ? { mode: "host" } : undefined;
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
            updateSandboxStatus(
                ctx,
                resolved.shell.state !== "ready"
                    ? "restricted"
                    : resolved.shell.mode === "host"
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
        clearBreakGlassExpiry();
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
                "migrate",
                "recover",
                "docker",
                "docker on",
                "docker off",
                "docker break-glass",
                "docker break-glass 5m",
                "docker break-glass 15m",
                "docker break-glass 30m",
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
                                "Cancel",
                            ],
                        );
                        if (!choice || choice === "Cancel") return;
                        arg =
                            choice === "Change session mode"
                                ? "mode"
                                : "doctor";
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
                const nextSession = {
                    ...sessionConfig,
                    mode: arg === "mode host" ? "host" : "sandbox",
                } satisfies SandboxConfigLayer;
                try {
                    const resolved = loadShell(ctx, nextSession);
                    if (!(await reconfigureServices(ctx, resolved))) return;
                    sessionConfig = nextSession;
                    publishShellRuntime(
                        runtimeOwner,
                        () => loadShell(ctx).shell,
                        (cwd) => prepareShellExecution(ctx, cwd),
                        () =>
                            loadShell(ctx, {
                                ...sessionConfig,
                                mode: "sandbox",
                            }).shell,
                        (cwd) => prepareForcedSandboxExecution(ctx, cwd),
                    );
                    ctx.ui.notify(
                        `Session mode: ${resolved.shell.mode} (${resolved.shell.profile})`,
                        "info",
                    );
                } catch (error) {
                    ctx.ui.notify(
                        `Sandbox mode was not admitted: ${configurationErrorMessage(error)}`,
                        "error",
                    );
                }
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
                const durationMinutes = parseDockerBreakGlassDurationMinutes(
                    match?.[1],
                );
                if (!match || durationMinutes === undefined) {
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
                    const resolved = loadShell(ctx);
                    baseConfig = resolved.config;
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
                    ctx.ui.notify(
                        sandboxDoctor(
                            resolved,
                            arg === "doctor"
                                ? undefined
                                : args.trim().slice(7).trim(),
                            context,
                        ),
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
                    "Usage: /sandbox [status | doctor [executable] | migrate | recover | mode [sandbox|host] | docker [on|off|break-glass [1m-30m]]]",
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
