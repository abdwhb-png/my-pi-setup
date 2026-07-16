/**
 * Safe bash extension.
 * Wraps the built-in bash tool with dangerous command blocking.
 *
 * Based on amosblomqvist/pi-subagents safe-bash.ts
 *
 * Modes (settings.json `safeBash.mode`, default "coexist"):
 *   - "coexist": both `bash` and `safe_bash` are available.
 *   - "replace": built-in `bash` is removed from the active tool list AND any
 *     `bash` tool_call is blocked at execution time (hard guarantee). The LLM
 *     must use `safe_bash`.
 *
 * Limitations:
 *   - `setActiveTools` only filters the system PROMPT, not execution. A resumed
 *     session with `bash` calls in history may still emit a `bash` call; the
 *     `tool_call` block here returns a clear error so the LLM switches to
 *     `safe_bash`. There is no extension API to strip tool calls from history.
 *   - Mode changes via `/safe-bash` are runtime-only and do not persist to
 *     settings.json; they reset to the configured value on next session start.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createBashToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { shouldEnforceNativeTools } from '../_shared/audit-mode/audit-tool-routing';
import {
    isDangerous,
    redirectShellCommandWithPolicy,
} from '../_shared/bash-guard';
import { createBashPrefixRenderer } from '../_shared/bash-prefix-renderer';
import { appendCompressionFooter } from '../_shared/compression-render';
import { applyMode, restoreBash, shouldBlockBashCall } from './apply-mode.ts';
import { loadSafeBashConfig, type SafeBashMode } from './config.ts';

export default function (pi: ExtensionAPI) {
    // Use createBashToolDefinition to get renderCall/renderResult
    // so safe_bash shows the command in the session UI like built-in bash.
    const bashDefinition = createBashToolDefinition(process.cwd());

    /** Current safe-bash mode, (re)loaded from settings.json or flipped via /safe-bash. */
    let currentMode: SafeBashMode = 'coexist';

    /**
     * Current allowed-shell-commands list (by first word), reloaded from
     * settings.json. Bypasses native-tool redirection for these commands;
     * `isDangerous()` still runs on them.
     */
    let currentAllowedShellCommands: string[] = [];

    /** Reload config from settings.json and apply the mode to the active tools. */
    function reloadConfig(cwd: string): SafeBashMode {
        const config = loadSafeBashConfig(cwd);
        currentAllowedShellCommands = config.allowedShellCommands;
        return setMode(config.mode);
    }

    /** Transition to a new mode and mutate the active tool list accordingly. */
    function setMode(next: SafeBashMode): SafeBashMode {
        currentMode = next;
        if (next === 'replace') {
            applyMode(pi, 'replace');
        } else {
            restoreBash(pi);
        }
        return currentMode;
    }

    pi.registerTool({
        name: 'safe_bash',
        label: '🔒Safe Bash',
        description:
            'Execute a bash command. Provides basic guardrails against accidentally destructive operations (e.g., rm -rf /, sudo). NOT a security sandbox — determined attackers can bypass these checks.',
        parameters: Type.Object({
            command: Type.String({ description: 'Bash command to execute' }),
            timeout: Type.Optional(
                Type.Number({ description: 'Timeout in seconds (optional)' }),
            ),
        }),
        // Custom renderCall shows 🔒 prefix so user knows safe_bash ran
        renderCall: createBashPrefixRenderer('🔒'),
        // renderResult delegates to bash's and optionally appends compression footer
        renderResult: (
            result: Parameters<
                NonNullable<typeof bashDefinition.renderResult>
            >[0],
            options: Parameters<
                NonNullable<typeof bashDefinition.renderResult>
            >[1],
            theme: Parameters<
                NonNullable<typeof bashDefinition.renderResult>
            >[2],
            context: Parameters<
                NonNullable<typeof bashDefinition.renderResult>
            >[3],
        ) => {
            const component = bashDefinition.renderResult!(
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
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const danger = isDangerous(params.command);
            if (danger) {
                throw new Error(danger);
            }
            const redirect = redirectShellCommandWithPolicy(
                params.command,
                shouldEnforceNativeTools(),
                currentAllowedShellCommands,
            );
            if (redirect) {
                throw new Error(redirect);
            }
            return bashDefinition.execute(
                toolCallId,
                params,
                signal,
                onUpdate,
                ctx,
            );
        },
    });

    // Apply safe-bash mode from settings.json on every session start / reload.
    // Runs after the tool list is built so applyMode sees the final active set.
    pi.on('session_start', async (_event, ctx) => {
        reloadConfig(ctx.cwd);
    });

    // Hard guarantee: even if the LLM references `bash` from earlier history,
    // block execution in replace mode. setActiveTools only filters the prompt.
    pi.on('tool_call', async (event) => {
        if (!shouldBlockBashCall(event.toolName, currentMode)) return;
        return {
            block: true as const,
            reason: 'bash is disabled in safe-bash `replace` mode — use the `safe_bash` tool instead.',
        };
    });

    // Re-assert the mode before each agent loop so the system prompt never
    // lists `bash` (closes the turn-1 window where the constructor-built
    // prompt still included it). Idempotent.
    pi.on('before_agent_start', async () => {
        if (currentMode === 'replace') applyMode(pi, 'replace');
    });

    pi.registerCommand('safe-bash', {
        description:
            'Manage safe-bash mode: [replace|coexist|on|off|reload|status].',
        getArgumentCompletions: (prefix: string) => {
            const items = [
                {
                    value: 'replace',
                    label: 'replace — drop bash, force safe_bash only',
                },
                {
                    value: 'coexist',
                    label: 'coexist — both bash + safe_bash available',
                },
                { value: 'on', label: 'on — alias for replace' },
                { value: 'off', label: 'off — alias for coexist' },
                {
                    value: 'reload',
                    label: 'reload — re-read safeBash from settings.json',
                },
                { value: 'status', label: 'status — show current mode' },
            ];
            const filtered = items.filter((i) => i.value.startsWith(prefix));
            return filtered.length > 0 ? filtered : null;
        },
        handler: async (args, ctx) => {
            const arg = args.trim().toLowerCase();

            if (arg === 'reload' || arg === 'refresh') {
                const mode = reloadConfig(ctx.cwd);
                ctx.ui.notify(
                    `safe-bash config reloaded (mode: ${mode})`,
                    'info',
                );
                return;
            }
            if (arg === 'status' || arg === '') {
                ctx.ui.notify(`safe-bash mode: ${currentMode}`, 'info');
                return;
            }

            let next: SafeBashMode | null = null;
            if (arg === 'replace' || arg === 'on') next = 'replace';
            else if (arg === 'coexist' || arg === 'off') next = 'coexist';

            if (next) {
                const mode = setMode(next);
                ctx.ui.notify(
                    `safe-bash mode set to ${mode} (runtime only — not persisted)`,
                    'info',
                );
                return;
            }

            ctx.ui.notify(
                `Usage: /safe-bash [replace|coexist|on|off|reload|status] (current: ${currentMode})`,
                'info',
            );
        },
    });
}
