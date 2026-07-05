import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWidget, type FancyFooterAPI } from "../_shared/fancy-footer";
import { createUiColors, type UiColorsCreation } from "../_shared/ui-colors";
import { getActivePiRole, icon, type ActiveRoleState } from "../_shared/pi-roles";

const WIDGET_ID = "pi-roles.active-role";

export function renderActiveRoleWidget(
  role: ActiveRoleState | null,
  colors: UiColorsCreation,
): string | undefined {
  return `${icon}Role: ${role ? colors.primary(`${role.name}`) : colors.muted(`🚫 No active role`)}`;
}

export default function roleWidget(pi: ExtensionAPI): void {
  let latestRender: string | undefined;

  const widget = createWidget(pi as unknown as FancyFooterAPI, {
    id: WIDGET_ID,
    description: "Shows the active pi-roles role.",
    row: 0,
    order: 24,
    align: "left",
    render: () => latestRender,
  });

  const refresh = (ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]) => {
    latestRender = renderActiveRoleWidget(getActivePiRole(ctx), createUiColors(ctx.ui.theme));
    widget.update(ctx, latestRender);
  };

  pi.on("session_start", async (_event, ctx) => refresh(ctx));
  pi.on("before_agent_start", async (_event, ctx) => refresh(ctx));
  pi.on("turn_end", async (_event, ctx) => refresh(ctx));
  pi.on("session_shutdown", async (_event, ctx) => widget.remove(ctx));
}
