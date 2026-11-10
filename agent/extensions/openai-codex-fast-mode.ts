import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const SERVICE_TIER = "priority";
const STATUS_KEY = "codex-fast-mode";
const ICON = "🗲";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpenAIModel(model: unknown): boolean {
    if (!isRecord(model)) return false;

    const provider =
        typeof model.provider === "string" ? model.provider.toLowerCase() : "";
    if (provider !== "openai" && provider !== "openai-codex") {
        return false;
    }

    return true;
}

function statusNotificationText(enabled: boolean): string {
    return `${ICON}Codex fast mode: ${enabled ? "enabled" : "disabled"}`;
}

export function statusText(enabled: boolean): string {
    return `${ICON}codex-fast:${enabled ? "on" : "off"}`;
}

export default function (pi: ExtensionAPI) {
    let enabled = false;
    let currentModel: unknown = undefined;

    function updateStatus(
        ctx: ExtensionContext,
        modelOverride?: unknown,
    ): void {
        if (!ctx.hasUI) return;
        if (modelOverride !== undefined) {
            currentModel = modelOverride;
        } else if (ctx.model !== undefined) {
            currentModel = ctx.model;
        }

        const visible = isOpenAIModel(currentModel);
        ctx.ui.setStatus(STATUS_KEY, visible ? statusText(enabled) : undefined);
    }

    pi.on("session_start", async (_event, ctx) => {
        updateStatus(ctx, ctx.model);
    });

    pi.on("model_select", async (event, ctx) => {
        updateStatus(ctx, event.model);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        if (ctx.hasUI) {
            ctx.ui.setStatus(STATUS_KEY, undefined);
        }
    });

    pi.registerCommand("codex-fast-mode", {
        description:
            "Toggle OpenAI Codex priority service tier (/codex-fast-mode on|off|status)",
        getArgumentCompletions(prefix) {
            const trimmed = prefix.trimStart().toLowerCase();
            const options = ["on", "off", "status"];
            const filtered = options.filter((value) =>
                value.startsWith(trimmed),
            );
            return filtered.length > 0
                ? filtered.map((value) => ({ value, label: value }))
                : null;
        },
        handler: async (args, ctx) => {
            const arg = args.trim().toLowerCase();

            if (arg === "on") {
                enabled = true;
                updateStatus(ctx);
                ctx.ui.notify(statusNotificationText(enabled), "info");
                return;
            }

            if (arg === "off") {
                enabled = false;
                updateStatus(ctx);
                ctx.ui.notify(statusNotificationText(enabled), "info");
                return;
            }

            if (arg === "status" || arg === "") {
                updateStatus(ctx);
                ctx.ui.notify(statusNotificationText(enabled), "info");
                return;
            }

            ctx.ui.notify(
                `Unknown codex-fast-mode argument: ${arg}\nUsage: /codex-fast-mode [on|off|status]`,
                "warning",
            );
        },
    });

    pi.on("before_provider_request", (event, ctx) => {
        if (!enabled) return undefined;
        if (!isOpenAIModel(ctx.model) || !isRecord(event.payload))
            return undefined;
        if (
            ctx.model?.api !== "openai-responses" &&
            ctx.model?.api !== "openai-completions" &&
            ctx.model?.api !== "openai-codex-responses"
        )
            return undefined;

        return {
            ...event.payload,
            service_tier: SERVICE_TIER,
        };
    });
}
