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
 *   "enabled": true,
 *   "network": {
 *     "allowedDomains": ["github.com", "*.github.com"],
 *     "deniedDomains": []
 *   },
 *   "filesystem": {
 *     "denyRead": ["~/.ssh", "~/.aws"],
 *     "allowWrite": ["."],
 *     "denyWrite": [".env"]
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

import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
    SettingsManager,
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
import {
    claimSandboxRuntime,
    publishSandboxRuntime,
    releaseSandboxRuntime,
    type SandboxBashOperationOptions,
} from "../_shared/sandbox-runtime/index.ts";
import { createUiColors, type UiColorsCreation } from "../_shared/ui/ui-colors";
import {
    createAnalysisSandboxService,
    type AnalysisSandboxService,
} from "./analysis/client.ts";
import {
    SandboxExecutionError,
    type SandboxCommand,
    type SandboxDockerPolicy,
} from "./runtime/contracts.ts";
import {
    dockerPolicyHasUnsafeTargets,
    resolveDockerPolicy,
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
export type SandboxFooterState = "on" | "restricted" | "off" | "error";

export interface SandboxDockerFooterState {
    mode: "off" | "targeted" | "full";
    unsafe: boolean;
}

/** Shield glyph shown in the footer widget (same metaphor as the bash 🛡️ prefix). */
const SANDBOX_ICON = "🛡️";
/** Warning glyph used in the footer widget when sandbox is disabled. */
const OFF_ICON = "⚠️";
const WIDGET_ID = "pi-sandbox";

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
    const dockerLabel = colors.subtle("docker:");
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
    const value = `${state.mode}${state.unsafe ? "!" : ""}`;
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
    };
}

/** Render the user-visible `/sandbox` status without exposing Docker authority details. */
export function renderSandboxStatusDetails(
    resolved: LoadSandboxConfigResult,
    sandboxActive: boolean,
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
        "",
        "Network:",
        `  Allowed: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
        `  Denied: ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
        "",
        `Docker: ${dockerStatus}`,
        ...(sandboxActive && config.docker.mode === "full"
            ? ["  Warning: full Docker access is equivalent to host control."]
            : []),
        ...(sandboxActive && dockerPolicyHasUnsafeTargets(config.docker)
            ? [
                  "  Warning: an unsafe-target exception is active from the global grant.",
              ]
            : []),
        "",
        "Filesystem:",
        `  Deny Read: ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
        `  Allow Write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
        `  Deny Write: ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
        "",
        "Use /sandbox on or /sandbox off to toggle.",
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
            return colors.warning(state);
        case "error":
            return colors.danger(state);
    }
}

export interface SandboxConfig extends PiSandboxConfig {}

const DEFAULT_CONFIG: SandboxConfig = {
    enabled: false,
    network: {
        allowedDomains: [
            "npmjs.org",
            "*.npmjs.org",
            "registry.npmjs.org",
            "registry.yarnpkg.com",
            "pypi.org",
            "*.pypi.org",
            "github.com",
            "*.github.com",
            "api.github.com",
            "raw.githubusercontent.com",
        ],
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
};

interface SandboxSettingsContainer {
    sandbox?: unknown;
}

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
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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

    let globalConfig = readSettingsConfig(globalSettings, "global");
    let projectConfig = readSettingsConfig(projectSettings, "project");
    if (Object.keys(globalConfig).length === 0) {
        globalConfig = readLegacyConfig(globalConfigPath);
    }
    if (Object.keys(projectConfig).length === 0) {
        projectConfig = readLegacyConfig(projectConfigPath);
    }

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
    return {
        config: validatePiSandboxConfig(mergedBaseConfig, docker),
        source,
    };
}

function deepMerge(
    base: SandboxConfig,
    overrides: SandboxConfigLayer,
): SandboxConfig {
    const result: SandboxConfig = { ...base };

    if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
    if (overrides.network) {
        result.network = { ...base.network, ...overrides.network };
    }
    if (overrides.filesystem) {
        result.filesystem = { ...base.filesystem, ...overrides.filesystem };
    }
    if (overrides.environment) {
        result.environment = { ...base.environment, ...overrides.environment };
    }

    return result;
}

export function createSandboxedBashOps(
    service: SandboxService,
    supervisor: BashProcessSupervisor,
    options: SandboxBashOperationOptions = {},
): BashOperations {
    return supervisor.createOperations({
        stdin: options.stdin,
        detached: true,
        rewriteCommand: options.rewriteCommand,
        prepareSpawn: async ({ command, cwd }) => {
            const sandboxCommand: SandboxCommand = {
                file: "/bin/bash",
                args: ["-c", command],
                cwd,
                stdin: options.stdin,
            };
            return service.prepareBash(sandboxCommand);
        },
    });
}

export default function (pi: ExtensionAPI) {
    const runtimeOwner = Symbol("sandbox-extension-owner");
    const bashProcessSupervisor = createBashProcessSupervisor();
    claimSandboxRuntime(runtimeOwner);
    const inheritedSessionStatus = process.env[ENV_SESSION_STATUS];
    let ownedSessionStatus: "enabled" | "disabled" | undefined;

    const restoreSessionStatus = (): void => {
        if (ownedSessionStatus === undefined) return;
        if (process.env[ENV_SESSION_STATUS] === ownedSessionStatus) {
            if (inheritedSessionStatus === undefined) {
                delete process.env[ENV_SESSION_STATUS];
            } else {
                process.env[ENV_SESSION_STATUS] = inheritedSessionStatus;
            }
        }
        ownedSessionStatus = undefined;
    };

    let transitionGeneration = 0;
    const beginTransition = (): number | undefined => {
        transitionGeneration += 1;
        const generation = transitionGeneration;
        const published = publishSandboxRuntime(runtimeOwner, {
            state: "uninitialized",
        });
        if (!published) return undefined;
        return generation;
    };
    const isCurrentTransition = (generation: number): boolean =>
        transitionGeneration === generation;
    const publishDisabled = () =>
        publishSandboxRuntime(runtimeOwner, { state: "disabled" });
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
    ): Promise<void> => {
        const currentSandbox = sandboxService;
        const currentAnalysis = analysisService;
        const analysisTargets = [
            ...new Set([
                ...pendingAnalysisCleanup,
                ...inFlightAnalysisCandidates,
                ...(currentAnalysis ? [currentAnalysis] : []),
            ]),
        ].filter((service) => service !== excludedAnalysis);
        const sandboxTargets = [
            ...new Set([
                ...pendingSandboxCleanup,
                ...inFlightSandboxCandidates,
                ...(currentSandbox ? [currentSandbox] : []),
            ]),
        ].filter((service) => service !== excludedSandbox);
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

    const cleanupCandidates = async (
        candidateSandbox: SandboxService,
        candidateAnalysis: AnalysisSandboxService,
    ): Promise<void> => {
        const analysisCleanup =
            inFlightAnalysisCandidates.has(candidateAnalysis) ||
            pendingAnalysisCleanup.has(candidateAnalysis)
                ? cleanupAnalysisService(candidateAnalysis)
                : Promise.resolve();
        const sandboxCleanup =
            inFlightSandboxCandidates.has(candidateSandbox) ||
            pendingSandboxCleanup.has(candidateSandbox)
                ? cleanupSandboxService(candidateSandbox)
                : Promise.resolve();
        const results = await Promise.allSettled([
            analysisCleanup,
            sandboxCleanup,
        ]);
        let failure: unknown;
        if (results[0]?.status === "rejected") {
            failure = results[0].reason;
        }
        if (results[1]?.status === "rejected") {
            if (failure === undefined) failure = results[1].reason;
            else attachCleanupFailure(failure, results[1].reason);
        }
        if (failure !== undefined) throw failure;
    };

    const enableServices = async (
        cwd: string,
        config: SandboxConfig,
        generation: number,
    ): Promise<boolean> => {
        const candidateSandbox = createSandboxService({
            backend: createZeroboxBackend(),
            config,
        });
        const candidateAnalysis = createAnalysisSandboxService();
        inFlightSandboxCandidates.add(candidateSandbox);
        inFlightAnalysisCandidates.add(candidateAnalysis);
        const abandonStaleCandidate = async (): Promise<false> => {
            try {
                await cleanupCandidates(candidateSandbox, candidateAnalysis);
            } catch {
                // cleanupCandidates retains failures for the next transition.
            }
            return false;
        };
        try {
            await candidateSandbox.startBashSession(cwd);
            if (!isCurrentTransition(generation)) {
                return abandonStaleCandidate();
            }
            await candidateAnalysis.preflight();
            if (!isCurrentTransition(generation)) {
                return abandonStaleCandidate();
            }
            await shutdownServices(candidateSandbox, candidateAnalysis);
            if (!isCurrentTransition(generation)) {
                return abandonStaleCandidate();
            }
            const published = publishSandboxRuntime(runtimeOwner, {
                state: "enabled",
                createBashOperations: (options) =>
                    createSandboxedBashOps(
                        candidateSandbox,
                        bashProcessSupervisor,
                        options,
                    ),
                analysis: candidateAnalysis,
            });
            if (!published) {
                await cleanupCandidates(candidateSandbox, candidateAnalysis);
                return false;
            }
            sandboxService = candidateSandbox;
            analysisService = candidateAnalysis;
            inFlightSandboxCandidates.delete(candidateSandbox);
            inFlightAnalysisCandidates.delete(candidateAnalysis);
            return true;
        } catch (error) {
            try {
                await cleanupCandidates(candidateSandbox, candidateAnalysis);
            } catch (cleanup) {
                attachCleanupFailure(error, cleanup);
            }
            if (!isCurrentTransition(generation)) return false;
            throw error;
        }
    };

    pi.registerFlag("no-sandbox", {
        description: "Disable OS-level sandboxing for bash commands",
        type: "boolean",
        default: false,
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
        status: "on" | "restricted" | "off" | "error",
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
        if (dockerPolicyHasUnsafeTargets(docker)) {
            ctx.ui.notify(
                `${message}. Targeted Docker includes an unsafe-target exception from the global grant.`,
                "warning",
            );
            return;
        }
        ctx.ui.notify(message, "info");
    }

    /**
     * Persist the sandbox status under the current Pi session identity and
     * set the live env var for spawned subagent children to inherit.
     * No-op when `sessionManager` is absent (test contexts).
     */
    function persistSessionStatus(
        ctx: ExtensionContext,
        status: "enabled" | "disabled",
    ): void {
        const sessionDir = ctx.sessionManager?.getSessionDir();
        const sessionId = ctx.sessionManager?.getSessionId();
        if (!sessionDir || !sessionId) return;
        saveSessionSandboxStatus(sessionDir, sessionId, status);
        process.env[ENV_SESSION_STATUS] = status;
        ownedSessionStatus = status;
    }

    pi.on("session_start", async (_event, ctx) => {
        const noSandbox = pi.getFlag("no-sandbox") as boolean;
        const generation = beginTransition();
        if (generation === undefined) return;
        bashProcessSupervisor.shutdown();

        if (noSandbox) {
            sandboxEnabled = false;
            try {
                await shutdownServices();
            } catch (error) {
                if (!isCurrentTransition(generation)) return;
                publishError(error);
                updateSandboxStatus(ctx, "error");
                ctx.ui.notify(
                    `Sandbox cleanup failed: ${errorMessage(error)}`,
                    "error",
                );
                return;
            }
            if (!isCurrentTransition(generation)) return;
            publishDisabled();
            updateSandboxStatus(ctx, "off");
            ctx.ui.notify(
                `⚠ Sandbox disabled via --no-sandbox — bash commands run unsandboxed.`,
                "warning",
            );
            return;
        }

        let resolved: LoadSandboxConfigResult;
        try {
            resolved = loadSandboxConfig(ctx.cwd, {
                sessionDir: ctx.sessionManager?.getSessionDir(),
                sessionId: ctx.sessionManager?.getSessionId(),
                envOverride: envSandboxStatus(),
            });
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

        const { config, source } = resolved;

        if (!config.enabled) {
            sandboxEnabled = false;
            try {
                await shutdownServices();
            } catch (error) {
                if (!isCurrentTransition(generation)) return;
                publishError(error);
                updateSandboxStatus(ctx, "error");
                ctx.ui.notify(
                    `Sandbox cleanup failed: ${errorMessage(error)}`,
                    "error",
                );
                return;
            }
            if (!isCurrentTransition(generation)) return;
            publishDisabled();
            updateSandboxStatus(ctx, "off");
            if (explicitlyDisabled(resolved)) {
                ctx.ui.notify(
                    `⚠ Sandbox is DISABLED for this session — bash commands run unsandboxed. (Source: ${source}; preference is persisted.)`,
                    "warning",
                );
            }
            return;
        }

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
            const enabled = await enableServices(ctx.cwd, config, generation);
            if (!isCurrentTransition(generation) || !enabled) return;
            sandboxEnabled = true;
            updateSandboxStatus(ctx, "on", config.docker);
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
        const generation = beginTransition();
        bashProcessSupervisor.shutdown();
        try {
            await shutdownServices();
        } catch (error) {
            if (generation !== undefined && isCurrentTransition(generation)) {
                publishError(error);
            }
            throw error;
        } finally {
            restoreSessionStatus();
        }
        if (generation === undefined || !isCurrentTransition(generation)) {
            return;
        }
        releaseSandboxRuntime(runtimeOwner);
    });

    pi.registerCommand("sandbox", {
        description:
            "Toggle sandbox or show status (/sandbox, /sandbox on, /sandbox off)",
        getArgumentCompletions: (prefix: string) => {
            const values = ["on", "enable", "off", "disable"];
            const trimmed = prefix.trimStart().toLowerCase();
            if (!trimmed)
                return values.map((value) => ({ value, label: value }));
            const filtered = values.filter((value) =>
                value.startsWith(trimmed),
            );
            return filtered.length > 0
                ? filtered.map((value) => ({ value, label: value }))
                : null;
        },
        handler: async (args, ctx) => {
            const arg = args.trim().toLowerCase();

            // /sandbox on
            if (arg === "on" || arg === "enable") {
                if (sandboxEnabled && sandboxService) {
                    ctx.ui.notify("Sandbox is already enabled", "info");
                    return;
                }

                if (process.platform !== "linux") {
                    const error = `Sandbox not supported on ${process.platform}`;
                    publishError(error);
                    updateSandboxStatus(ctx, "restricted");
                    ctx.ui.notify(error, "error");
                    return;
                }

                const generation = beginTransition();
                if (generation === undefined) return;
                try {
                    const { config } = loadSandboxConfig(ctx.cwd, {
                        sessionDir: ctx.sessionManager?.getSessionDir(),
                        sessionId: ctx.sessionManager?.getSessionId(),
                        envOverride: envSandboxStatus(),
                    });
                    const enabled = await enableServices(
                        ctx.cwd,
                        config,
                        generation,
                    );
                    if (!isCurrentTransition(generation) || !enabled) return;
                    sandboxEnabled = true;
                    updateSandboxStatus(ctx, "on", config.docker);
                    persistSessionStatus(ctx, "enabled");
                    notifySandboxEnabled(ctx, "Sandbox enabled", config.docker);
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
                return;
            }

            // /sandbox off
            if (arg === "off" || arg === "disable") {
                ctx.ui.notify(
                    "⚠ Disabling sandbox is a security risk — bash commands will run with full system access. (This preference is persisted for this session.)",
                    "warning",
                );
                sandboxEnabled = false;
                const generation = beginTransition();
                if (generation === undefined) return;
                bashProcessSupervisor.shutdown();
                try {
                    await shutdownServices();
                } catch (error) {
                    if (!isCurrentTransition(generation)) return;
                    publishError(error);
                    updateSandboxStatus(ctx, "error");
                    ctx.ui.notify(
                        `Sandbox cleanup failed: ${errorMessage(error)}`,
                        "error",
                    );
                    return;
                }
                if (!isCurrentTransition(generation)) return;
                publishDisabled();
                updateSandboxStatus(ctx, "off");
                persistSessionStatus(ctx, "disabled");
                ctx.ui.notify("Sandbox disabled", "info");
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
                    renderSandboxStatusDetails(resolved, sandboxEnabled),
                    "info",
                );
                return;
            }

            ctx.ui.notify("Usage: /sandbox [on|off]", "error");
        },
    });
}
