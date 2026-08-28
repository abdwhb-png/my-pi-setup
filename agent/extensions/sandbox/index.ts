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

import { appendFileSync, existsSync, readFileSync } from "node:fs";
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

/** Footer widget state for the sandbox indicator. */
export type SandboxFooterState = "on" | "restricted" | "off" | "error";

/** Shield glyph shown in the footer widget (same metaphor as the bash 🛡️ prefix). */
const SANDBOX_ICON = "🛡️";
const WIDGET_ID = "pi-sandbox";

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
    if (state === "off") return null;
    const colors: UiColorsCreation = createUiColors(theme);
    const label = colors.subtle(`${SANDBOX_ICON}sandbox:`);
    const value =
        state === "on"
            ? colors.primary(state)
            : state === "restricted"
              ? colors.warning(state)
              : colors.danger(state);
    return `${label} ${value}`;
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
): SandboxConfig {
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

    return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
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

        const toAppend = "\n" + header + "\n" + missing.join("\n") + "\n";
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
    claimSandboxExecutionBroker(brokerOwner);

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
            updateSandboxStatus(ctx, "off");
            ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
            return;
        }

        let config: SandboxConfig;
        try {
            config = loadSandboxConfig(ctx.cwd);
        } catch (error) {
            sandboxEnabled = false;
            sandboxInitialized = false;
            publishExecutionError(error);
            updateSandboxStatus(ctx, "error");
            ctx.ui.notify(
                `Sandbox configuration failed: ${errorMessage(error)}`,
                "error",
            );
            return;
        }

        if (!config.enabled) {
            sandboxEnabled = false;
            sandboxInitialized = false;
            publishDisabledExecution();
            updateSandboxStatus(ctx, "off");
            return;
        }

        const platform = process.platform;
        if (platform !== "darwin" && platform !== "linux") {
            sandboxEnabled = false;
            sandboxInitialized = false;
            publishExecutionError(`Sandbox not supported on ${platform}`);
            updateSandboxStatus(ctx, "restricted");
            ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
            return;
        }

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

            updateSandboxStatus(ctx, "on");
            ctx.ui.notify("Sandbox initialized", "info");
        } catch (err) {
            sandboxEnabled = false;
            sandboxInitialized = false;
            publishExecutionError(err);
            updateSandboxStatus(ctx, "error");
            ctx.ui.notify(
                `Sandbox initialization failed: ${err instanceof Error ? err.message : String(err)}`,
                "error",
            );
        }
    });

    pi.on("session_shutdown", async () => {
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
                    publishExecutionError(
                        `Sandbox not supported on ${platform}`,
                    );
                    updateSandboxStatus(ctx, "restricted");
                    ctx.ui.notify(
                        `Sandbox not supported on ${platform}`,
                        "error",
                    );
                    return;
                }

                publishTransitionExecution();
                try {
                    const config = loadSandboxConfig(ctx.cwd);
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

                    updateSandboxStatus(ctx, "on");
                    ctx.ui.notify("Sandbox enabled", "info");
                } catch (err) {
                    sandboxEnabled = false;
                    sandboxInitialized = false;
                    publishExecutionError(err);
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
                sandboxEnabled = false;
                if (sandboxInitialized) {
                    publishTransitionExecution();
                    try {
                        await SandboxManager.reset();
                    } catch (error) {
                        publishExecutionError(error);
                        updateSandboxStatus(ctx, "error");
                        ctx.ui.notify(
                            `Sandbox reset failed: ${errorMessage(error)}`,
                            "error",
                        );
                        return;
                    }
                    sandboxInitialized = false;
                }
                publishDisabledExecution();
                updateSandboxStatus(ctx, "off");
                ctx.ui.notify("Sandbox disabled", "info");
                return;
            }

            // /sandbox (no args) — toggle or show status
            if (!arg) {
                let config: SandboxConfig;
                try {
                    config = loadSandboxConfig(ctx.cwd);
                } catch (error) {
                    publishExecutionError(error);
                    updateSandboxStatus(ctx, "error");
                    ctx.ui.notify(
                        `Sandbox configuration failed: ${errorMessage(error)}`,
                        "error",
                    );
                    return;
                }
                const status = sandboxEnabled ? "ENABLED" : "DISABLED";
                const lines = [
                    `Sandbox: ${status}`,
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
