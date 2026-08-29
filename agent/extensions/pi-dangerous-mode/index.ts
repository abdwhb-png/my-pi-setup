import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWidget } from "../_shared/fancy-footer.ts";
import { installAuthorizerLink } from "./authorizer-link.ts";
import {
    isAutopilotAgentActive,
    noteAutopilotPromptBlocked,
    registerAutopilotLoop,
    syncAutopilotToolVisibility,
} from "./autopilot-loop.ts";
import { loadConfig } from "./config.ts";
import { disableForInvalidConfig, installRunnerPatch } from "./runner-patch.ts";
import {
    getAutopilotBudgetRemaining,
    getMutableRuntimeState,
    getRuntimeStatus,
    isAutopilotEnabled,
    setAutopilotOverride,
    setDangerousOverride,
    startRuntimeSession,
} from "./runtime-state.ts";
import { createTelemetryRecorder } from "./telemetry.ts";
import {
    installUiBrokerPatches,
    unregisterUiBrokerGuard,
} from "./ui-broker.ts";
import { renderDangerousWidget, WIDGET_ID } from "./widget.ts";

const ACTIONS = ["on", "off", "status"] as const;
type ModeAction = (typeof ACTIONS)[number];

function usage(command: "dangerous-mode" | "autopilot"): string {
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
    return `Dangerous mode: ${status.dangerous.effective ? "ON" : "OFF"} (direct=${(status.dangerous.override ?? status.dangerous.flag) ? "ON" : "OFF"}, induced=${status.dangerous.inducedByAutopilot ? "ON" : "OFF"})${status.compatible.runner ? "" : " (runner incompatible)"}. Protected tools: ${protectedTools}. Protected extensions: ${protectedExtensions}.`;
}

function autopilotStatusMessage(now: number): string {
    const status = getRuntimeStatus();
    const config = getMutableRuntimeState().config;
    const remaining = getAutopilotBudgetRemaining(now);
    return `Autopilot: ${status.autopilot.effective ? "ON" : "OFF"}; phase=${status.autopilot.phase}; turns=${status.autopilot.turnsUsed}/${config.autopilot.maxTurns}; retries=${status.autopilot.retriesUsed}/${config.autopilot.maxRetries}; remainingMs=${remaining.milliseconds}; runner=${status.compatible.runner ? "compatible" : "incompatible"}; ui=${status.compatible.uiBroker ? "compatible" : "incompatible"}; stop=${status.autopilot.stopReason ?? "none"}. Protected tools: ${config.protectedTools.join(", ") || "none"}. Protected extensions: ${config.protectedExtensions.join(", ") || "none"}.`;
}

export default function dangerousModeExtension(pi: ExtensionAPI): void {
    const telemetry = createTelemetryRecorder((customType, data) =>
        pi.appendEntry(customType, data),
    );
    const widget = createWidget(pi, {
        id: WIDGET_ID,
        label: "Dangerous Mode",
        description: "Shows Dangerous/Autopilot effective state.",
        row: 1,
        order: 12,
        align: "right",
        styled: true,
        render: (ctx) => renderDangerousWidget(ctx.theme, getRuntimeStatus()),
    });
    const patchInstalled = installRunnerPatch(undefined, {
        telemetry,
        onPromptBlocked: noteAutopilotPromptBlocked,
    });
    const uiBrokerInstalled = installUiBrokerPatches({
        isEnabled: isAutopilotEnabled,
        isAgentActive: isAutopilotAgentActive,
        onBlocked(event) {
            noteAutopilotPromptBlocked();
            telemetry(event);
        },
    });
    installAuthorizerLink(pi);
    registerAutopilotLoop(pi, { telemetry });
    pi.on("session_shutdown", (_event, ctx) => {
        widget.remove(ctx as never);
        unregisterUiBrokerGuard();
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
    pi.registerFlag("autopilot", {
        description:
            "Run the current task without human prompts, under conservative budgets and protected-action guards.",
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
            telemetry({
                event: "mode_change",
                mode: "dangerous",
                source: "command",
                enabled,
            });
            widget.update(
                ctx,
                renderDangerousWidget(ctx.ui.theme, getRuntimeStatus()),
            );
            ctx.ui.notify(
                `Dangerous mode direct source: ${enabled ? "ON" : "OFF"}; effective=${getRuntimeStatus().dangerous.effective ? "ON" : "OFF"}.`,
                "info",
            );
        },
    });

    pi.registerCommand("autopilot", {
        description: "Control Autopilot. Usage: /autopilot [on|off|status]",
        getArgumentCompletions: argumentCompletions,
        handler: async (args, ctx) => {
            const action = args.trim().toLowerCase();
            if (!isAction(action)) {
                ctx.ui.notify(usage("autopilot"), "warning");
                return;
            }

            if (action === "status") {
                ctx.ui.notify(autopilotStatusMessage(Date.now()), "info");
                return;
            }

            const enabled = action === "on";
            if (!setAutopilotOverride(enabled, Date.now())) {
                ctx.ui.notify(
                    "Autopilot cannot be enabled: configuration, runner, or UI broker is incompatible.",
                    "error",
                );
                return;
            }
            syncAutopilotToolVisibility(pi);
            telemetry({
                event: "mode_change",
                mode: "autopilot",
                source: "command",
                enabled,
            });
            widget.update(
                ctx,
                renderDangerousWidget(ctx.ui.theme, getRuntimeStatus()),
            );
            ctx.ui.notify(
                `Autopilot: ${enabled ? "ON" : "OFF"}. Dangerous effective=${getRuntimeStatus().dangerous.effective ? "ON" : "OFF"}.`,
                "info",
            );
        },
    });

    pi.on("session_start", (event, ctx) => {
        try {
            startRuntimeSession({
                isReload: event.reason === "reload",
                dangerousFlag:
                    pi.getFlag("dangerously-skip-permissions") === true,
                autopilotFlag: pi.getFlag("autopilot") === true,
                config: loadConfig(ctx.cwd),
                now: Date.now(),
            });
        } catch (error) {
            disableForInvalidConfig();
            syncAutopilotToolVisibility(pi);
            const message =
                error instanceof Error
                    ? error.message
                    : "Invalid configuration.";
            ctx.ui.notify(message, "error");
            return;
        }

        syncAutopilotToolVisibility(pi);
        widget.update(
            ctx,
            renderDangerousWidget(ctx.ui.theme, getRuntimeStatus()),
        );
        const source = event.reason === "reload" ? "reload" : "flag";
        telemetry({
            event: "mode_change",
            mode: "dangerous",
            source,
            enabled: getRuntimeStatus().dangerous.effective,
        });
        telemetry({
            event: "mode_change",
            mode: "autopilot",
            source,
            enabled: getRuntimeStatus().autopilot.effective,
        });

        if (!patchInstalled || !getRuntimeStatus().compatible.runner) {
            ctx.ui.notify(
                "Dangerous mode disabled: incompatible ExtensionRunner.",
                "error",
            );
        }
        if (!uiBrokerInstalled || !getRuntimeStatus().compatible.uiBroker) {
            ctx.ui.notify(
                "Autopilot disabled: incompatible extension UI runtime.",
                "error",
            );
        }
    });
}
