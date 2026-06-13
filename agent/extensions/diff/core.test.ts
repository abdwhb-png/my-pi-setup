/**
 * Tests for the extracted diff-core helpers.
 *
 * All tests are self-contained — no git, no filesystem, no pi API.
 * Dependencies (exec) are injected as function arguments.
 */

import { describe, it, expect } from "bun:test";
import {
  getStringPath,
  toAbsolute,
  toRelative,
  parseGitStatus,
  difference,
  getGitChangedFiles,
} from "./core.ts";
import type { ExecFunction } from "./core.ts";

// ===========================================================================
// getStringPath
// ===========================================================================
describe("getStringPath", () => {
  it("returns path from object with string path", () => {
    expect(getStringPath({ path: "/foo/bar.ts" })).toBe("/foo/bar.ts");
  });

  it("returns path from edit tool input", () => {
    const input = { filePath: "/src/main.ts", path: "/src/main.ts", content: "x" };
    expect(getStringPath(input)).toBe("/src/main.ts");
  });

  it("returns undefined for null", () => {
    expect(getStringPath(null)).toBeUndefined();
  });

  it("returns undefined for non-object", () => {
    expect(getStringPath("hello")).toBeUndefined();
  });

  it("returns undefined for object without path", () => {
    expect(getStringPath({ foo: "bar" })).toBeUndefined();
  });

  it("returns undefined when path is not a string", () => {
    expect(getStringPath({ path: 42 })).toBeUndefined();
  });
});

// ===========================================================================
// toAbsolute / toRelative
// ===========================================================================
describe("toAbsolute", () => {
  it("resolves relative path", () => {
    expect(toAbsolute("/root", "src/file.ts")).toBe("/root/src/file.ts");
  });

  it("normalizes absolute path", () => {
    expect(toAbsolute("/root", "/root//src/file.ts")).toBe("/root/src/file.ts");
  });

  it("keeps already-absolute path", () => {
    expect(toAbsolute("/root", "/other/src/file.ts")).toBe("/other/src/file.ts");
  });
});

describe("toRelative", () => {
  it("returns relative path when inside cwd", () => {
    expect(toRelative("/root", "/root/src/file.ts")).toBe("src/file.ts");
  });

  it("returns absolute path when outside cwd", () => {
    expect(toRelative("/root", "/other/src/file.ts")).toBe("/other/src/file.ts");
  });

  it("returns path as-is when already relative", () => {
    expect(toRelative("/root", "src/file.ts")).toBe("src/file.ts");
  });
});

// ===========================================================================
// parseGitStatus
// ===========================================================================
describe("parseGitStatus", () => {
  it("parses modified tracked file", () => {
    const result = parseGitStatus(" M src/main.ts\n", "/root");
    expect(result).toEqual(new Set(["/root/src/main.ts"]));
  });

  it("parses untracked file", () => {
    const result = parseGitStatus("?? new/file.ts\n", "/root");
    expect(result).toEqual(new Set(["/root/new/file.ts"]));
  });

  it("parses staged modification", () => {
    const result = parseGitStatus("M  src/staged.ts\n", "/root");
    expect(result).toEqual(new Set(["/root/src/staged.ts"]));
  });

  it("parses renamed file (old -> new)", () => {
    const result = parseGitStatus("R  old.ts -> new.ts\n", "/root");
    expect(result).toEqual(new Set(["/root/new.ts"]));
  });

  it("parses copied file (old -> new)", () => {
    const result = parseGitStatus("C  old.ts -> copy.ts\n", "/root");
    expect(result).toEqual(new Set(["/root/copy.ts"]));
  });

  it("handles quoted paths", () => {
    const result = parseGitStatus(' M "file with spaces.ts"\n', "/root");
    expect(result).toEqual(new Set(["/root/file with spaces.ts"]));
  });

  it("skips short lines", () => {
    const result = parseGitStatus("ab\n", "/root");
    expect(result).toEqual(new Set());
  });

  it("skips empty lines", () => {
    const result = parseGitStatus("\n\n", "/root");
    expect(result).toEqual(new Set());
  });

  it("parses multiple files", () => {
    const output = " M src/a.ts\n?? src/b.ts\n M src/c.ts\n";
    const result = parseGitStatus(output, "/root");
    expect(result).toEqual(new Set(["/root/src/a.ts", "/root/src/b.ts", "/root/src/c.ts"]));
  });

  it("handles both-staged modified (two M columns)", () => {
    const result = parseGitStatus("MM src/modified-staged-and-working.ts\n", "/root");
    expect(result).toEqual(new Set(["/root/src/modified-staged-and-working.ts"]));
  });
});

// ===========================================================================
// difference
// ===========================================================================
describe("difference", () => {
  it("returns set difference", () => {
    const current = new Set<string>(["/a", "/b", "/c"]);
    const baseline = new Set<string>(["/b"]);
    expect(difference(current, baseline)).toEqual(new Set<string>(["/a", "/c"]));
  });

  it("returns empty set when all items are in baseline", () => {
    const current = new Set<string>(["/a", "/b"]);
    const baseline = new Set<string>(["/a", "/b", "/c"]);
    expect(difference(current, baseline)).toEqual(new Set<string>());
  });

  it("returns all items when baseline is empty", () => {
    const current = new Set<string>(["/a", "/b"]);
    const baseline = new Set<string>();
    expect(difference(current, baseline)).toEqual(new Set<string>(["/a", "/b"]));
  });

  it("returns empty set when both sets are empty", () => {
    expect(difference(new Set<string>(), new Set<string>())).toEqual(new Set<string>());
  });

  it("does not mutate original sets", () => {
    const current = new Set(["/a"]);
    const baseline = new Set(["/b"]);
    difference(current, baseline);
    expect(current).toEqual(new Set(["/a"]));
    expect(baseline).toEqual(new Set(["/b"]));
  });
});

// ===========================================================================
// getGitChangedFiles
// ===========================================================================
describe("getGitChangedFiles", () => {
  it("returns changed files on success", async () => {
    const exec: ExecFunction = async () => ({
      stdout: " M src/main.ts\n?? new.ts\n",
      stderr: "",
      code: 0,
    });
    const result = await getGitChangedFiles(exec, "/root");
    expect(result).toEqual(new Set(["/root/src/main.ts", "/root/new.ts"]));
  });

  it("returns empty set on git error", async () => {
    const exec: ExecFunction = async () => ({
      stdout: "",
      stderr: "fatal: not a git repository",
      code: 128,
    });
    const result = await getGitChangedFiles(exec, "/root");
    expect(result).toEqual(new Set());
  });
});