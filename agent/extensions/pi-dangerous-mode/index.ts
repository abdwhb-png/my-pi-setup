import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installAuthorizerLink } from "./authorizer-link.ts";
import { loadConfig } from "./config.ts";
import {
    disableForInvalidConfig,
    getStatus,
    installRunnerPatch,
    setSessionOverride,
    startDangerousSession,
} from "./runner-patch.ts";

const ACTIONS = ["on", "off", "status"] as const;

function usage(): string {
    return "Usage: /dangerous-mode [on|off|status]";
}

function isAction(value: string): value is (typeof ACTIONS)[number] {
    return ACTIONS.some((action) => action === value);
}

export default function dangerousModeExtension(pi: ExtensionAPI): void {
    const patchInstalled = installRunnerPatch();
    installAuthorizerLink(pi);

    pi.registerFlag("dangerously-skip-permissions", {
        description:
            "Skip permission prompts and unprotected extension tool-call blockers for this session.",
        type: "boolean",
    });

    pi.registerCommand("dangerous-mode", {
        description:
            "Control dangerous mode. Usage: /dangerous-mode [on|off|status]",
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
                const status = getStatus();
                const protectedTools =
                    status.config.protectedTools.join(", ") || "none";
                const protectedExtensions =
                    status.config.protectedExtensions.join(", ") || "none";
                ctx.ui.notify(
                    `Dangerous mode: ${status.enabled ? "ON" : "OFF"}${status.compatible ? "" : " (runner incompatible)"}. Protected tools: ${protectedTools}. Protected extensions: ${protectedExtensions}.`,
                    "info",
                );
                return;
            }

            const enabled = action === "on";
            if (!setSessionOverride(enabled)) {
                ctx.ui.notify(
                    "Dangerous mode cannot be enabled: configuration or runner is incompatible.",
                    "error",
                );
                return;
            }
            ctx.ui.notify(`Dangerous mode: ${enabled ? "ON" : "OFF"}.`, "info");
        },
    });

    pi.on("session_start", (event, ctx) => {
        try {
            startDangerousSession({
                isReload: event.reason === "reload",
                flagEnabled:
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

        if (!patchInstalled || !getStatus().compatible) {
            ctx.ui.notify(
                "Dangerous mode disabled: incompatible ExtensionRunner.",
                "error",
            );
        }
    });
}
