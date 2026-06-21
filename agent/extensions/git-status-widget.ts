import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWidget } from "./_shared/fancy-footer";

const execFileAsync = promisify(execFile);
const WIDGET_ID = "git-status-widget";
const UPDATE_INTERVAL_MS = 2_000;

let widgetText: string | null = null;

async function runGit(args: string[], cwd: string) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 2_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trimEnd();
}

async function getBranch(cwd: string) {
  const branch = await runGit(["branch", "--show-current"], cwd);
  if (branch.length > 0) return branch;

  const head = await runGit(["rev-parse", "--short", "HEAD"], cwd);
  return head.length > 0 ? `detached@${head}` : "unknown";
}

function countUnstagedFiles(statusOutput: string) {
  if (statusOutput.length === 0) return 0;

  let count = 0;
  for (const line of statusOutput.split("\n")) {
    if (line.startsWith("??") || line[1] !== " ") count += 1;
  }
  return count;
}

async function getUnstagedCount(cwd: string) {
  const status = await runGit(["status", "--porcelain", "--untracked-files=normal"], cwd);
  return countUnstagedFiles(status);
}

async function refreshWidgetText(ctx: ExtensionContext): Promise<string | null> {
  if (!ctx.hasUI) return null;

  try {
    await runGit(["rev-parse", "--is-inside-work-tree"], ctx.cwd);
    const [branch, unstagedCount] = await Promise.all([
      getBranch(ctx.cwd),
      getUnstagedCount(ctx.cwd),
    ]);

    const fileLabel = unstagedCount === 1 ? "file" : "files";
    return ` ${branch} · ${unstagedCount} unstaged ${fileLabel}`;
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
