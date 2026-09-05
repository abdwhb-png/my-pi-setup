import { resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { buildSafeBashAuditPrompt, parseSafeBashAuditArgs } from "./audit.ts";
import type { SafeBashConfig } from "./config.ts";
import {
    readRecentTelemetry,
    resolveTelemetryRoot,
} from "./telemetry/storage.ts";

export interface SafeBashAuditCommandOptions {
    getConfig: () => SafeBashConfig;
    beginAudit: () => void;
    readTelemetry?: typeof readRecentTelemetry;
    buildPrompt?: typeof buildSafeBashAuditPrompt;
}

export function registerSafeBashAuditCommand(
    pi: ExtensionAPI,
    options: SafeBashAuditCommandOptions,
): void {
    const readTelemetry = options.readTelemetry ?? readRecentTelemetry;
    const buildPrompt = options.buildPrompt ?? buildSafeBashAuditPrompt;

    pi.registerCommand("safe-bash-audit", {
        description:
            "Analyze recent local safe-bash telemetry and recommend guard improvements: [days=N] [limit=N].",
        handler: async (args, ctx) => {
            try {
                const config = options.getConfig();
                if (!config.telemetry.enabled) {
                    ctx.ui.notify("safe-bash telemetry is disabled", "warning");
                    return;
                }
                const auditOptions = parseSafeBashAuditArgs(args, {
                    days: config.telemetry.auditDays,
                    limit: config.telemetry.auditLimit,
                });
                const project = resolve(ctx.cwd);
                const events = await readTelemetry(
                    resolveTelemetryRoot(config.telemetry.directory),
                    {
                        ...auditOptions,
                        project,
                    },
                );
                if (events.length === 0) {
                    ctx.ui.notify(
                        `No safe-bash telemetry found for ${project} in the last ${auditOptions.days} days.`,
                        "info",
                    );
                    return;
                }
                const prompt = buildPrompt(events, project, auditOptions);
                options.beginAudit();
                pi.sendUserMessage(prompt);
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                ctx.ui.notify(`safe-bash audit failed: ${message}`, "error");
            }
        },
    });
}
