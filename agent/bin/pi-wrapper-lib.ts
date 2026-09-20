import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { getDefaultAgentDir, repairConfiguredPiPackages } from "../extensions/_shared/package-install/finalizer.ts";
import {
  isToolGroupsEntry,
  pinToolGroupsPackageLast,
  TOOL_GROUPS_PACKAGE_SOURCE,
} from "../extensions/_shared/tool-groups/package-order.ts";
import { TOOL_GROUPS_REQUESTED_TOOLS_ENV } from "../extensions/_shared/tool-groups/types.ts";

export interface PreparedToolGroupArgs {
  args: string[];
  requestedTools?: string[];
}

export function resolveRealPiPath(realPi = process.env.PI_REAL_BIN, homeDir = homedir()): string {
  return resolve(
    realPi?.trim() || join(homeDir, "projects", "pi-core", "packages", "coding-agent", "dist", "pi"),
  );
}

const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT =
  "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";

/**
 * Locate the Pi package that owns a launcher, including the compiled
 * `dist/pi` binary used by the local wrapper. Child sessions must load this
 * host package rather than a package-local development fixture.
 */
export function findPiPackageRootFromExecutable(executable: string): string | undefined {
  let directory = dirname(resolve(executable));
  while (directory !== dirname(directory)) {
    const manifestPath = join(directory, "package.json");
    try {
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
          name?: unknown;
        };
        if (manifest.name === PI_CODING_AGENT_PACKAGE) return directory;
      }
    } catch {
      // A malformed adjacent manifest is not a Pi package. Keep walking.
    }
    directory = dirname(directory);
  }
  return undefined;
}

function parseToolList(value: string): string[] {
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

export function prepareToolGroupArgs(args: string[], toolGroupsAvailable = true): PreparedToolGroupArgs {
  if (!toolGroupsAvailable || args.includes("--no-extensions")) {
    return { args, requestedTools: undefined };
  }

  const toolOptions: Array<{ start: number; end: number; tools: string[] }> = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--tools" || arg === "-t") {
      const value = args[index + 1];
      if (value !== undefined) {
        toolOptions.push({ start: index, end: index + 1, tools: parseToolList(value) });
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--tools=") || arg.startsWith("-t=")) {
      toolOptions.push({ start: index, end: index, tools: parseToolList(arg.slice(arg.indexOf("=") + 1)) });
    }
  }

  const hasAlias = toolOptions.some(({ tools }) => tools.some((name) => name.startsWith("@")));
  const requestedTools = toolOptions.length ? [...new Set(toolOptions.flatMap(({ tools }) => tools))] : undefined;
  if (!hasAlias) {
    return { args, requestedTools };
  }

  const removedIndexes = new Set(toolOptions.flatMap(({ start, end }) => [start, end]));
  return {
    args: args.filter((_, index) => !removedIndexes.has(index)),
    requestedTools,
  };
}

export function isToolGroupsPackageConfigured(cwd: string, agentDir = getDefaultAgentDir()): boolean {
  try {
    return SettingsManager.create(cwd, agentDir)
      .getPackages()
      .some((entry) => isToolGroupsEntry(entry, agentDir));
  } catch {
    return false;
  }
}

export function isPackageMutationCommand(args: string[]): boolean {
  const command = args[0];
  return command === "install" || command === "remove" || command === "uninstall" || command === "update";
}

export async function runPackageFinalizer(cwd: string, options?: { force?: boolean; quiet?: boolean; agentDir?: string }) {
  const agentDir = options?.agentDir ?? getDefaultAgentDir();
  const quiet = options?.quiet ?? false;

  // Pin tool-groups package to last position before repairing packages.
  const pinResult = await pinToolGroupsPackageLast(cwd, agentDir);
  if (pinResult.changed && !quiet) {
    console.log(`[package-finalizer] Pinned ${TOOL_GROUPS_PACKAGE_SOURCE} to last position.`);
  }

  await repairConfiguredPiPackages({
    cwd,
    agentDir,
    force: options?.force ?? false,
    logger: {
      info(message: string) {
        if (!quiet) console.log(message);
      },
      warn(message: string) {
        console.warn(message);
      },
    },
  });
}

export function runRealPi(realPiPath: string, args: string[], cwd: string, requestedTools?: string[]): number {
  const env: NodeJS.ProcessEnv = { ...process.env, PI_PACKAGE_FINALIZER_ACTIVE: "1" };
  const hostPackageRoot = findPiPackageRootFromExecutable(realPiPath);
  if (hostPackageRoot) {
    env[PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT] = hostPackageRoot;
  }
  delete env[TOOL_GROUPS_REQUESTED_TOOLS_ENV];
  if (requestedTools !== undefined) {
    env[TOOL_GROUPS_REQUESTED_TOOLS_ENV] = JSON.stringify(requestedTools);
  }

  const result = spawnSync(realPiPath, args, {
    cwd,
    stdio: "inherit",
    env,
  });
  if (typeof result.status === "number") return result.status;
  return 1;
}
