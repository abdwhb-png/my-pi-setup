import { readFileSync } from "node:fs";
import {
    getAgentDir,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { registerSubagentCapabilityCeiling } from "pi-subagents/capability-ceiling";
import { collectWorkflowAgentDefinitions } from "../_shared/subagents/workflow-agents.ts";
import {
    parseFallbackAdviceConfig,
    registerFallbackAdvice,
} from "./fallback-advice.ts";
import { syncGeneratedToolSettings } from "./generated-tool-settings.ts";
import registerSubagentsOverview from "./pi-subagents-overview/index.ts";
import registerSubagentWaitGuard from "./subagent-wait-guard/index.ts";
import {
    compileToolGroupOverrides,
    parseToolGroupOverridesConfig,
} from "./tool-group-overrides.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readAddonsConfig(
    path: string | URL = new URL("./config.json", import.meta.url),
) {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) throw new Error("Invalid subagents addon config");
    return {
        subagentWaitGuard:
            isRecord(parsed.subagentWaitGuard) &&
            parsed.subagentWaitGuard.enabled === true,
        piSubagentsOverview:
            isRecord(parsed.piSubagentsOverview) &&
            parsed.piSubagentsOverview.enabled === true,
        toolGroupOverrides: parseToolGroupOverridesConfig(
            parsed.toolGroupOverrides,
        ),
        fallbackAdvice: parseFallbackAdviceConfig(
            parsed.fallbackAdvice ?? { enabled: false },
        ),
    };
}

export default function registerSubagentsAddons(
    pi: ExtensionAPI,
    configPath?: string | URL,
): void {
    let config: ReturnType<typeof readAddonsConfig> | undefined;
    let loadError: unknown;
    try {
        config = readAddonsConfig(configPath);
    } catch (error) {
        // A factory exception would unload the guard as well. Report it at startup instead.
        loadError = error;
    }
    if (process.env.PI_SUBAGENT_CHILD !== "1") {
        let denial:
            | ReturnType<typeof registerSubagentCapabilityCeiling>
            | undefined;
        pi.on("session_start", async (event, ctx) => {
            const gate = registerSubagentCapabilityCeiling({
                sessionId:
                    ctx.sessionManager.getSessionFile() ??
                    ctx.sessionManager.getSessionId(),
                source: "pi-subagents-addons:generated-tools",
                ceiling: { allowedAgents: [] },
            });
            denial?.dispose();
            denial = gate;
            try {
                if (event.reason === "startup" && loadError) throw loadError;
                const current = readAddonsConfig(configPath);
                if (current.toolGroupOverrides.enabled) {
                    const workflow = collectWorkflowAgentDefinitions(pi.events);
                    if (workflow.diagnostics.length)
                        throw new Error(workflow.diagnostics.join("; "));
                    const options = {
                        cwd: ctx.cwd,
                        agentDir: getAgentDir(),
                        projectTrusted: ctx.isProjectTrusted(),
                    };
                    const compilation = compileToolGroupOverrides({
                        ...options,
                        config: current.toolGroupOverrides,
                        workflowAgents: workflow.entries,
                    });
                    if (compilation)
                        await syncGeneratedToolSettings({
                            ...options,
                            compilation,
                        });
                }
                gate.dispose();
                if (denial === gate) denial = undefined;
                ctx.ui.setStatus("generated-tools", undefined);
            } catch (error) {
                const message = `Subagent launches blocked: ${error instanceof Error ? error.message : String(error)}. Fix configuration or ownership conflict, then /reload.`;
                ctx.ui.setStatus("generated-tools", message);
                ctx.ui.notify(message, "error");
            }
        });
        pi.on("session_shutdown", () => {
            denial?.dispose();
            denial = undefined;
        });
    }
    if (config?.subagentWaitGuard) registerSubagentWaitGuard(pi);
    if (config?.piSubagentsOverview) registerSubagentsOverview(pi);
    if (config?.fallbackAdvice.enabled)
        registerFallbackAdvice(pi, config.fallbackAdvice);
}
