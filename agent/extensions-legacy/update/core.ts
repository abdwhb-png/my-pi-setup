/**
 * Pure helpers for the update extension.
 *
 * All functions are either pure or take their dependencies as arguments,
 * making them fully testable without mocking Node internals or the pi API.
 */

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

export const PACKAGE_NAME = "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InstallMethod = "vp" | "bun" | "npm" | "brew" | "native";

export type CommandSpec = {
  command: string;
  args: string[];
  label: string;
};

export type ExecResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export type ExecFunction = (
  command: string,
  args: string[],
  options: { timeout: number },
) => Promise<ExecResult>;

export type ResolveFunction = (command: string) => Promise<string | undefined>;
export type RealpathFunction = (path: string) => Promise<string>;
export type ExistsFunction = (path: string) => Promise<boolean>;

export type RetryResult = {
  ok: boolean;
  output: string;
  attempts: number;
};

// ---------------------------------------------------------------------------
// Transient-error classification
// ---------------------------------------------------------------------------

export const TRANSIENT_PATTERNS = [
  /eai_again/i,
  /etimedout/i,
  /econnreset/i,
  /econnrefused/i,
  /socket hang up/i,
  /network/i,
  /timeout/i,
  /temporar/i,
  /too many requests/i,
  /\b429\b/,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
];

/**
 * Returns true when `output` matches a transient (retryable) error pattern.
 * Pure function — no side effects.
 */
export function isTransient(output: string): boolean {
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(output));
}

// ---------------------------------------------------------------------------
// Command resolution
// ---------------------------------------------------------------------------

/**
 * Maps an InstallMethod to the CommandSpec that will perform the upgrade.
 * Returns undefined for "native" (no package manager → manual update).
 * Pure function — no side effects.
 */
export function commandFor(method: InstallMethod): CommandSpec | undefined {
  switch (method) {
    case "vp":
      return {
        command: "vp",
        args: ["add", "-g", `${PACKAGE_NAME}@latest`],
        label: `vp add -g ${PACKAGE_NAME}@latest`,
      };
    case "bun":
      return {
        command: "bun",
        args: ["add", "-g", `${PACKAGE_NAME}@latest`],
        label: `bun add -g ${PACKAGE_NAME}@latest`,
      };
    case "npm":
      return {
        command: "npm",
        args: ["install", "-g", `${PACKAGE_NAME}@latest`],
        label: `npm install -g ${PACKAGE_NAME}@latest`,
      };
    case "brew":
      return {
        command: "/bin/sh",
        args: ["-lc", "brew upgrade pi-coding-agent || brew upgrade pi"],
        label: "brew upgrade pi-coding-agent || brew upgrade pi",
      };
    case "native":
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Install-method detection
// ---------------------------------------------------------------------------

/**
 * Detects how pi was installed by examining the pi binary path,
 * its realpath (symlink-aware), and fallback to available package managers.
 *
 * Takes injected functions for filesystem access — no direct coupling to
 * fs/promises or pi.exec().
 *
 * Decision matrix:
 *   1. Symlink-aware path check for ~/.vite-plus/, ~/.bun/, /Homebrew/
 *   2. Walk up from piPath looking for node_modules/@earendil-works/pi-coding-agent
 *   3. Fallback to any available package manager binary
 *   4. If nothing matches, return "native"
 */
export async function detectInstallMethod(
  resolveCommand: ResolveFunction,
  realpathFn: RealpathFunction,
  pathExists: ExistsFunction,
): Promise<InstallMethod> {
  const piPath = await resolveCommand("pi");
  const realPiPath = piPath
    ? await realpathFn(piPath).catch(() => piPath)
    : undefined;

  // 1a. Symlink-aware path check for vp (vite-plus)
  if (
    piPath?.includes("/.vite-plus/") ||
    realPiPath?.includes("/.vite-plus/")
  )
    return "vp";

  // 1b. Symlink-aware path check for bun
  if (piPath?.includes("/.bun/") || realPiPath?.includes("/.bun/"))
    return "bun";

  // 1c. Symlink-aware path check for Homebrew
  if (
    piPath?.includes("/Homebrew/") ||
    piPath?.includes("/homebrew/") ||
    realPiPath?.includes("/Homebrew/") ||
    realPiPath?.includes("/homebrew/")
  )
    return "brew";

  // 2. Walk up from piPath looking for node_modules/<package>
  if (piPath) {
    const { dirname, resolve } = await import("node:path");
    let dir = dirname(piPath);
    for (let i = 0; i < 5; i++) {
      if (await pathExists(resolve(dir, "node_modules", PACKAGE_NAME)))
        return "npm";
      dir = dirname(dir);
    }
  }

  // 3. Fallback to any available package manager binary
  if (await resolveCommand("vp")) return "vp";
  if (await resolveCommand("bun")) return "bun";
  if (await resolveCommand("npm")) return "npm";
  if (await resolveCommand("brew")) return "brew";

  // 4. Nothing matched — native install
  return "native";
}

// ---------------------------------------------------------------------------
// Retry logic
// ---------------------------------------------------------------------------

/**
 * Runs the given CommandSpec with up to 3 attempts, retrying only on
 * transient errors (network blips, rate limits, HTTP 5xx).
 *
 * Each retry uses linear backoff: attempt * 1500ms.
 * Takes an injected exec function — no direct coupling to pi.exec().
 */
export async function runWithRetry(
  exec: ExecFunction,
  spec: CommandSpec,
): Promise<RetryResult> {
  let lastOutput = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await exec(spec.command, spec.args, { timeout: 180_000 });
    lastOutput = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    if (result.code === 0)
      return { ok: true, output: lastOutput, attempts: attempt };
    if (attempt === 3 || !isTransient(lastOutput))
      return { ok: false, output: lastOutput, attempts: attempt };
    await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
  }
  return { ok: false, output: lastOutput, attempts: 3 };
}