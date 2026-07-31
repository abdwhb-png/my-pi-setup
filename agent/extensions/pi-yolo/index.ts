import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import {
    disableYoloForInvalidConfig,
    getYoloStatus,
    installRunnerPatch,
    setYoloSessionOverride,
    startYoloSession,
} from "./runner-patch.ts";

const ACTIONS = ["on", "off", "status"] as const;

function usage(): string {
    return "Usage: /yolo [on|off|status]";
}

function isAction(value: string): value is (typeof ACTIONS)[number] {
    return ACTIONS.some((action) => action === value);
}

export default function yoloExtension(pi: ExtensionAPI): void {
    const patchInstalled = installRunnerPatch();

    pi.registerFlag("yolo", {
        description: "Bypass unprotected extension tool-call blockers.",
        type: "boolean",
    });

    pi.registerCommand("yolo", {
        description: "Control central YOLO mode. Usage: /yolo [on|off|status]",
        getArgumentCompletions: (prefix) => {
            const normalized = prefix.trim().toLowerCase();
            if (normalized.includes(" ")) return null;
            const matches = ACTIONS.filter((action) =>
                action.startsWith(normalized),
            );
            return matches.length
                ? matches.map((value) => ({ value, label: value }))
                : null;
        },
        handler: async (args, ctx) => {
            const action = args.trim().toLowerCase();
            if (!isAction(action)) {
                ctx.ui.notify(usage(), "warning");
                return;
            }

            if (action === "status") {
                const status = getYoloStatus();
                const protectedTools =
                    status.config.protectedTools.join(", ") || "none";
                const protectedExtensions =
                    status.config.protectedExtensions.join(", ") || "none";
                ctx.ui.notify(
                    `YOLO mode: ${status.enabled ? "ON" : "OFF"}${status.compatible ? "" : " (runner incompatible)"}. Protected tools: ${protectedTools}. Protected extensions: ${protectedExtensions}.`,
                    "info",
                );
                return;
            }

            const enabled = action === "on";
            if (!setYoloSessionOverride(enabled)) {
                ctx.ui.notify(
                    "YOLO cannot be enabled: configuration or runner is incompatible.",
                    "error",
                );
                return;
            }
            ctx.ui.notify(`YOLO mode: ${enabled ? "ON" : "OFF"}.`, "info");
        },
    });

    pi.on("session_start", (event, ctx) => {
        try {
            startYoloSession({
                isReload: event.reason === "reload",
                flagEnabled: pi.getFlag("yolo") === true,
                config: loadConfig(ctx.cwd),
            });
        } catch (error) {
            disableYoloForInvalidConfig();
            const message =
                error instanceof Error
                    ? error.message
                    : "Invalid YOLO configuration.";
            ctx.ui.notify(message, "error");
            return;
        }

        if (!patchInstalled || !getYoloStatus().compatible) {
            ctx.ui.notify(
                "YOLO disabled: incompatible ExtensionRunner.",
                "error",
            );
        }
    });
}
