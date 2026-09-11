import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    getPermissionsService,
    PERMISSIONS_READY_CHANNEL,
} from "@gotgenes/pi-permission-system";
import { loadConfig, type AddonConfig } from "./config.ts";
import { checkAndBlock, InMemorySessionCache } from "./handler.ts";

const YOLO_AUTHORIZER_NAME = "pi-yolo-permission";

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
    const sessionCache = new InMemorySessionCache();
    let config: AddonConfig = { inherit: {} };
    let sessionYolo = false;
    const authorizerDisposers: Array<() => void> = [];

    pi.events.on(PERMISSIONS_READY_CHANNEL, () => {
        const service = getPermissionsService();
        if (!service) return;

        const dispose = service.registerAuthorizer(
            YOLO_AUTHORIZER_NAME,
            async (_details, _query, log) => {
                if (!sessionYolo) return { kind: "defer" };
                log.review("session_yolo.auto_allow", {});
                return { kind: "allow" };
            },
        );
        authorizerDisposers.push(dispose);
    });

    pi.registerCommand("yolo-permission", {
        description:
            "Control session-scoped permission yolo mode. Usage: /yolo-permission [on|off|status]",
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

            if (action === "status") {
                ctx.ui.notify(
                    `Session YOLO permission mode: ${sessionYolo ? "ON" : "OFF"}`,
                    "info",
                );
                return;
            }

            if (action !== "on" && action !== "off") {
                ctx.ui.notify(
                    "Usage: /yolo-permission [on|off|status]",
                    "warning",
                );
                return;
            }

            sessionYolo = action === "on";
            ctx.ui.notify(
                `Session YOLO permission mode: ${sessionYolo ? "ON" : "OFF"}`,
                "info",
            );
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
        sessionYolo = false;
    });

    pi.on("session_shutdown", () => {
        sessionCache.clear();
        sessionYolo = false;
        for (const dispose of authorizerDisposers.splice(0)) dispose();
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
            sessionYolo,
        );

        if (result?.block) {
            return { block: true, reason: result.reason };
        }
        return undefined;
    });
}
