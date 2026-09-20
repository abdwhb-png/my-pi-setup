import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { createUiColors } from "../_shared/ui/ui-colors.ts";

export const BROWSER_TOOLS_WIDGET_ID = "browser-tools";
export const BROWSER_TOOLS_WIDGET_LABEL = "Browser Tools";
export const BROWSER_TOOLS_LABEL = "browser";

/**
 * Rendered inside the widget label. The contribution deliberately declares no
 * footer icon: pi-fancy-footer prepends its own icon to the first line, which
 * would render the globe twice.
 */
export const BROWSER_TOOLS_EMOJI = "🌐";

/** Model-facing availability of the native Agent Browser tools. */
export type BrowserToolsStatus =
    | "hidden"
    | "manual"
    | "manual (restricted)"
    | "unavailable";

/**
 * Identity colors keep fallback and unit-test renders plain. Typed against
 * `createUiColors` so a member added to the shared palette fails to compile here.
 */
const IDENTITY_COLORS: ReturnType<typeof createUiColors> = {
    apply: (_color: ThemeColor, text: string) => text,
    separator: (text: string) => text,
    subtle: (text: string) => text,
    muted: (text: string) => text,
    meta: (text: string) => text,
    primary: (text: string) => text,
    success: (text: string) => text,
    warning: (text: string) => text,
    danger: (text: string) => text,
    text: (text: string) => text,
    model: (text: string) => text,
    toolOutput: (text: string) => text,
    pressure: (text: string) => text,
};

/**
 * Render Agent Browser availability for the footer. A missing theme (fallback
 * widget, unit tests) yields unstyled text instead of throwing.
 */
export function renderBrowserToolsWidget(
    theme: Theme | undefined | null,
    status: BrowserToolsStatus,
): string {
    const colors = theme?.fg ? createUiColors(theme) : IDENTITY_COLORS;
    const label = colors.subtle(
        `${BROWSER_TOOLS_EMOJI} ${BROWSER_TOOLS_LABEL}:`,
    );
    if (status === "manual") return `${label} ${colors.success(status)}`;
    if (status === "manual (restricted)") {
        return `${label} ${colors.warning(status)}`;
    }
    if (status === "unavailable") return `${label} ${colors.danger(status)}`;
    return `${label} ${colors.subtle(status)}`;
}
