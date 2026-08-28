import {
    getAgentDir,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
    loadConfig,
    readUpstreamYoloMode,
    type AddonConfig,
    writeUpstreamYoloMode,
} from "./config.ts";
import { checkAndBlock, InMemorySessionCache } from "./handler.ts";

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
    const sessionCache = new InMemorySessionCache();
    let config: AddonConfig = { inherit: {} };
    /** Permission yolo follows --yolo-permission or upstream yoloMode. */
    let yolo = false;
    let pendingYoloChange:
        | { baseline: boolean; target: boolean; generation: number }
        | undefined;
    let yoloChangeGeneration = 0;

    pi.registerFlag("yolo-permission", {
        description: "Auto-approve inherited permission checks (ask → allow).",
        type: "boolean",
    });

    pi.registerCommand("yolo-permission", {
        description:
            "Control permission yolo mode. Usage: /yolo-permission [on|off|status]",
        getArgumentCompletions: (prefix: string) => {
            const normalized = prefix.trim().toLowerCase();
            if (normalized.includes(" ")) return null;
            const options = ["on", "off", "status"];
            const matches = options.filter((option) =>
                option.startsWith(normalized),
            );
            return matches.length
                ? matches.map((value) => ({ value, label: value }))
                : null;
        },
        handler: async (args, ctx) => {
            const action = args.trim().toLowerCase();
            const agentDir = getAgentDir();
            let current: boolean;

            try {
                current = readUpstreamYoloMode(agentDir);
            } catch (error) {
                ctx.ui.notify(errorMessage(error), "error");
                return;
            }

            if (action === "status") {
                ctx.ui.notify(
                    `YOLO permission mode: ${current ? "ON" : "OFF"}`,
                    "info",
                );
                return;
            }

            if (!["on", "off"].includes(action)) {
                ctx.ui.notify(
                    "Usage: /yolo-permission [on|off|status]",
                    "warning",
                );
                return;
            }

            const next = action === "on";
            const baseline = pendingYoloChange?.baseline ?? current;

            if (!pendingYoloChange && next === baseline) {
                ctx.ui.notify(
                    `YOLO permission mode is already ${next ? "ON" : "OFF"}.`,
                    "info",
                );
                return;
            }

            const generation = ++yoloChangeGeneration;
            if (next === baseline) {
                pendingYoloChange = undefined;
                ctx.ui.notify(
                    `Pending YOLO permission mode change canceled. Mode remains ${baseline ? "ON" : "OFF"}.`,
                    "info",
                );
                return;
            }

            pendingYoloChange = { baseline, target: next, generation };
            ctx.ui.notify(
                `YOLO permission mode: ${next ? "ON" : "OFF"}. Reloading when idle...`,
                "info",
            );

            await ctx.waitForIdle();
            if (pendingYoloChange?.generation !== generation) return;

            const change = pendingYoloChange;
            pendingYoloChange = undefined;
            try {
                writeUpstreamYoloMode(agentDir, change.target);
            } catch (error) {
                ctx.ui.notify(errorMessage(error), "error");
                return;
            }

            await ctx.reload();
            return;
        },
    });

    function reloadConfig(cwd: string) {
        try {
            config = loadConfig(cwd);
        } catch (err) {
            config = { inherit: {} };
            console.error(
                "[pi-permission-system-addons] Config error:",
                errorMessage(err),
            );
        }
    }

    pi.on("session_start", (_event, ctx) => {
        reloadConfig(ctx.cwd);
        sessionCache.clear();
        pendingYoloChange = undefined;
        try {
            yolo =
                process.argv.includes("--yolo-permission") ||
                readUpstreamYoloMode(getAgentDir());
        } catch (error) {
            yolo = process.argv.includes("--yolo-permission");
            console.error(
                "[pi-permission-system-addons] Config error:",
                errorMessage(error),
            );
        }
    });

    pi.on("session_shutdown", () => {
        sessionCache.clear();
        pendingYoloChange = undefined;
    });

    pi.on("tool_call", async (event, ctx) => {
        if (!config.inherit[event.toolName]) return undefined;

        const result = await checkAndBlock(
            event.toolName,
            event.input as Record<string, unknown>,
            config,
            ctx,
            pi.events,
            sessionCache,
            yolo,
        );

        if (result?.block) {
            return { block: true, reason: result.reason };
        }
        return undefined;
    });
}
