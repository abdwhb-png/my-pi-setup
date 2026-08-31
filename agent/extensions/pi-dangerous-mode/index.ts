import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWidget } from "../_shared/fancy-footer.ts";
import { installAuthorizerLink } from "./authorizer-link.ts";
import { loadConfig } from "./config.ts";
import { disableForInvalidConfig, installRunnerPatch } from "./runner-patch.ts";
import {
    getMutableRuntimeState,
    getRuntimeStatus,
    isUnattendedEnabled,
    setDangerousOverride,
    setUnattendedOverride,
    startRuntimeSession,
} from "./runtime-state.ts";
import {
    installUiBrokerPatches,
    unregisterUiBrokerGuard,
} from "./ui-broker.ts";
import { renderDangerousWidget, WIDGET_ID } from "./widget.ts";

const ACTIONS = ["on", "off", "status"] as const;
type ModeAction = (typeof ACTIONS)[number];

function usage(command: "dangerous-mode" | "unattended"): string {
    return `Usage: /${command} [on|off|status]`;
}

function isAction(value: string): value is ModeAction {
    return ACTIONS.some((action) => action === value);
}

function argumentCompletions(prefix: string) {
    const normalized = prefix.trim().toLowerCase();
    if (normalized.includes(" ")) return null;
    const matches = ACTIONS.filter((action) => action.startsWith(normalized));
    return matches.length
        ? matches.map((value) => ({ value, label: value }))
        : null;
}

function dangerousStatusMessage(): string {
    const status = getRuntimeStatus();
    const config = getMutableRuntimeState().config;
    const protectedTools = config.protectedTools.join(", ") || "none";
    const protectedExtensions = config.protectedExtensions.join(", ") || "none";
    return `Dangerous mode: ${status.dangerous.effective ? "ON" : "OFF"} (direct=${(status.dangerous.override ?? status.dangerous.flag) ? "ON" : "OFF"})${status.compatible.runner ? "" : " (runner incompatible)"}. Protected tools: ${protectedTools}. Protected extensions: ${protectedExtensions}.`;
}

function unattendedStatusMessage(): string {
    const status = getRuntimeStatus();
    return `Unattended: ${status.unattended.effective ? "ON" : "OFF"}; runner=${status.compatible.runner ? "compatible" : "incompatible"}; ui=${status.compatible.uiBroker ? "compatible" : "incompatible"}. Human prompts are suppressed only while this mode is ON.`;
}

export default function dangerousModeExtension(pi: ExtensionAPI): void {
    let agentActive = false;
    const widget = createWidget(pi, {
        id: WIDGET_ID,
        label: "Dangerous Mode",
        description: "Shows Dangerous and Unattended session state.",
        row: 1,
        order: 12,
        align: "right",
        styled: true,
        render: (ctx) => renderDangerousWidget(ctx.theme, getRuntimeStatus()),
    });
    const patchInstalled = installRunnerPatch();
    const uiBrokerInstalled = installUiBrokerPatches({
        isEnabled: isUnattendedEnabled,
        isAgentActive: () => agentActive,
    });
    installAuthorizerLink(pi);

    pi.on("session_shutdown", (_event, ctx) => {
        widget.remove(ctx as never);
        unregisterUiBrokerGuard();
    });
    pi.on("agent_start", () => {
        agentActive = true;
    });
    pi.on("agent_settled", () => {
        agentActive = false;
    });
    pi.on("turn_end", async (_event, ctx) => {
        widget.update(
            ctx,
            renderDangerousWidget(ctx.ui.theme, getRuntimeStatus()),
        );
    });
    // AgentSession skips runner dispatch when no tool_call handler exists.
    pi.on("tool_call", () => undefined);

    pi.registerFlag("dangerously-skip-permissions", {
        description:
            "Skip permission prompts and unprotected extension tool-call blockers for this session.",
        type: "boolean",
    });

    pi.registerCommand("dangerous-mode", {
        description:
            "Control dangerous mode. Usage: /dangerous-mode [on|off|status]",
        getArgumentCompletions: argumentCompletions,
        handler: async (args, ctx) => {
            const action = args.trim().toLowerCase();
            if (!isAction(action)) {
                ctx.ui.notify(usage("dangerous-mode"), "warning");
                return;
            }
            if (action === "status") {
                ctx.ui.notify(dangerousStatusMessage(), "info");
                return;
            }

            const enabled = action === "on";
            if (!setDangerousOverride(enabled)) {
                ctx.ui.notify(
                    "Dangerous mode cannot be enabled: configuration or runner is incompatible.",
                    "error",
                );
                return;
            }
            widget.update(
                ctx,
                renderDangerousWidget(ctx.ui.theme, getRuntimeStatus()),
            );
            ctx.ui.notify(`Dangerous mode: ${enabled ? "ON" : "OFF"}.`, "info");
        },
    });

    pi.registerCommand("unattended", {
        description:
            "Suppress human prompts during agent work. Usage: /unattended [on|off|status]",
        getArgumentCompletions: argumentCompletions,
        handler: async (args, ctx) => {
            const action = args.trim().toLowerCase();
            if (!isAction(action)) {
                ctx.ui.notify(usage("unattended"), "warning");
                return;
            }
            if (action === "status") {
                ctx.ui.notify(unattendedStatusMessage(), "info");
                return;
            }

            const enabled = action === "on";
            if (!setUnattendedOverride(enabled)) {
                ctx.ui.notify(
                    "Unattended cannot be enabled: configuration, runner, or UI broker is incompatible.",
                    "error",
                );
                return;
            }
            widget.update(
                ctx,
                renderDangerousWidget(ctx.ui.theme, getRuntimeStatus()),
            );
            ctx.ui.notify(`Unattended: ${enabled ? "ON" : "OFF"}.`, "info");
        },
    });

    pi.on("session_start", (event, ctx) => {
        try {
            startRuntimeSession({
                isReload: event.reason === "reload",
                dangerousFlag:
                    pi.getFlag("dangerously-skip-permissions") === true,
                config: loadConfig(ctx.cwd),
            });
        } catch (error) {
            disableForInvalidConfig();
            const message =
                error instanceof Error
                    ? error.message
                    : "Invalid configuration.";
            ctx.ui.notify(message, "error");
            return;
        }

        widget.update(
            ctx,
            renderDangerousWidget(ctx.ui.theme, getRuntimeStatus()),
        );
        if (!patchInstalled || !getRuntimeStatus().compatible.runner) {
            ctx.ui.notify(
                "Dangerous mode disabled: incompatible ExtensionRunner.",
                "error",
            );
        }
        if (!uiBrokerInstalled || !getRuntimeStatus().compatible.uiBroker) {
            ctx.ui.notify(
                "Unattended disabled: incompatible extension UI runtime.",
                "error",
            );
        }
    });
}
