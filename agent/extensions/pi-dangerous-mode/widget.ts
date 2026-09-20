import type { Theme } from "@earendil-works/pi-coding-agent";
import { createUiColors } from "../_shared/ui/ui-colors.ts";
import type { RuntimeStatus } from "./runtime-state.ts";

export const DANGEROUS_ICON = "‼️";
export const WIDGET_ID = "dangerous-mode";

export function buildDangerousWidgetText(status: RuntimeStatus): string {
    return [
        status.dangerous.effective ? "dangerous: ON" : undefined,
        status.unattended.effective ? "unattended: ON" : undefined,
    ]
        .filter((state): state is string => state !== undefined)
        .join(" ");
}

/** Renders independent Dangerous and Unattended state for the footer. */
export function renderDangerousWidget(
    theme: Theme | undefined | null,
    status: RuntimeStatus,
): string | null {
    if (!status.dangerous.effective && !status.unattended.effective) {
        return null;
    }
    const colors = createUiColors(
        theme?.fg ? theme : { fg: (_color, text: string) => text },
    );
    const label = colors.subtle(DANGEROUS_ICON);
    return `${label} ${colors.danger(buildDangerousWidgetText(status))}`;
}
