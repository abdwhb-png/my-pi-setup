import { basename } from "node:path";
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    installExtensionUiBroker,
    registerExtensionUiPromptObserver,
} from "./_shared/extension-ui-broker.ts";
import { createNotificationTransport } from "./notify/transport.ts";

export default function notify(pi: ExtensionAPI): void {
    const transport = createNotificationTransport();
    let enabled = true;
    let agentActive = false;
    let agentStartTime: number | null = null;
    let turnCount = 0;
    let filesChanged = 0;
    let lifecycleGeneration = 0;
    let sessionProject: string | undefined;
    let sessionHasUI = false;

    installExtensionUiBroker();
    const unregisterPromptObserver = registerExtensionUiPromptObserver(
        "pi.notify",
        (promptKind) => {
            if (!enabled || !agentActive || !sessionHasUI || !sessionProject) {
                return;
            }
            transport.send({
                type: "action-required",
                project: sessionProject,
                promptKind,
            });
        },
    );

    function updateStatus(ctx: ExtensionContext): void {
        if (!ctx.hasUI) return;
        ctx.ui.setStatus(
            "notify",
            enabled
                ? undefined
                : ctx.ui.theme.fg("warning", "\uf1f6 notify:off"),
        );
    }

    pi.on("session_start", (_event, ctx) => {
        if (process.env.PI_NO_NOTIFY === "1") enabled = false;
        agentActive = false;
        sessionProject = basename(ctx.cwd) || ctx.cwd;
        sessionHasUI = ctx.hasUI;
        updateStatus(ctx);
    });

    pi.on("session_shutdown", () => {
        agentActive = false;
        lifecycleGeneration++;
        unregisterPromptObserver();
    });

    pi.registerCommand("notify", {
        description: "Toggle desktop notifications on/off",
        handler: async (_args, ctx) => {
            enabled = !enabled;
            updateStatus(ctx);
            ctx.ui.notify(
                enabled ? "Notifications enabled" : "Notifications disabled",
                "info",
            );
        },
    });

    pi.on("agent_start", () => {
        agentActive = true;
        lifecycleGeneration++;
        agentStartTime = Date.now();
        turnCount = 0;
        filesChanged = 0;
    });

    pi.on("turn_start", (event) => {
        turnCount = event.turnIndex + 1;
    });

    pi.on("tool_result", (event) => {
        if (
            (event.toolName === "edit" || event.toolName === "write") &&
            !event.isError
        ) {
            filesChanged++;
        }
    });

    pi.on("agent_settled", (_event, ctx) => {
        agentActive = false;
        if (!enabled || !ctx.hasUI) return;

        const settledGeneration = ++lifecycleGeneration;
        const completion = {
            type: "task-complete" as const,
            project: basename(ctx.cwd) || ctx.cwd,
            elapsedSeconds:
                agentStartTime === null
                    ? null
                    : Math.round((Date.now() - agentStartTime) / 1000),
            turnCount,
            filesChanged,
        };
        setTimeout(() => {
            try {
                if (
                    settledGeneration !== lifecycleGeneration ||
                    agentActive ||
                    !enabled ||
                    !ctx.isIdle() ||
                    ctx.hasPendingMessages()
                ) {
                    return;
                }
                transport.send(completion);
            } catch {
                // Session may be replaced before deferred settlement check.
            }
        }, 0);
    });
}
