/**
 * Slash-command registration for the auto-translate extension.
 *
 * Static commands: /translate-on, /translate-off, /translate-send.
 * Dynamic commands: one /translate-to-<code> per key in config.languages.
 *
 * Every handler mutates runtime state, then calls `refresh(ctx)` so the
 * fancy-footer status widget stays in sync, and notifies the user.
 */

import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { RuntimeState, TranslateConfig } from './types.ts';

export interface CommandDeps {
    state: RuntimeState;
    config: TranslateConfig;
    /** Repaint the status widget after a state change. */
    refresh: (ctx: ExtensionContext) => void;
}

/** Register all translate commands (static + dynamic per-language). */
export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
    const { state, config, refresh } = deps;

    pi.registerCommand('translate-on', {
        description: 'Enable auto-translation of input',
        handler: async (_args, ctx) => {
            state.enabled = true;
            refresh(ctx);
            ctx.ui.notify(
                `Translation on → ${config.languages[state.target] ?? state.target}`,
                'info',
            );
        },
    });

    pi.registerCommand('translate-off', {
        description: 'Disable auto-translation of input',
        handler: async (_args, ctx) => {
            state.enabled = false;
            refresh(ctx);
            ctx.ui.notify('Translation off', 'info');
        },
    });

    pi.registerCommand('translate-send', {
        description:
            'Toggle whether translated text is sent to the agent (on) or only displayed (off)',
        handler: async (_args, ctx) => {
            state.sendEnabled = !state.sendEnabled;
            refresh(ctx);
            ctx.ui.notify(
                state.sendEnabled
                    ? 'Send mode: translated text replaces your input'
                    : 'Display mode: translation shown as a popup, original sent unchanged',
                'info',
            );
        },
    });

    for (const [code, name] of Object.entries(config.languages)) {
        pi.registerCommand(`translate-to-${code}`, {
            description: `Set translation target language to ${name} (${code}) and enable translation`,
            handler: async (_args, ctx) => {
                state.target = code;
                state.enabled = true;
                refresh(ctx);
                ctx.ui.notify(
                    `Target → ${name} (${code}). Translation enabled.`,
                    'info',
                );
            },
        });
    }
}
