import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getStringPath,
  toAbsolute,
  toRelative,
  getGitChangedFiles,
  difference,
  which,
} from "./core.ts";

const commandName = "diff";

/**
 * Show git diff output using the best available viewer.
 *
 * Tries tuicr first, then delta, then plain git diff as fallback.
 * Each mode stops the pi TUI, runs the external viewer, then restarts.
 */
async function showGitDiff(
  ctx: any,
  gitArgs: string[],
): Promise<void> {
  if (which("tuicr")) {
    const tuicrArgs = gitArgs.length > 0 ? ["-r", gitArgs.join(" ")] : [];
    await ctx.ui.custom((tui: any, _theme: any, _kb: any, done: () => void) => {
      tui.stop();
      process.stdout.write("\x1b[2J\x1b[H");
      spawnSync("tuicr", tuicrArgs, {
        stdio: "inherit",
        cwd: ctx.cwd,
        env: process.env,
      });
      tui.start();
      tui.requestRender(true);
      done();
      return { render: () => [], invalidate: () => {} };
    });
  } else if (which("delta")) {
    const cmd = gitArgs.length > 0
      ? `git diff ${gitArgs.join(" ")} | delta --pager 'less -R'`
      : "git diff | delta --pager 'less -R'";
    await ctx.ui.custom((tui: any, _theme: any, _kb: any, done: () => void) => {
      tui.stop();
      process.stdout.write("\x1b[32m━━━ Git diff — Press \x1b[1mq\x1b[22m to exit ━━━\x1b[0m\n\n");
      spawnSync("bash", ["-c", cmd], {
        stdio: "inherit",
        cwd: ctx.cwd,
      });
      tui.start();
      tui.requestRender(true);
      done();
      return { render: () => [], invalidate: () => {} };
    });
  } else {
    await ctx.ui.custom((tui: any, _theme: any, _kb: any, done: () => void) => {
      tui.stop();
      process.stdout.write("\x1b[32m━━━ Git diff — Press \x1b[1mq\x1b[22m to exit ━━━\x1b[0m\n\n");
      spawnSync("git", ["diff", ...gitArgs], {
        stdio: "inherit",
        cwd: ctx.cwd,
      });
      tui.start();
      tui.requestRender(true);
      done();
      return { render: () => [], invalidate: () => {} };
    });
  }
}

export default function (pi: ExtensionAPI) {
  let gitBaseline = new Set<string>();
  let changedFiles = new Set<string>();
  let toolTouchedFiles = new Set<string>();

  pi.on("agent_start", async (_event, ctx) => {
    toolTouchedFiles = new Set();
    changedFiles = new Set();
    gitBaseline = await getGitChangedFiles(
      (cmd, args, opts) => pi.exec(cmd, args, opts),
      ctx.cwd,
    );
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    const filePath = getStringPath(event.input);
    if (!filePath) return;

    toolTouchedFiles.add(toAbsolute(ctx.cwd, filePath));
  });

  pi.on("agent_end", async (_event, ctx) => {
    const gitChanged = await getGitChangedFiles(
      (cmd, args, opts) => pi.exec(cmd, args, opts),
      ctx.cwd,
    );
    changedFiles = new Set([...difference(gitChanged, gitBaseline), ...toolTouchedFiles]);

    if (changedFiles.size > 0) {
      ctx.ui.notify(`${changedFiles.size} changed file(s). Run /${commandName} to view/open in Zed.`, "info");
    }
  });

  pi.registerCommand(commandName, {
    description: "View changed files from last agent run (/diff) or git diff output (/diff --git)",
    getArgumentCompletions: (prefix: string) => {
      const opts = ["--git", "--git --staged", "--git --cached", "--git HEAD~1", "--git HEAD~3..HEAD"];
      const filtered = opts.filter((o) => o.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((o) => ({ value: o, label: o, insertText: o })) : null;
    },
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      const trimmed = args.trim();

      // ── Git diff mode (/diff --git [...args]) ──────────────────────
      if (trimmed.startsWith("--git")) {
        if (!ctx.hasUI) {
          ctx.ui.notify("Git diff viewer requires interactive mode", "error");
          return;
        }
        const gitArgs = trimmed.slice(5).trim().split(/\s+/).filter(Boolean);
        await showGitDiff(ctx, gitArgs);
        return;
      }

      // ── Agent-change mode (default) ────────────────────────────────
      const arg = trimmed;

      if (arg === "clear") {
        changedFiles = new Set();
        toolTouchedFiles = new Set();
        gitBaseline = await getGitChangedFiles(
          (cmd, spawnArgs, opts) => pi.exec(cmd, spawnArgs, opts),
          ctx.cwd,
        );
        ctx.ui.notify("Cleared changed file list", "info");
        return;
      }

      const files = [...changedFiles].toSorted((a, b) =>
        toRelative(ctx.cwd, a).localeCompare(toRelative(ctx.cwd, b)),
      );
      if (files.length === 0) {
        ctx.ui.notify("No changed files tracked from the last agent run", "info");
        return;
      }

      if (arg === "list") {
        ctx.ui.notify(
          `Changed files:\n${files.map((file) => `- ${toRelative(ctx.cwd, file)}`).join("\n")}`,
          "info",
        );
        return;
      }

      if (arg) {
        ctx.ui.notify(
          `Unknown /${commandName} argument: ${arg}. Try /${commandName}, /${commandName} list, /${commandName} clear, or /${commandName} --git.`,
          "warning",
        );
        return;
      }

      const labels = files.map((file) => toRelative(ctx.cwd, file));
      const selected = await ctx.ui.select("Open changed file in Zed", labels);
      if (!selected) return;

      const selectedIndex = labels.indexOf(selected);
      const file = files[selectedIndex];
      if (!file) return;

      const result = await pi.exec("zed", ["-e", file], { cwd: ctx.cwd, timeout: 5000 });
      if (result.code === 0) {
        ctx.ui.notify(`Opened ${selected} in Zed`, "info");
      } else {
        ctx.ui.notify(result.stderr.trim() || `Failed to open ${selected} in Zed`, "error");
      }
    },
  });
}