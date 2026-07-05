/**
 * Extension Status Control
 *
 * Registers `/extension-status [query]` slash command with autocomplete of
 * current extension statuses (sourced from pi-fancy-footer snapshot API via the
 * shared bridge). Selecting a status opens a readable dialog to view its id and
 * toggle visibility in the extension-statuses footer widget.
 *
 * Requires pi-fancy-footer. Visibility is stored in
 * `~/.pi/agent/fancy-footer.json extensionStatusHiddenIds`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  getFancyFooterExtensionStatusesSnapshot,
  requestFancyFooterRefresh,
  subscribeFancyFooterExtensionStatuses,
} from "../_shared/fancy-footer.ts";
import { decorateStatuses, toCompletions } from "./statuses.ts";
import { chooseStatus, chooseStatusAction, confirmToggle } from "./panel.ts";
import { isHidden, toggleHidden } from "./visibility.ts";
import { decorateStatuses, toCompletions } from "./statuses.ts";

const COMMAND_NAME = "extension-status";

// Lightweight FS layer wrapped in an object so tests can swap it.
export const configIO = {
  getAgentDir(): string {
    return process.env.HOME
      ? join(process.env.HOME, ".pi", "agent")
      : join(process.cwd(), ".pi", "agent");
  },
  getConfigPath(): string {
    return join(this.getAgentDir(), "fancy-footer.json");
  },
  readHiddenIds(): string[] {
    const path = this.getConfigPath();
    if (!existsSync(path)) return [];
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      const value = raw?.extensionStatusHiddenIds;
      return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
    } catch {
      return [];
    }
  },
  writeHiddenIds(hiddenIds: readonly string[]): void {
    const path = this.getConfigPath();
    let raw: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      } catch {
        raw = {};
      }
    }
    raw.extensionStatusHiddenIds = [...hiddenIds];
    mkdirSync(this.getAgentDir(), { recursive: true });
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  },
};

export default function (pi: ExtensionAPI) {
  // Keep a local cache so autocomplete is responsive even before the next
  // snapshot publish.
  let latestStatuses = getFancyFooterExtensionStatusesSnapshot(pi);
  subscribeFancyFooterExtensionStatuses(pi, (snapshot) => {
    latestStatuses = snapshot;
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Browse extension statuses and toggle their footer visibility.",
    getArgumentCompletions: (prefix: string) => {
      const statuses = decorateStatuses(latestStatuses);
      const filtered = prefix
        ? statuses.filter(
            (entry) =>
              entry.id.toLowerCase().includes(prefix.toLowerCase()) ||
              entry.status.toLowerCase().includes(prefix.toLowerCase()),
          )
        : statuses;
      return toCompletions(filtered);
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;
      if (latestStatuses.length === 0) {
        ctx.ui.notify(
          "No extension statuses available yet. Open the footer / wait for a refresh.",
          "info",
        );
        return;
      }

      const query = typeof args === "string" ? args.trim() : "";

      let selectedId: string | undefined;
      // Loop so "Back" from the action menu returns to the list.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        selectedId = await chooseStatus(ctx, latestStatuses, query);
        if (!selectedId) return;

        const entry = decorateStatuses(latestStatuses).find(
          (decorated) => decorated.id === selectedId,
        );
        if (!entry) return;

        const hiddenIds = configIO.readHiddenIds();
        const hidden = isHidden(hiddenIds, entry.id);
        const action = await chooseStatusAction(ctx, entry, hidden);

        if (action.type === "toggle-visibility" && action.id) {
          const next = toggleHidden(hiddenIds, action.id);
          const confirmed = await confirmToggle(ctx, action.id, next.nowHidden);
          if (!confirmed) continue;
          configIO.writeHiddenIds(next.hiddenIds);
          requestFancyFooterRefresh(pi);
          ctx.ui.notify(
            `${action.id} is now ${next.nowHidden ? "hidden" : "shown"}`,
            "info",
          );
          return;
        }
        if (action.type === "back") continue;
        return;
      }
    },
  });
}
