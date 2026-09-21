import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
    getPermissionsService,
    PERMISSIONS_READY_CHANNEL,
} from "@gotgenes/pi-permission-system";
import type { PermissionsReadyEvent } from "@gotgenes/pi-permission-system";
import { createWidget } from "../_shared/fancy-footer.ts";
import { loadConfig, type AddonConfig } from "./config.ts";
import { checkAndBlock, InMemorySessionCache } from "./handler.ts";
import {
    HIDE_YOLO_WIDGET_WHEN_OFF,
    renderYoloWidget,
    YOLO_WIDGET_ID,
} from "./widget.ts";

const YOLO_AUTHORIZER_NAME = "pi-yolo-permission";

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
    const sessionCache = new InMemorySessionCache();
    let config: AddonConfig = { inherit: {} };
    let sessionYolo = false;
    let sessionId: string | null = null;
    const authorizerDisposers: Array<() => void> = [];

    const widgetOptions = { hideWhenOff: HIDE_YOLO_WIDGET_WHEN_OFF };
    const widget = createWidget(pi, {
        id: YOLO_WIDGET_ID,
        label: "YOLO Permission",
        description: "State du mode yolo-permission de session",
        row: 2,
        order: 13,
        align: "left",
        styled: true,
        render: (ctx) => renderYoloWidget(ctx.theme, sessionYolo, widgetOptions),
    });

    function refreshYoloWidget(ctx: {
        hasUI?: boolean;
        ui?: { theme?: Theme | null };
    }): void {
        widget.update(
            ctx as never,
            renderYoloWidget(ctx.ui?.theme, sessionYolo, widgetOptions),
        );
    }

    pi.events.on(
        PERMISSIONS_READY_CHANNEL,
        (payload: unknown) => {
            const ready = payload as PermissionsReadyEvent;
            if (!ready?.sessionId) return;
            sessionId = ready.sessionId;

            const service = getPermissionsService(ready.sessionId);
            if (!service) return;

            // permissions:ready fires at least once per session and may repeat
            // (v27+); registering again without disposing would throw.
            for (const dispose of authorizerDisposers.splice(0)) dispose();
            const dispose = service.registerAuthorizer(
                YOLO_AUTHORIZER_NAME,
                async (_details, _query, log) => {
                    if (!sessionYolo) return { kind: "defer" };
                    log.review("session_yolo.auto_allow", {});
                    return { kind: "allow" };
                },
            );
            authorizerDisposers.push(dispose);
        },
    );

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
            refreshYoloWidget(ctx);
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
        sessionId = null;
        refreshYoloWidget(ctx);
    });

    pi.on("session_shutdown", (_event, ctx) => {
        sessionCache.clear();
        sessionYolo = false;
        sessionId = null;
        for (const dispose of authorizerDisposers.splice(0)) dispose();
        widget.remove(ctx as never);
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
            sessionId,
        );

        if (result?.block) {
            return { block: true, reason: result.reason };
        }
        return undefined;
    });
}
