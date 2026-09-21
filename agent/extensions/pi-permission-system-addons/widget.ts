import type { Theme } from "@earendil-works/pi-coding-agent";
import { createUiColors } from "../_shared/ui/ui-colors.ts";

export const YOLO_WIDGET_ID = "yolo-permission";
export const YOLO_ICON_ON = "●";
export const YOLO_ICON_OFF = "◉";

/**
 * Flip to hide the widget while session yolo is off. Keep `false` for an
 * always-visible on|off indicator.
 */
export const HIDE_YOLO_WIDGET_WHEN_OFF = false;

export interface YoloWidgetRenderOptions {
    hideWhenOff?: boolean;
}

export function buildYoloWidgetText(enabled: boolean): string {
    return `yoloSession: ${enabled ? "on" : "off"}`;
}

/** Renders the session yolo state for the footer; `null` only when off and hiding. */
export function renderYoloWidget(
    theme: Theme | undefined | null,
    enabled: boolean,
    options: YoloWidgetRenderOptions = {},
): string | null {
    if (!enabled && options.hideWhenOff) return null;

    const colors = createUiColors(
        theme?.fg ? theme : { fg: (_color, text: string) => text },
    );
    const value = enabled ? "on" : "off";
    const state = enabled ? "warning" : "muted";
    const icon = colors[state](enabled ? YOLO_ICON_ON : YOLO_ICON_OFF);
    return `${icon} ${colors.subtle("yoloSession:")} ${colors[state](value)}`;
}