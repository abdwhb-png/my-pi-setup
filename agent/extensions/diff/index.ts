import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getStringPath,
  toAbsolute,
  toRelative,
  getGitChangedFiles,
  difference,
} from "./core.ts";

const commandName = "diff";

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
    description: "Show files changed by the last agent run and open one in Zed",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      const arg = args.trim();
      if (arg === "clear") {
        changedFiles = new Set();
        toolTouchedFiles = new Set();
        gitBaseline = await getGitChangedFiles(
          (cmd, args, opts) => pi.exec(cmd, args, opts),
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
          `Unknown /${commandName} argument: ${arg}. Try /${commandName}, /${commandName} list, or /${commandName} clear.`,
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