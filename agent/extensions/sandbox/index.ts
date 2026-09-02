/**
 * Sandbox Extension - OS-level sandboxing for bash commands
 *
 * Uses @anthropic-ai/sandbox-runtime to enforce filesystem and network
 * restrictions on bash commands at the OS level (sandbox-exec on macOS,
 * bubblewrap on Linux).
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
 *     "allowWrite": [".", "/tmp"],
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
 * Setup:
 * 1. Copy sandbox/ directory to ~/.pi/agent/extensions/
 * 2. Run `npm install` in ~/.pi/agent/extensions/sandbox/
 *
 * Linux also requires: bubblewrap, socat, ripgrep
 */

import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import {
    SandboxManager,
    type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import {
    SettingsManager,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    type BashOperations,
    createBashTool,
    createBashToolDefinition,
    getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
    claimAnalysisSandboxBroker,
    publishAnalysisSandboxError,
    publishAnalysisSandboxService,
    publishAnalysisSandboxTransition,
    releaseAnalysisSandboxBroker,
} from "../_shared/analysis/sandbox-analysis-broker.ts";
import {
    bashWithStdinSchema,
    createBashOperations,
    killActiveBashProcesses,
} from "../_shared/bash/exec";
import { createBashPrefixRenderer } from "../_shared/bash/prefix-renderer";
import { applyFirstRewrite, loadBashRewrites } from "../_shared/bash/rewrites";
import {
    claimSandboxExecutionBroker,
    createSharedBashOperations,
    publishSandboxExecutionState,
    releaseSandboxExecutionBroker,
    type SharedBashOperationsOptions,
} from "../_shared/bash/sandbox-execution-broker";
import { appendCompressionFooter } from "../_shared/compression-render";
import { createWidget } from "../_shared/fancy-footer";
import { createUiColors, type UiColorsCreation } from "../_shared/ui/ui-colors";
import {
    createAnalysisSandboxService,
    type AnalysisSandboxService,
} from "./analysis/client.ts";

/** Footer widget state for the sandbox indicator. */
export type SandboxFooterState = "on" | "restricted" | "off" | "error";

/** Shield glyph shown in the footer widget (same metaphor as the bash 🛡️ prefix). */
const SANDBOX_ICON = "🛡️";
/** Warning glyph used in the footer widget when sandbox is disabled. */
const OFF_ICON = "⚠️";
const WIDGET_ID = "pi-sandbox";

/** Filename used to persist the sandbox status for a session. */
export const SESSION_STATE_FILENAME = "sandbox-state.json";

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
 * Read `<sessionDir>/sandbox-state.json` and return the persisted status.
 * Returns undefined when the file is missing, malformed, or its payload is invalid.
 */
export function loadSessionSandboxStatus(
    sessionDir: string,
): "enabled" | "disabled" | undefined {
    if (!sessionDir) return undefined;
    const file = join(sessionDir, SESSION_STATE_FILENAME);
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
 * Atomically persist the session's sandbox status to `<sessionDir>/sandbox-state.json`.
 * Writes to a temp file in the same directory and renames over the target.
 * Best-effort: returns silently on missing sessionDir or write failure (logged to stderr).
 */
export function saveSessionSandboxStatus(
    sessionDir: string,
    status: "enabled" | "disabled",
): void {
    if (!sessionDir) return;
    const file = join(sessionDir, SESSION_STATE_FILENAME);
    const tmp = join(sessionDir, `.${SESSION_STATE_FILENAME}.tmp`);
    const body = JSON.stringify(
        {
            enabled: status === "enabled",
            updatedAt: new Date().toISOString(),
        },
        null,
        2,
    );
    try {
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(tmp, body);
        renameSync(tmp, file);
    } catch (error) {
        console.error(
            `saveSessionSandboxStatus: ${errorMessage(error)}`,
        );
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
): string | null {
    const colors: UiColorsCreation = createUiColors(theme);
    if (state === "off") {
        return `${colors.subtle(`${OFF_ICON}sandbox:`)} ${colors.warning(state)}`;
    }
    const label = colors.subtle(`${SANDBOX_ICON}sandbox:`);
    const value = colorForState(colors, state);
    return `${label} ${value}`;
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

interface SandboxConfig extends SandboxRuntimeConfig {
    enabled?: boolean;
}

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
        denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
        allowWrite: [".", "/tmp"],
        denyWrite: [".env", ".env.*", "*.pem", "*.key"],
    },
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
    /** Session directory; if provided, an existing `sandbox-state.json` overrides the `enabled` flag. */
    sessionDir?: string;
    /** Explicit status override (e.g. from `PI_SANDBOX_SESSION_STATUS`); takes priority over the session file. */
    envOverride?: "enabled" | "disabled";
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function normalizeConfig(raw: unknown, source: string): Partial<SandboxConfig> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(`Invalid ${source}`);
    }
    return raw as Partial<SandboxConfig>;
}

function readSettingsConfig(
    settings: SandboxSettingsContainer,
    source: "global" | "project",
): Partial<SandboxConfig> {
    const raw = settings.sandbox;
    return raw === undefined
        ? {}
        : normalizeConfig(raw, `${source} sandbox settings`);
}

function readLegacyConfig(path: string): Partial<SandboxConfig> {
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

    const merged = deepMerge(
        deepMerge(DEFAULT_CONFIG, globalConfig),
        projectConfig,
    );

    let source: SandboxConfigSource;
    if (projectConfig.enabled === undefined) {
        if (globalConfig.enabled === undefined) {
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
    } else if (options.sessionDir) {
        const sessionStatus = loadSessionSandboxStatus(options.sessionDir);
        if (sessionStatus !== undefined) {
            source = "session-file";
            merged.enabled = sessionStatus === "enabled";
        }
    }

    return { config: merged, source };
}

function deepMerge(
    base: SandboxConfig,
    overrides: Partial<SandboxConfig>,
): SandboxConfig {
    const result: SandboxConfig = { ...base };

    if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
    if (overrides.network) {
        result.network = { ...base.network, ...overrides.network };
    }
    if (overrides.filesystem) {
        result.filesystem = { ...base.filesystem, ...overrides.filesystem };
    }

    // SAFETY: installed sandbox runtime accepts these optional fields, but its exported config type omits them.
    const extOverrides = overrides as unknown as {
        ignoreViolations?: Record<string, string[]>;
        enableWeakerNestedSandbox?: boolean;
    };
    const extResult = result as {
        ignoreViolations?: Record<string, string[]>;
        enableWeakerNestedSandbox?: boolean;
    };

    if (extOverrides.ignoreViolations) {
        extResult.ignoreViolations = extOverrides.ignoreViolations;
    }
    if (extOverrides.enableWeakerNestedSandbox !== undefined) {
        extResult.enableWeakerNestedSandbox =
            extOverrides.enableWeakerNestedSandbox;
    }

    return result;
}

/**
 * Ghost dotfiles created by bubblewrap as mount points for deny-write protection.
 * These must be gitignored so they don't pollute the working directory.
 *
 * Source of truth (upstream):
 *   sandbox-runtime/src/sandbox/sandbox-utils.ts
 *   → DANGEROUS_FILES + getDangerousDirectories()
 */
export const GHOST_PATTERNS = [
    ".gitconfig",
    ".gitmodules",
    ".bashrc",
    ".bash_profile",
    ".zshrc",
    ".zprofile",
    ".profile",
    ".ripgreprc",
    ".mcp.json",
    ".vscode/",
    ".idea/",
    ".claude/commands/",
    ".claude/agents/",
];

/**
 * Ensure ghost dotfile patterns are in the project's .gitignore.
 * Only writes once per session (guarded by `gitignoreEnsured` flag).
 */
let gitignoreEnsured = false;

/** Reset the gitignoreEnsured flag (for testing). */
export function _resetGitignoreEnsured(): void {
    gitignoreEnsured = false;
}

export function ensureGitignored(cwd: string): void {
    if (gitignoreEnsured) return;

    const gitignorePath = join(cwd, ".gitignore");
    const header =
        "# Sandbox ghost files (auto-generated by pi sandbox extension)";

    try {
        let existingLines: string[] = [];
        if (existsSync(gitignorePath)) {
            existingLines = readFileSync(gitignorePath, "utf-8")
                .split("\n")
                .map((l) => l.trim());
        }

        const missing = GHOST_PATTERNS.filter(
            (p) => !existingLines.includes(p),
        );

        if (missing.length === 0) {
            gitignoreEnsured = true;
            return;
        }

        const toAppend = `\n${header}\n${missing.join("\n")}\n`;
        appendFileSync(gitignorePath, toAppend);
        gitignoreEnsured = true;
    } catch {
        // best-effort — can't write .gitignore, not critical
    }
}

export function buildSandboxShellEnv(
    baseEnv: NodeJS.ProcessEnv = process.env,
    agentDir: string = getAgentDir(),
): NodeJS.ProcessEnv {
    const pathKey =
        Object.keys(baseEnv).find((key) => key.toLowerCase() === "path") ??
        "PATH";
    const currentPath = baseEnv[pathKey] ?? "";
    const binDir = join(agentDir, "bin");
    const pathEntries = currentPath.split(delimiter).filter(Boolean);
    const updatedPath = pathEntries.includes(binDir)
        ? currentPath
        : [binDir, currentPath].filter(Boolean).join(delimiter);
    return {
        ...baseEnv,
        [pathKey]: updatedPath,
    };
}

function applyRequestedRewrite(
    command: string,
    rewriteCommand: SharedBashOperationsOptions["rewriteCommand"],
): string {
    const rewritten = rewriteCommand?.(command);
    if (typeof rewritten === "string") return rewritten;
    if (rewritten && typeof rewritten === "object") return rewritten.command;
    return command;
}

export function createSandboxedBashOps(
    options: SharedBashOperationsOptions = {},
): BashOperations {
    return createBashOperations({
        stdin: options.stdin,
        detached: true,
        prepareCommand: async ({ command, cwd }) => ({
            command: await SandboxManager.wrapWithSandbox(
                applyRequestedRewrite(command, options.rewriteCommand),
            ),
            cwd,
            env: buildSandboxShellEnv(),
        }),
        afterClose: ({ cwd }) => {
            try {
                SandboxManager.cleanupAfterCommand();
            } catch {
                ensureGitignored(cwd);
            }
        },
    });
}

export default function (pi: ExtensionAPI) {
    const brokerOwner = Symbol("sandbox-extension-owner");
    const analysisBrokerOwner = Symbol("sandbox-analysis-extension-owner");
    claimSandboxExecutionBroker(brokerOwner);
    claimAnalysisSandboxBroker(analysisBrokerOwner);

    const publishDisabledExecution = () =>
        publishSandboxExecutionState(brokerOwner, {
            state: "disabled",
            createOperations: (options) =>
                createBashOperations({
                    stdin: options.stdin,
                    rewriteCommand: options.rewriteCommand,
                }),
        });
    const publishTransitionExecution = () =>
        publishSandboxExecutionState(brokerOwner, {
            state: "uninitialized",
        });
    const publishEnabledExecution = () =>
        publishSandboxExecutionState(brokerOwner, {
            state: "enabled",
            createOperations: createSandboxedBashOps,
        });
    const publishExecutionError = (error: unknown) =>
        publishSandboxExecutionState(brokerOwner, {
            state: "error",
            error: error instanceof Error ? error.message : String(error),
        });
    let analysisService: AnalysisSandboxService | null = null;
    const transitionAnalysis = () =>
        publishAnalysisSandboxTransition(analysisBrokerOwner);
    const disableAnalysis = async (reason: unknown): Promise<void> => {
        await analysisService?.shutdown();
        analysisService = null;
        publishAnalysisSandboxError(analysisBrokerOwner, reason);
    };
    const enableAnalysis = async (): Promise<void> => {
        await analysisService?.shutdown();
        analysisService = createAnalysisSandboxService();
        publishAnalysisSandboxService(analysisBrokerOwner, analysisService);
    };

    pi.registerFlag("no-sandbox", {
        description: "Disable OS-level sandboxing for bash commands",
        type: "boolean",
        default: false,
    });

    let projectCwd = process.cwd();
    let cachedBash = createBashTool(projectCwd);
    let bashDef = createBashToolDefinition(projectCwd);
    let sandboxEnabled = false;
    let sandboxInitialized = false;
    let rewriteRules = loadBashRewrites(projectCwd).rules;
    let sandboxFooterState: SandboxFooterState = "off";
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
        render: (ctx) => renderSandboxWidget(ctx.theme, sandboxFooterState),
    });

    function updateSandboxStatus(
        ctx: ExtensionContext,
        status: "on" | "restricted" | "off" | "error",
    ): void {
        sandboxFooterState = status;
        w.update(ctx);
    }

    /**
     * Persist the session's sandbox status to `<sessionDir>/sandbox-state.json` and
     * set the live env var for spawned subagent children to inherit.
     * No-op when `sessionManager` is absent (test contexts).
     */
    function persistSessionStatus(
        ctx: ExtensionContext,
        status: "enabled" | "disabled",
    ): void {
        const sessionDir = ctx.sessionManager?.getSessionDir();
        if (!sessionDir) return;
        saveSessionSandboxStatus(sessionDir, status);
        process.env[ENV_SESSION_STATUS] = status;
    }

    pi.registerTool({
        ...cachedBash,
        parameters: bashWithStdinSchema,
        label: "bash (sandboxed)",
        // Show 🛡️ prefix when sandbox active, no prefix when disabled
        renderCall: createBashPrefixRenderer(() =>
            sandboxEnabled ? "🛡️" : "",
        ),
        renderResult: (
            result: Parameters<NonNullable<typeof bashDef.renderResult>>[0],
            options: Parameters<NonNullable<typeof bashDef.renderResult>>[1],
            theme: Parameters<NonNullable<typeof bashDef.renderResult>>[2],
            context: Parameters<NonNullable<typeof bashDef.renderResult>>[3],
        ) => {
            const component = bashDef.renderResult!(
                result,
                options,
                theme,
                context,
            );
            if (!options.isPartial) {
                appendCompressionFooter(component, result.details, theme);
            }
            return component;
        },
        async execute(id, params, signal, onUpdate, _ctx) {
            const input = { command: params.command, timeout: params.timeout };
            const operations = createSharedBashOperations({
                stdin: params.stdin,
                rewriteCommand: (command) =>
                    applyFirstRewrite(command, "bash", rewriteRules),
            });
            const sharedBash = createBashTool(projectCwd, { operations });
            return sharedBash.execute(id, input, signal, onUpdate);
        },
    });

    pi.on("user_bash", () => ({
        operations: createSharedBashOperations(),
    }));

    pi.on("session_start", async (_event, ctx) => {
        gitignoreEnsured = false;
        projectCwd = ctx.cwd;
        cachedBash = createBashTool(projectCwd);
        bashDef = createBashToolDefinition(projectCwd);
        rewriteRules = loadBashRewrites(projectCwd).rules;
        const noSandbox = pi.getFlag("no-sandbox") as boolean;

        if (noSandbox) {
            sandboxEnabled = false;
            sandboxInitialized = false;
            publishDisabledExecution();
            await disableAnalysis("disabled via --no-sandbox");
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
                envOverride: envSandboxStatus(),
            });
        } catch (error) {
            sandboxEnabled = false;
            sandboxInitialized = false;
            publishExecutionError(error);
            await disableAnalysis(error);
            updateSandboxStatus(ctx, "error");
            ctx.ui.notify(
                `Sandbox configuration failed: ${errorMessage(error)}`,
                "error",
            );
            return;
        }

        const { config, source } = resolved;

        if (!config.enabled) {
            sandboxEnabled = false;
            sandboxInitialized = false;
            publishDisabledExecution();
            await disableAnalysis(`disabled (${source})`);
            updateSandboxStatus(ctx, "off");
            if (explicitlyDisabled(resolved)) {
                ctx.ui.notify(
                    `⚠ Sandbox is DISABLED for this session — bash commands run unsandboxed. (Source: ${source}; preference is persisted.)`,
                    "warning",
                );
            }
            return;
        }

        const platform = process.platform;
        if (platform !== "darwin" && platform !== "linux") {
            sandboxEnabled = false;
            sandboxInitialized = false;
            const error = `Sandbox not supported on ${platform}`;
            publishExecutionError(error);
            await disableAnalysis(error);
            updateSandboxStatus(ctx, "restricted");
            ctx.ui.notify(error, "warning");
            return;
        }

        publishTransitionExecution();
        transitionAnalysis();
        try {
            // SAFETY: installed sandbox runtime accepts these optional fields, but its exported config type omits them.
            const configExt = config as unknown as {
                ignoreViolations?: Record<string, string[]>;
                enableWeakerNestedSandbox?: boolean;
            };

            await SandboxManager.initialize({
                network: config.network,
                filesystem: config.filesystem,
                ignoreViolations: configExt.ignoreViolations,
                enableWeakerNestedSandbox: configExt.enableWeakerNestedSandbox,
            });

            sandboxEnabled = true;
            sandboxInitialized = true;
            publishEnabledExecution();
            if (platform === "linux") await enableAnalysis();
            else await disableAnalysis("analysis sandbox supports Linux only");

            updateSandboxStatus(ctx, "on");
            ctx.ui.notify("Sandbox initialized", "info");
        } catch (err) {
            sandboxEnabled = false;
            sandboxInitialized = false;
            publishExecutionError(err);
            await disableAnalysis(err);
            updateSandboxStatus(ctx, "error");
            ctx.ui.notify(
                `Sandbox initialization failed: ${err instanceof Error ? err.message : String(err)}`,
                "error",
            );
        }
    });

    pi.on("session_shutdown", async () => {
        releaseAnalysisSandboxBroker(analysisBrokerOwner);
        await analysisService?.shutdown();
        analysisService = null;
        if (!releaseSandboxExecutionBroker(brokerOwner)) return;
        killActiveBashProcesses();
        if (sandboxInitialized) {
            try {
                await SandboxManager.reset();
            } catch {
                // Ignore cleanup errors
            }
        }
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
                if (sandboxEnabled && sandboxInitialized) {
                    ctx.ui.notify("Sandbox is already enabled", "info");
                    return;
                }

                const platform = process.platform;
                if (platform !== "darwin" && platform !== "linux") {
                    const error = `Sandbox not supported on ${platform}`;
                    publishExecutionError(error);
                    await disableAnalysis(error);
                    updateSandboxStatus(ctx, "restricted");
                    ctx.ui.notify(error, "error");
                    return;
                }

                publishTransitionExecution();
                transitionAnalysis();
                try {
                    const { config } = loadSandboxConfig(ctx.cwd, {
                        sessionDir: ctx.sessionManager?.getSessionDir(),
                        envOverride: envSandboxStatus(),
                    });
                    // SAFETY: installed sandbox runtime accepts these optional fields, but its exported config type omits them.
                    const configExt = config as unknown as {
                        ignoreViolations?: Record<string, string[]>;
                        enableWeakerNestedSandbox?: boolean;
                    };

                    await SandboxManager.initialize({
                        network: config.network,
                        filesystem: config.filesystem,
                        ignoreViolations: configExt.ignoreViolations,
                        enableWeakerNestedSandbox:
                            configExt.enableWeakerNestedSandbox,
                    });

                    sandboxEnabled = true;
                    sandboxInitialized = true;
                    publishEnabledExecution();
                    if (platform === "linux") await enableAnalysis();
                    else
                        await disableAnalysis(
                            "analysis sandbox supports Linux only",
                        );

                    updateSandboxStatus(ctx, "on");
                    persistSessionStatus(ctx, "enabled");
                    ctx.ui.notify("Sandbox enabled", "info");
                } catch (err) {
                    sandboxEnabled = false;
                    sandboxInitialized = false;
                    publishExecutionError(err);
                    await disableAnalysis(err);
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
                if (sandboxInitialized) publishTransitionExecution();
                transitionAnalysis();
                await analysisService?.shutdown();
                analysisService = null;
                if (sandboxInitialized) {
                    try {
                        await SandboxManager.reset();
                    } catch (error) {
                        publishExecutionError(error);
                        publishAnalysisSandboxError(analysisBrokerOwner, error);
                        updateSandboxStatus(ctx, "error");
                        ctx.ui.notify(
                            `Sandbox reset failed: ${errorMessage(error)}`,
                            "error",
                        );
                        return;
                    }
                    sandboxInitialized = false;
                }
                publishAnalysisSandboxError(
                    analysisBrokerOwner,
                    "sandbox disabled by command",
                );
                publishDisabledExecution();
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
                        envOverride: envSandboxStatus(),
                    });
                } catch (error) {
                    publishExecutionError(error);
                    updateSandboxStatus(ctx, "error");
                    ctx.ui.notify(
                        `Sandbox configuration failed: ${errorMessage(error)}`,
                        "error",
                    );
                    return;
                }
                const { config, source } = resolved;
                const status = sandboxEnabled ? "ENABLED" : "DISABLED";
                const securityLabel = explicitlyDisabled(resolved)
                    ? `${status} ⚠`
                    : status;
                const lines = [
                    `Sandbox: ${securityLabel}`,
                    `Source: ${source}`,
                    "",
                    "Network:",
                    `  Allowed: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
                    `  Denied: ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
                    "",
                    "Filesystem:",
                    `  Deny Read: ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
                    `  Allow Write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
                    `  Deny Write: ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
                    "",
                    `Use /sandbox on or /sandbox off to toggle.`,
                ];
                ctx.ui.notify(lines.join("\n"), "info");
                return;
            }

            ctx.ui.notify("Usage: /sandbox [on|off]", "error");
        },
    });
}
