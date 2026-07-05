/**
 * Clean stale session names set by old pi-roles versions.
 *
 * Old pi-roles called `setSessionName(roleName)` which wrote a
 * `session_info` entry with just the role name (e.g. "architect").
 * This prevents Pi's automatic descriptive naming from working on
 * --resume.
 *
 * This script finds and removes any `session_info` entry whose name
 * is just a single lowercase word (the telltale signature of a
 * pi-roles-generated name). After removal, Pi will regenerate the
 * name from conversation content.
 *
 * Usage:
 *   bun run scripts/clean-stale-session-names.ts        # dry-run (default)
 *   bun run scripts/clean-stale-session-names.ts --force # actually remove
 */

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from "fs";
import { join, relative } from "path";

const SESSIONS_DIR = join(process.env.HOME!, ".pi", "agent", "sessions");

function isStaleRoleName(name: string): boolean {
  // Pi auto-names look like: "pi-agent - ~/.pi/agent (Jun 12 11:50)"
  // Pi-roles names look like: "architect", "pi-agent", "planner"
  // Pi-roles names are single words: lowercase + hyphens only
  return /^[a-z][a-z0-9-]*$/.test(name);
}

/**
 * Scan a session file for stale entries. When `dryRun` is true only reports
 * what would be removed; when false actually rewrites the file.
 */
function cleanSessionFile(
  filePath: string,
  dryRun: boolean,
): { linesRemoved: number; namesRemoved: string[] } {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const keptLines: string[] = [];
  const namesRemoved: string[] = [];

  for (const line of lines) {
    if (!line.trim()) { keptLines.push(line); continue; }
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === "session_info" && parsed?.name && isStaleRoleName(parsed.name)) {
        namesRemoved.push(parsed.name);
        continue;
      }
    } catch { /* keep malformed lines */ }
    keptLines.push(line);
  }

  if (!dryRun && namesRemoved.length > 0) {
    writeFileSync(filePath, keptLines.join("\n"), "utf-8");
  }

  return { linesRemoved: namesRemoved.length, namesRemoved };
}

function* walkSessionFiles(): Generator<string> {
  for (const entry of readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dirPath = join(SESSIONS_DIR, entry.name);
    for (const file of readdirSync(dirPath)) {
      const fullPath = join(dirPath, file);
      if (file.endsWith(".jsonl") && statSync(fullPath).isFile()) yield fullPath;
    }
  }
}

function usage(): void {
  console.log(`Usage: bun run scripts/clean-stale-session-names.ts [--force]

Dry-run (default):  lists stale entries without modifying files.
  --force           actually removes the stale session_info entries.

Scans: ${SESSIONS_DIR}`);
}

function main(): void {
  const args = process.argv.slice(2);
  const isForce = args.includes("--force");

  if (args.length > 0 && !isForce) {
    usage();
    process.exit(1);
  }

  if (!existsSync(SESSIONS_DIR)) {
    console.error(`Not found: ${SESSIONS_DIR}`);
    process.exit(1);
  }

  let total = 0;
  let files = 0;

  for (const fp of walkSessionFiles()) {
    const r = cleanSessionFile(fp, !isForce);
    if (r.linesRemoved > 0) {
      const label = isForce ? "removed" : "would remove";
      console.log(`  ${relative(SESSIONS_DIR, fp)} → ${label}: ${r.namesRemoved.join(", ")}`);
      total += r.linesRemoved;
      files++;
    }
  }

  if (files === 0) {
    console.log("No stale session names found. All clean!");
    return;
  }

  const verb = isForce ? "Cleaned" : "Would clean";
  console.log(`\n${verb} ${total} stale session_info entr${total === 1 ? "y" : "ies"} in ${files} file${files === 1 ? "" : "s"}.`);

  if (!isForce) {
    console.log("\nRun with --force to apply changes.");
  }
}

main();