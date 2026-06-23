import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runGit, getBranch, getUnstagedCount } from "./_shared/git-helper";
import { createWidget } from "./_shared/fancy-footer";
import {
  createUiColors,
} from "./_shared/ui-colors";

const WIDGET_ID = "git-status-widget";
const UPDATE_INTERVAL_MS = 2_000;

let widgetText: string | null = null;

async function refreshWidgetText(ctx: ExtensionContext): Promise<string | null> {
  if (!ctx.hasUI) return null;

  try {

    await runGit(["rev-parse", "--is-inside-work-tree"], ctx.cwd);
    const [branch, unstagedCount] = await Promise.all([
      getBranch(ctx.cwd),
      getUnstagedCount(ctx.cwd),
    ]);

    const colors = createUiColors(ctx.ui.theme);

    const fileLabel = unstagedCount === 1 ? "file" : "files";
    return ` ${colors.primary(branch)} · ${colors.warning(`${unstagedCount} unstaged ${fileLabel}`)}`;
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  let interval: NodeJS.Timeout | undefined;
  let w: ReturnType<typeof createWidget> | undefined;

  pi.on("session_start", async (_event, ctx) => {
    if (interval) clearInterval(interval);

    w = createWidget(pi, {
      id: WIDGET_ID,
      label: "Git Status",
      description: "Shows current branch and unstaged file count.",
      row: 1,
      order: 1,
      align: "left",
      render: () => widgetText,
    });

    widgetText = await refreshWidgetText(ctx);
    w.update(ctx, widgetText);
    interval = setInterval(async () => {
      widgetText = await refreshWidgetText(ctx);
      w?.update(ctx, widgetText);
    }, UPDATE_INTERVAL_MS);
  });

  pi.on("input", async (_event, ctx) => {
    widgetText = await refreshWidgetText(ctx);
    w?.update(ctx, widgetText);
    return { action: "continue" };
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    widgetText = await refreshWidgetText(ctx);
    w?.update(ctx, widgetText);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (interval) {
      clearInterval(interval);
      interval = undefined;
    }
    w?.remove(ctx);
  });
}
