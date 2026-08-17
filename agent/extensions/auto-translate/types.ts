/**
 * Type definitions for the auto-translate extension.
 */

/** ISO 639-1 code -> human language name. Keys drive /translate-to-<code> commands. */
export type LanguagesMap = Record<string, string>;

/** Resolved configuration loaded via the shared config-loader. */
export interface TranslateConfig {
    /** "<provider>/<id>" string resolved via getModel(). Undefined -> use active session model. */
    model: string | undefined;
    /** Default target language code applied at session start. Must exist in `languages`. */
    defaultTargetLanguage: string;
    /** Supported languages. Keys = command suffixes; values = names used in prompts/UI. */
    languages: LanguagesMap;
}

/** In-memory, per-session runtime state. Resets each session. Not persisted. */
export interface RuntimeState {
    enabled: boolean;
    sendEnabled: boolean;
    target: string;
}

/** Widget render mode: translated text replaces input (send) or popup-only (display). */
export type StatusRenderMode = "send" | "display";

/** Default config when no source provides a value. */
export const DEFAULT_CONFIG: TranslateConfig = {
    model: undefined,
    defaultTargetLanguage: "en",
    languages: {
        en: "English",
    },
};

/** Default runtime state at session start. Send defaults to on per user spec. */
export function defaultRuntimeState(config: TranslateConfig): RuntimeState {
    return {
        enabled: false,
        sendEnabled: true,
        target: config.defaultTargetLanguage,
    };
}
