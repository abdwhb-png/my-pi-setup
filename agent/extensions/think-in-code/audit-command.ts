import { resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { buildThinkAuditPrompt, parseThinkAuditArgs } from "./audit.ts";
import type { ThinkInCodeConfig } from "./config.ts";
import { readRecentThinkTelemetry } from "./telemetry/storage.ts";

export interface ThinkAuditCommandOptions {
    getConfig(): ThinkInCodeConfig;
    getTelemetryRoot(): string | undefined;
    beginAudit(): void;
    readTelemetry?: typeof readRecentThinkTelemetry;
    buildPrompt?: typeof buildThinkAuditPrompt;
}

export function registerThinkAuditCommand(
    pi: ExtensionAPI,
    options: ThinkAuditCommandOptions,
): void {
    const readTelemetry = options.readTelemetry ?? readRecentThinkTelemetry;
    const buildPrompt = options.buildPrompt ?? buildThinkAuditPrompt;

    pi.registerCommand("think-audit", {
        description:
            "Analyze recent current-project Think command telemetry and recommend policy improvements: [days=N] [limit=N].",
        handler: async (args, ctx) => {
            try {
                const config = options.getConfig();
                if (!config.telemetry.enabled) {
                    ctx.ui.notify(
                        "Think-in-Code telemetry is disabled",
                        "warning",
                    );
                    return;
                }
                const telemetryRoot = options.getTelemetryRoot();
                if (!telemetryRoot) {
                    ctx.ui.notify(
                        "Think-in-Code telemetry is not initialized",
                        "warning",
                    );
                    return;
                }
                const auditOptions = parseThinkAuditArgs(args, {
                    days: config.telemetry.auditDays,
                    limit: config.telemetry.auditLimit,
                });
                const project = resolve(ctx.cwd);
                const events = await readTelemetry(telemetryRoot, {
                    ...auditOptions,
                    project,
                });
                if (events.length === 0) {
                    ctx.ui.notify(
                        `No Think-in-Code telemetry found for ${project} in the last ${auditOptions.days} days.`,
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
                ctx.ui.notify(`think audit failed: ${message}`, "error");
            }
        },
    });
}
