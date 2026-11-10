import type {
    ExtensionAPI,
    ExtensionContext,
    Theme,
} from "@earendil-works/pi-coding-agent";
import { createWidget } from "../_shared/fancy-footer.ts";
import { createUiColors } from "../_shared/ui/ui-colors.ts";
import { getFastModeProvider } from "./provider-registry.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function fastMode(pi: ExtensionAPI): void {
    let enabled = false;
    let visible = false;
    let providerId: string | undefined;

    function widgetText(theme: Pick<Theme, "fg">): string | null {
        if (!visible) return null;
        const colors = createUiColors(theme);
        return (
            colors.subtle("🗲 ") +
            colors.muted("fast-mode") +
            colors.separator(":") +
            (enabled && providerId
                ? colors.success(providerId)
                : colors.subtle("off"))
        );
    }

    const widget = createWidget(pi, {
        id: "fast-mode",
        label: "Fast Mode",
        description:
            "Shows whether fast mode is enabled for the current model.",
        row: 1,
        order: 11,
        align: "right",
        placement: "belowEditor",
        styled: true,
        render: (ctx) => widgetText(ctx.theme),
    });

    function updateWidget(ctx: ExtensionContext, model = ctx.model) {
        const provider = getFastModeProvider(model);
        providerId = provider?.id;
        visible = ctx.hasUI && provider !== undefined;
        widget.update(ctx, widgetText(ctx.ui.theme));
        return provider;
    }

    pi.on("session_start", (_event, ctx) => {
        updateWidget(ctx);
    });
    pi.on("model_select", (event, ctx) => {
        updateWidget(ctx, event.model);
    });
    pi.on("session_shutdown", (_event, ctx) => {
        visible = false;
        widget.update(ctx, widgetText(ctx.ui.theme));
    });

    for (const name of ["fast-mode", "codex-fast-mode"]) {
        pi.registerCommand(name, {
            description:
                name === "fast-mode"
                    ? "Control fast mode for supported providers (/fast-mode on|off|status)"
                    : "Alias for /fast-mode on|off|status",
            getArgumentCompletions(prefix) {
                const trimmed = prefix.trimStart().toLowerCase();
                const options = ["on", "off", "status"].filter((value) =>
                    value.startsWith(trimmed),
                );
                return options.length > 0
                    ? options.map((value) => ({ value, label: value }))
                    : null;
            },
            handler: async (args, ctx) => {
                const arg = args.trim().toLowerCase();
                if (!["on", "off", "status", ""].includes(arg)) {
                    ctx.ui.notify(
                        `Unknown fast-mode argument: ${arg}\nUsage: /fast-mode [on|off|status]`,
                        "warning",
                    );
                    return;
                }
                if (arg === "on") enabled = true;
                else if (arg === "off") enabled = false;

                const provider = updateWidget(ctx);
                const state = enabled ? "enabled" : "disabled";
                ctx.ui.notify(
                    provider
                        ? `${provider.label} fast mode: ${state}`
                        : `Fast mode: ${state}; unavailable for the current model.`,
                    "info",
                );
            },
        });
    }

    pi.on("before_provider_request", (event, ctx) => {
        if (!enabled || !isRecord(event.payload)) return undefined;
        return getFastModeProvider(ctx.model)?.apply(event.payload);
    });
}
