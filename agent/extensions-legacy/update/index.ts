import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { access, realpath } from "node:fs/promises";
import {
  detectInstallMethod,
  commandFor,
  runWithRetry,
} from "./core.ts";

// ---------------------------------------------------------------------------
// FS-coupled adapters (thin glue)
// ---------------------------------------------------------------------------

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommand(command: string, pi: ExtensionAPI): Promise<string | undefined> {
  const result = await pi.exec("/bin/sh", ["-lc", `command -v ${command} || true`], {
    timeout: 10_000,
  });
  return result.stdout.trim().split("\n")[0] || undefined;
}

async function currentVersion(pi: ExtensionAPI): Promise<string> {
  const result = await pi.exec("pi", ["--version"], { timeout: 10_000 });
  return result.stdout.trim() || result.stderr.trim() || "unknown";
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function updatePi(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  await ctx.waitForIdle();

  const before = await currentVersion(pi).catch(() => "unknown");
  const method = await detectInstallMethod(
    (cmd) => resolveCommand(cmd, pi),
    (path) => realpath(path),
    (path) => pathExists(path),
  );
  const spec = commandFor(method);

  if (!spec) {
    ctx.ui.notify(
      `Pi ${before}; install method appears native. Please update the native binary manually.`,
      "warning",
    );
    return;
  }

  ctx.ui.notify(`Updating Pi via ${method}: ${spec.label}`, "info");
  const result = await runWithRetry(
    (cmd, args, opts) => pi.exec(cmd, args, opts),
    spec,
  );
  const after = await currentVersion(pi).catch(() => "unknown");

  if (!result.ok) {
    ctx.ui.notify(
      `Pi update failed after ${result.attempts} attempt(s). ${result.output || "No output."}`,
      "error",
    );
    return;
  }

  const changed = before !== after && before !== "unknown" && after !== "unknown";
  const summary = changed
    ? `Pi updated: ${before} → ${after}`
    : `Pi is up to date (${after}).`;
  ctx.ui.notify(
    `${summary}${result.attempts > 1 ? ` Retried ${result.attempts - 1} transient failure(s).` : ""}`,
    "info",
  );
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerFlag("update", {
    description:
      "Update Pi using the detected install method, then report the version change",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("update", {
    description: "Update Pi using vp, bun, npm, brew, or native detection",
    handler: async (_args, ctx) => {
      await updatePi(pi, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!pi.getFlag("update")) return;
    pi.sendUserMessage("/update", { deliverAs: "followUp" });
    ctx.ui.notify("Queued /update from --update", "info");
  });
}