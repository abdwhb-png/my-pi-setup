import type { Theme } from "@earendil-works/pi-coding-agent";
import { createUiColors } from "../_shared/ui/ui-colors.ts";
import type { RuntimeStatus } from "./runtime-state.ts";

export const DANGEROUS_ICON = "‼️";
export const WIDGET_ID = "dangerous-mode";

/**
 * Pure render for the dangerous-mode footer widget.
 * Returns null when hidden (neither dangerous nor autopilot effective).
 * Styled string when visible: dim label + colored value.
 */
export function renderDangerousWidget(
    theme: Theme | undefined | null,
    status: RuntimeStatus,
): string | null {
    const isEffective =
        status.dangerous.effective || status.autopilot.effective;
    if (!isEffective) return null;
    const colors = theme?.fg
        ? createUiColors(theme)
        : ({
              subtle: (t: string) => t,
              danger: (t: string) => t,
          } as ReturnType<typeof createUiColors>);
    const label = colors.subtle(`${DANGEROUS_ICON} dangerous:`);
    if (!status.configValid || !status.compatible.runner) {
        return `${label} ${colors.danger("ERR")}`;
    }
    if (status.autopilot.effective) {
        const phase = status.autopilot.phase;
        const turns = `${status.autopilot.turnsUsed}`;
        const value = colors.danger(`ON auto:${phase} ${turns}`);
        return `${label} ${value}`;
    }
    return `${label} ${colors.danger("ON")}`;
}
