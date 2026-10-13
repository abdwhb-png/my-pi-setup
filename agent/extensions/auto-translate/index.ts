/**
 * auto-translate extension.
 *
 * Intercepts user input, detects the source language, and translates it to a
 * configured target language using a direct LLM API call (NOT a pi execution
 * agent). See README.md for commands and configuration.
 *
 * Config: ~/.pi/agent/config/translate.json, with a saved-trust project override
 * in <cwd>/.pi/config/translate.json. Loaded via the shared
 * `_shared/config-loader.ts`.
 */

import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import { loadTranslateConfig } from "./config.ts";
import { createState, buildStatusText, translatingText } from "./state.ts";
import type { TranslateConfig } from "./types.ts";
import type { createTranslateWidget } from "./widget.ts";

/** Resolve the effective model spec: configured model, else the active session model. */
function effectiveModel(
    config: TranslateConfig,
    ctxModel?: { provider?: string; id?: string },
): string | undefined {
    if (config.model) return config.model;
    if (ctxModel?.provider && ctxModel?.id)
        return `${ctxModel.provider}/${ctxModel.id}`;
    return undefined;
}

export default function (pi: ExtensionAPI): void {
    const cwd = process.cwd();
    const agentDir = getAgentDir();
    const config = loadTranslateConfig(cwd, agentDir, false);
    const state = createState(config);

    const widgetText = (): string =>
        state.enabled ? buildStatusText(state, config) : "";

    let widget: ReturnType<typeof createTranslateWidget> | undefined;

    const refresh = async (ctx: ExtensionContext): Promise<void> => {
        if (!widget && state.enabled) {
            const { createTranslateWidget } = await import("./widget.ts");
            if (state.enabled) {
                widget ??= createTranslateWidget(
                    pi,
                    widgetText,
                    () => state.enabled,
                );
            }
        }
        widget?.update(ctx, widgetText());
    };

    registerCommands(pi, { state, config, refresh });

    pi.on("session_start", async (_event, ctx) => {
        Object.assign(
            config,
            loadTranslateConfig(ctx.cwd, agentDir, ctx.isProjectTrusted()),
        );
        Object.assign(state, createState(config));
        registerCommands(pi, { state, config, refresh });
        await refresh(ctx);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        state.enabled = false;
        widget?.remove(ctx);
    });

    pi.on("input", async (event, ctx) => {
        // Never translate our own injected or extension-routed messages.
        if (event.source === "extension") return { action: "continue" };
        if (!state.enabled) return { action: "continue" };
        const text = event.text?.trim();
        if (!text) return { action: "continue" };

        const targetName = config.languages[state.target] ?? state.target;
        const modelSpec = effectiveModel(config, ctx.model);
        if (!modelSpec) {
            ctx.ui.notify(
                "auto-translate: no model configured (set model in config/translate.json)",
                "warning",
            );
            return { action: "continue" };
        }

        ctx.ui.setStatus(
            "auto-translate",
            ctx.ui.theme.fg("accent", translatingText),
        );
        let translated: string | null;
        try {
            const { translate } = await import("./translator.ts");
            translated = await translate(
                text,
                targetName,
                { ...config, model: modelSpec },
                {},
                ctx,
            );
        } finally {
            ctx.ui.setStatus("auto-translate", undefined);
        }

        // Pass through if translation failed or text was already the target language.
        if (translated == null || translated === text)
            return { action: "continue" };

        if (state.sendEnabled) {
            return { action: "transform", text: translated };
        }
        ctx.ui.notify(`[${state.target}] ${translated}`, "info");
        return { action: "continue" };
    });
}
