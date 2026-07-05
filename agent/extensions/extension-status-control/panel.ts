import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  classifyStatus,
  decorateStatuses,
  filterStatuses,
  type DecoratedStatus,
} from "./statuses.ts";

export interface PanelAction {
  type: "toggle-visibility" | "back" | "cancel";
  id?: string;
}

/**
 * Present a readable select-based panel of extension statuses.
 * Returns the selected status id, or undefined if the user cancelled.
 */
export async function chooseStatus(
  ctx: ExtensionContext,
  statuses: readonly { id: string; status: string }[],
  query: string,
): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;
  const decorated = filterStatuses(decorateStatuses(statuses), query);
  if (decorated.length === 0) {
    ctx.ui.notify("No extension statuses match.", "info");
    return undefined;
  }

  const options = decorated.map((entry) => entry.label);
  const title = query.trim()
    ? `Extension statuses matching "${query.trim()}"`
    : "Extension statuses";
  const selected = await ctx.ui.select(title, options, {
    hint: "Pick a status to view its id or toggle visibility.",
  });
  if (selected === undefined) return undefined;

  const index = options.indexOf(selected);
  if (index < 0) return undefined;
  return decorated[index]?.id;
}

/**
 * Show details and actions for a single status. Returns the chosen action.
 */
export async function chooseStatusAction(
  ctx: ExtensionContext,
  entry: DecoratedStatus,
  currentlyHidden: boolean,
): Promise<PanelAction> {
  if (!ctx.hasUI) return { type: "cancel" };

  const severityLabel = severityLabelFor(entry);
  const visibilityLabel = currentlyHidden ? "hidden" : "shown";
  const options = [
    `Toggle visibility (currently ${visibilityLabel})`,
    "Back",
  ];

  const selected = await ctx.ui.select(
    `${entry.icon} ${entry.id}`,
    options,
    {
      hint: `${entry.status} — severity: ${severityLabel}`,
    },
  );

  if (selected === undefined) return { type: "cancel" };
  if (selected === options[0]) return { type: "toggle-visibility", id: entry.id };
  return { type: "back" };
}

function severityLabelFor(entry: DecoratedStatus): string {
  const matched = classifyStatus(entry.status);
  return matched;
}

/**
 * Confirm an irreversible-feeling action before applying. Kept conservative
 * because toggling visibility refreshes the footer live.
 */
export async function confirmToggle(
  ctx: ExtensionContext,
  id: string,
  nextHidden: boolean,
): Promise<boolean> {
  if (!ctx.hasUI) return false;
  return ctx.ui.confirm(
    "Extension status visibility",
    `${nextHidden ? "Hide" : "Show"} "${id}" in the footer?`,
  );
}
