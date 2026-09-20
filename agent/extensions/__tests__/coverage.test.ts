import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const PORTABLE_TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|py|sh|toml|ya?ml)$/i;
const TEST_FILE = /(?:^|\.)((?:integration\.)?test|spec)\.[cm]?[jt]sx?$/i;
const LOGICAL_HOME_USERS = new Set(["linuxbrew", "sandbox"]);

function isPortableExecutable(file: string): boolean {
  if (file.startsWith("docs/audits/")) return false;
  if (TEST_FILE.test(path.basename(file))) return false;
  if (!PORTABLE_TEXT_FILE.test(file)) return false;
  return (
    file.startsWith(".github/") ||
    file.startsWith("agent/extensions/") ||
    file.startsWith("agent/scripts/") ||
    /^agent\/[^/]+$/.test(file)
  );
}

function containsPersonalHome(text: string): boolean {
  for (const match of text.matchAll(/\/home\/([a-z_][a-z0-9_-]*)/g)) {
    if (!LOGICAL_HOME_USERS.has(match[1].toLowerCase())) return true;
  }
  return false;
}

describe("Meta: portable executable files do not hardcode a personal home", () => {
  it("contains no /home/<user> path outside fixtures and historical audits", () => {
    const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
    const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
      cwd: repoRoot,
      encoding: "buffer",
    })
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .filter(isPortableExecutable);
    const offenders = trackedFiles.filter((file) => {
      const fullPath = path.join(repoRoot, file);
      if (!fs.existsSync(fullPath)) return false;
      if (!fs.statSync(fullPath).isFile()) return false;
      const content = fs.readFileSync(fullPath);
      return !content.includes(0) && containsPersonalHome(content.toString("utf8"));
    });

    expect(offenders).toEqual([]);
  });
});
