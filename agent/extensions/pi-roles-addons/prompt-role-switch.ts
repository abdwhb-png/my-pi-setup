/**
 * prompt-role-switch — Auto-switch role when a prompt with `role:` frontmatter is invoked.
 *
 * This extension listens on the `input` event (fires BEFORE template expansion)
 * and detects `/prompt-name args` slash-command invocations. When the matched
 * prompt file has a `role:` field in its YAML frontmatter, it writes a
 * `pi-roles:switch-request` entry — pi-roles consumes it and applies the role.
 *
 * Pi's prompt resolution order (global first — Pi's expandPromptTemplate
 * returns the FIRST match, so global wins on name collision):
 *   1. ~/.pi/agent/prompts/<name>.md (global)
 *   2. cwd/.pi/prompts/<name>.md (project)
 *   3. Explicit `prompts` paths from settings.json (global + project)
 *
 * Settings scanning: We read the `prompts` array from both global and project
 * settings.json files, since Pi itself loads prompt templates from those paths
 * via loadPromptTemplates(). Without this, prompts configured via the
 * `prompts` setting are found by Pi but invisible to this extension.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { writeRoleSwitchRequest } from "../_shared/pi-roles";


// ── Constants ──

/** Regex to extract the prompt name from a slash-command input. */
const SLASH_COMMAND_RE = /^\s*\/([a-zA-Z0-9_-]+)/;

/** Supported prompt file extensions, tried in order. */
const PROMPT_EXTENSIONS = [".md", ".mdx"];

/** Settings file name. */
const SETTINGS_FILE = "settings.json";


// ── Pure helpers (exported for tests) ──


/**
 * Read the `prompts` array from settings.json files (global + project).
 *
 * Scans in order:
 *   1. agentDir/settings.json   (global, ~/.pi/agent/settings.json)
 *   2. cwd/.pi/settings.json    (project)
 *
 * Malformed or missing files are silently skipped.
 * Returns paths in the order they should be scanned (global first).
 */
export function loadPromptPathsFromSettings(
  agentDir: string,
  cwd: string,
): string[] {
  const paths: string[] = [];

  for (const settingsPath of [
    join(agentDir, SETTINGS_FILE),
    resolve(cwd, ".pi", SETTINGS_FILE),
  ]) {
    try {
      if (!existsSync(settingsPath)) continue;
      const raw = readFileSync(settingsPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (Array.isArray(parsed.prompts)) {
        for (const p of parsed.prompts) {
          if (typeof p === "string" && p.trim()) {
            paths.push(p.trim());
          }
        }
      }
    } catch {
      // Malformed or missing file — skip silently
    }
  }

  return paths;
}


/**
 * Resolve a prompt file by name. Scans Pi's prompt directories in the same
 * order Pi uses (global first — Pi's `expandPromptTemplate` returns the
 * first match, so global wins on collision). Returns the absolute path or
 * null if no matching file is found.
 *
 * Dirs scanned (in order):
 *   1. agentDir/prompts/              (global, ~/.pi/agent/prompts/)
 *   2. cwd/.pi/prompts/               (project)
 *   3. additionalPaths (optional)      (from `prompts` setting — files or dirs)
 */
export function resolvePromptFile(
  name: string,
  cwd: string,
  agentDir: string,
  additionalPaths?: string[],
): string | null {
  // 1 & 2: Standard directories
  const candidates = [
    join(agentDir, "prompts"),
    resolve(cwd, ".pi", "prompts"),
  ];

  for (const dir of candidates) {
    for (const ext of PROMPT_EXTENSIONS) {
      const path = join(dir, `${name}${ext}`);
      if (existsSync(path)) return path;
    }
  }

  // 3: Additional paths from settings (prompts array)
  if (additionalPaths) {
    for (const entry of additionalPaths) {
      try {
        const stats = statSync(entry);
        if (stats.isDirectory()) {
          for (const ext of PROMPT_EXTENSIONS) {
            const path = join(entry, `${name}${ext}`);
            if (existsSync(path)) return path;
          }
        } else if (stats.isFile()) {
          const base = basename(entry);
          const baseWithoutExt = extname(base)
            ? base.slice(0, -extname(base).length)
            : base;
          if (baseWithoutExt === name) return entry;
        }
      } catch {
        // Unreadable or missing — skip
      }
    }
  }

  return null;
}


// ── Extension entry point ──

export default function promptRoleSwitch(pi: ExtensionAPI): void {
  const agentDir = join(homedir(), ".pi", "agent");

  pi.on("input", async (event, ctx) => {
    const m = (event.text ?? "").match(SLASH_COMMAND_RE);
    if (!m) return;

    const name = m[1];

    // Load settings-based prompt paths so prompts configured via the
    // `prompts` array in settings.json are discoverable — same paths
    // Pi's own loadPromptTemplates already scans.
    const settingsPaths = loadPromptPathsFromSettings(agentDir, ctx.cwd);
    const file = resolvePromptFile(name, ctx.cwd, agentDir, settingsPaths);
    if (!file) return;

    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      return;
    }

    let frontmatter: Record<string, unknown>;
    try {
      ({ frontmatter } = parseFrontmatter<Record<string, unknown>>(content));
    } catch {
      return;
    }

    const role = frontmatter?.role;
    if (typeof role !== "string" || !role.trim()) return;

    writeRoleSwitchRequest(pi, {
      targetRole: role.trim(),
      reason: `prompt:${name}`,
    });

  });
}
