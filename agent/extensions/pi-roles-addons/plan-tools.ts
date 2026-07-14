/**
 * plan-tools — plan directory-guarded write_plan / edit_plan tools.
 *
 * Pure helpers exported for testing; the extension entry point registers
 * them as Pi tools via `pi.registerTool()`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, isAbsolute, relative, dirname, extname } from "node:path";


// ── Types ──

export interface PlanPathResult {
  resolved: string | null;
  error: string | null;
}

export interface WriteResult {
  message: string;
  error: string | null;
}

export interface EditInput {
  oldText: string;
  newText: string;
}

export interface EditResult {
  message: string;
  error: string | null;
}


// ── Path resolution ──

/**
 * Resolve a raw path against the configured plan directory.
 *
 * Rules:
 * - `planDir` empty/undefined → error (no config)
 * - Path must end in .md or .mdx → reject non-plan files
 * - Path contains `..` → reject
 * - Absolute path → must start with resolved plan dir
 * - Relative path → prepend plan dir
 */
export function resolvePlanPath(
  rawPath: string,
  cwd: string,
  planDir: string | undefined,
): PlanPathResult {
  if (!planDir || !planDir.trim()) {
    return { resolved: null, error: "No plan directory configured. Set 'planFileDir' in plannotator.json." };
  }

  const trimmed = rawPath.trim();
  if (!trimmed) {
    return { resolved: null, error: "Path must not be empty." };
  }

  // Reject non-markdown extensions (plan files only)
  const ext = extname(trimmed).toLowerCase();
  if (ext !== ".md" && ext !== ".mdx") {
    return { resolved: null, error: `Plan files must be markdown (.md or .mdx). Got: ${ext || "(no extension)"}` };
  }

  // Reject .. traversals
  if (trimmed.includes("..")) {
    return { resolved: null, error: `Path must be inside the plan directory: ${trimmed}` };
  }

  const planDirResolved = resolve(cwd, planDir.trim());
  let resolvedPath: string;

  if (isAbsolute(trimmed)) {
    resolvedPath = trimmed;
  } else {
    resolvedPath = resolve(planDirResolved, trimmed);
  }

  // Verify absolute paths are inside plan dir
  const rel = relative(planDirResolved, resolvedPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { resolved: null, error: `Path must be inside the plan directory (${planDir.trim()}): ${trimmed}` };
  }

  return { resolved: resolvedPath, error: null };
}


// ── writePlan ──

/**
 * Write content to a file inside the plan directory.
 *
 * Auto-creates the plan directory and any parent directories.
 * Returns `{ message, error }` — at most one is set.
 */
export function writePlan(
  rawPath: string,
  cwd: string,
  planDir: string | undefined,
  content: string,
): WriteResult {
  const resolved = resolvePlanPath(rawPath, cwd, planDir);
  if (resolved.error) {
    return { message: "", error: resolved.error };
  }

  mkdirSync(dirname(resolved.resolved!), { recursive: true });
  writeFileSync(resolved.resolved!, content, "utf-8");

  return {
    message: `Successfully wrote ${Buffer.byteLength(content, "utf-8")} bytes to ${rawPath}`,
    error: null,
  };
}


// ── editPlan ──

/**
 * Edit a file inside the plan directory using text replacements.
 *
 * Each edit must have exactly one unique match for `oldText`.
 * Returns `{ message, error }` — at most one is set.
 */
export function editPlan(
  rawPath: string,
  cwd: string,
  planDir: string | undefined,
  edits: EditInput[],
): EditResult {
  const resolved = resolvePlanPath(rawPath, cwd, planDir);
  if (resolved.error) {
    return { message: "", error: resolved.error };
  }

  if (!existsSync(resolved.resolved!)) {
    return { message: "", error: `File not found: ${rawPath}` };
  }

  let content = readFileSync(resolved.resolved!, "utf-8");

  for (const edit of edits) {
    // Count occurrences
    let count = 0;
    let pos = 0;
    while ((pos = content.indexOf(edit.oldText, pos)) !== -1) {
      count++;
      pos += edit.oldText.length;
    }

    if (count === 0) {
      return {
        message: "",
        error: `Could not find match for oldText in ${rawPath}: "${edit.oldText.slice(0, 80)}"`,
      };
    }

    if (count > 1) {
      return {
        message: "",
        error: `oldText matches ${count} locations in ${rawPath} — must be unique: "${edit.oldText.slice(0, 80)}"`,
      };
    }

    content = content.replace(edit.oldText, edit.newText);
  }

  writeFileSync(resolved.resolved!, content, "utf-8");

  return {
    message: `Successfully replaced ${edits.length} block(s) in ${rawPath}`,
    error: null,
  };
}
