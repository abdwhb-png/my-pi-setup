/**
 * Pure helpers for the diff extension.
 *
 * All functions are either pure or take their dependencies as arguments,
 * making them fully testable without mocking git, fs, or the pi API.
 */

import path from "node:path";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getStringPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || !("path" in input)) return undefined;
  return typeof input.path === "string" ? input.path : undefined;
}

export function toAbsolute(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(cwd, filePath);
}

export function toRelative(cwd: string, filePath: string): string {
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath;
}

// ---------------------------------------------------------------------------
// Git porcelain parsing
// ---------------------------------------------------------------------------

/**
 * Parse `git status --porcelain` output into a set of absolute file paths.
 *
 * Handles:
 * - Standard two-column status lines (e.g. ` M foo.ts`, `?? bar.ts`)
 * - Rename/copy entries with `old -> new` format (destination is what matters)
 * - Quoted paths (git uses quotes for paths with special characters)
 * - Untracked files (`--untracked-files=all`)
 */
export function parseGitStatus(output: string, cwd: string): Set<string> {
  const files = new Set<string>();

  for (const line of output.split("\n")) {
    if (line.length < 4) continue;

    // `git status --porcelain` format is two status columns, a space, then path.
    // Rename/copy entries look like `old -> new`; the destination is what we want to open.
    const rawPath = line.slice(3).trim();
    if (!rawPath) continue;

    const targetPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) : rawPath;
    if (!targetPath) continue;

    files.add(toAbsolute(cwd, targetPath.replace(/^"|"$/g, "")));
  }

  return files;
}

// ---------------------------------------------------------------------------
// Set helpers
// ---------------------------------------------------------------------------

export function difference(current: Set<string>, baseline: Set<string>): Set<string> {
  return new Set([...current].filter((file) => !baseline.has(file)));
}

// ---------------------------------------------------------------------------
// Git integration (accepts pi.exec as dependency)
// ---------------------------------------------------------------------------

export type ExecFunction = (command: string, args: string[], options: { cwd: string; timeout: number }) => Promise<{ stdout: string; stderr: string; code: number }>;

export async function getGitChangedFiles(
  exec: ExecFunction,
  cwd: string,
): Promise<Set<string>> {
  const result = await exec("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd,
    timeout: 5000,
  });

  if (result.code !== 0) return new Set<string>();
  return parseGitStatus(result.stdout, cwd);
}