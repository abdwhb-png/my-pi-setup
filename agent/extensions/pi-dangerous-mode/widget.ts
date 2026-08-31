import type { Theme } from "@earendil-works/pi-coding-agent";
import { createUiColors } from "../_shared/ui/ui-colors.ts";
import type { RuntimeStatus } from "./runtime-state.ts";

export const DANGEROUS_ICON = "‼️";
export const WIDGET_ID = "dangerous-mode";

/** Renders independent Dangerous and Unattended state for the footer. */
export function renderDangerousWidget(
    theme: Theme | undefined | null,
    status: RuntimeStatus,
): string | null {
    if (!status.dangerous.effective && !status.unattended.effective) {
        return null;
    }
    const colors = theme?.fg
        ? createUiColors(theme)
        : ({
              subtle: (text: string) => text,
              danger: (text: string) => text,
          } as ReturnType<typeof createUiColors>);
    const label = colors.subtle(DANGEROUS_ICON);
    const states = [
        status.dangerous.effective ? "dangerous: ON" : undefined,
        status.unattended.effective ? "unattended: ON" : undefined,
    ].filter((state): state is string => state !== undefined);
    return `${label} ${colors.danger(states.join(" "))}`;
}
