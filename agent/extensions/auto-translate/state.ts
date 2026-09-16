/**
 * Runtime state for the auto-translate extension.
 *
 * In-memory, per-session. Resets each session. Not persisted to disk.
 */

import type {
    RuntimeState,
    StatusRenderMode,
    TranslateConfig,
} from "./types.ts";

/** Fallback target code when the configured default is missing from `languages`. */
const FALLBACK_TARGET = "en";

/**
 * Glyph for the footer widget and the transient status line. Kept distinct from
 * the browser-tools globe so two widgets never read as the same feature.
 */
export const TRANSLATE_EMOJI = "🔤";

/** Create a fresh runtime state object from config defaults. */
export function createState(config: TranslateConfig): RuntimeState {
    const target =
        config.defaultTargetLanguage in config.languages
            ? config.defaultTargetLanguage
            : FALLBACK_TARGET;
    return {
        enabled: false,
        sendEnabled: true,
        target,
    };
}

/** Flip sendEnabled on a state object in place. */
export function toggleSend(state: RuntimeState): void {
    state.sendEnabled = !state.sendEnabled;
}

export function buildStatusRenderText(
    name: string,
    mode: StatusRenderMode,
): string {
    return `${TRANSLATE_EMOJI} translate → ${name} | ${mode}`;
}

export const offText = `${TRANSLATE_EMOJI} translate: off`;

/** Render the fancy-footer status text for the current state. */
export function buildStatusText(
    state: RuntimeState,
    config: TranslateConfig,
): string {
    if (!state.enabled) return offText;
    const name = config.languages[state.target] ?? state.target;
    const mode: StatusRenderMode = state.sendEnabled ? "send" : "display";
    return buildStatusRenderText(name, mode);
}
