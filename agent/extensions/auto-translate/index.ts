/**
 * auto-translate extension.
 *
 * Intercepts user input, detects the source language, and translates it to a
 * configured target language using a direct LLM API call (NOT a pi execution
 * agent). See README.md for commands and configuration.
 *
 * Config: ~/.pi/agent/settings.json key "translate" (or legacy translate.json),
 * with project-local override in <cwd>/.pi/. Loaded via the shared
 * `_shared/config-loader.ts`.
 */

import { complete } from '@earendil-works/pi-ai/compat';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { registerCommands } from './commands.ts';
import { loadTranslateConfig } from './config.ts';
import { createState, buildStatusText, icon } from './state.ts';
import { translate } from './translator.ts';
import type { TranslateConfig } from './types.ts';
import { createTranslateWidget } from './widget.ts';

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
    const config = loadTranslateConfig(cwd, agentDir);
    const state = createState(config);

    const widget = createTranslateWidget(pi, () =>
        buildStatusText(state, config),
    );

    const refresh = (ctx: Parameters<typeof widget.update>[0]): void => {
        widget.update(ctx, buildStatusText(state, config));
    };

    registerCommands(pi, { state, config, refresh });

    pi.on('session_start', async (_event, ctx) => {
        refresh(ctx);
    });

    pi.on('session_shutdown', async (_event, ctx) => {
        widget.remove(ctx);
    });

    pi.on('input', async (event, ctx) => {
        // Never translate our own injected or extension-routed messages.
        if (event.source === 'extension') return { action: 'continue' };
        if (!state.enabled) return { action: 'continue' };
        const text = event.text?.trim();
        if (!text) return { action: 'continue' };

        const targetName = config.languages[state.target] ?? state.target;
        const modelSpec = effectiveModel(config, ctx.model);
        if (!modelSpec) {
            ctx.ui.notify(
                'auto-translate: no model configured (set translate.model in settings.json)',
                'warning',
            );
            return { action: 'continue' };
        }

        ctx.ui.setStatus(
            'auto-translate',
            ctx.ui.theme.fg('accent', `${icon} translating…`),
        );
        let translated: string | null;
        try {
            translated = await translate(
                text,
                targetName,
                { ...config, model: modelSpec },
                { complete },
                ctx,
            );
        } finally {
            ctx.ui.setStatus('auto-translate', undefined);
        }

        // Pass through if translation failed or text was already the target language.
        if (translated == null || translated === text)
            return { action: 'continue' };

        if (state.sendEnabled) {
            return { action: 'transform', text: translated };
        }
        ctx.ui.notify(`[${state.target}] ${translated}`, 'info');
        return { action: 'continue' };
    });
}
