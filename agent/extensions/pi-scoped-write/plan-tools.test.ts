/**
 * Tests for the scoped write_plan / edit_plan adapters.
 *
 * Tests pure helpers in isolation. Tool registration + role integration
 * tested via integration smoke tests.
 */

import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolvePlanPath,
  writePlan,
  editPlan,
} from "./plan-tools";


// ── resolvePlanPath ──

describe("resolvePlanPath", () => {
  const cwd = "/home/user/project";
  const planDir = "pi-plans";

  it("resolves relative path inside plan dir", () => {
    const result = resolvePlanPath("my-plan.md", cwd, planDir);
    expect(result.error).toBeNull();
    expect(result.resolved).toBe(resolve(cwd, planDir, "my-plan.md"));
  });

  it("resolves relative path with subdirectory", () => {
    const result = resolvePlanPath("features/auth.md", cwd, planDir);
    expect(result.error).toBeNull();
    expect(result.resolved).toBe(resolve(cwd, planDir, "features/auth.md"));
  });

  it("rejects path with .. traversal", () => {
    const result = resolvePlanPath("../outside.md", cwd, planDir);
    expect(result.error).toContain("must be inside");
    expect(result.resolved).toBeNull();
  });

  it("rejects path with .. in middle", () => {
    const result = resolvePlanPath("plans/../../etc.md", cwd, planDir);
    expect(result.error).toContain("must be inside");
    expect(result.resolved).toBeNull();
  });

  it("accepts absolute path inside plan dir", () => {
    const absPath = resolve(cwd, planDir, "sub/my-plan.md");
    const result = resolvePlanPath(absPath, cwd, planDir);
    expect(result.error).toBeNull();
    expect(result.resolved).toBe(absPath);
  });

  it("rejects absolute path outside plan dir", () => {
    const absPath = resolve(cwd, "src/README.md");
    const result = resolvePlanPath(absPath, cwd, planDir);
    expect(result.error).toContain("must be inside");
    expect(result.resolved).toBeNull();
  });

  it("returns error when planDir is empty", () => {
    const result = resolvePlanPath("plan.md", cwd, "");
    expect(result.error).toContain("No plan directory configured");
    expect(result.resolved).toBeNull();
  });

  it("returns error when planDir is undefined", () => {
    const result = resolvePlanPath("plan.md", cwd, undefined);
    expect(result.error).toContain("No plan directory configured");
    expect(result.resolved).toBeNull();
  });

  it("rejects non-markdown extensions", () => {
    const result = resolvePlanPath("script.ts", cwd, planDir);
    expect(result.error).toContain("must be markdown");
    expect(result.resolved).toBeNull();
  });

  it("rejects files with no extension", () => {
    const result = resolvePlanPath("README", cwd, planDir);
    expect(result.error).toContain("must be markdown");
    expect(result.resolved).toBeNull();
  });

  it("rejects .json files", () => {
    const result = resolvePlanPath("config.json", cwd, planDir);
    expect(result.error).toContain("must be markdown");
    expect(result.resolved).toBeNull();
  });

  it("accepts .mdx extension", () => {
    const result = resolvePlanPath("design.mdx", cwd, planDir);
    expect(result.error).toBeNull();
    expect(result.resolved).toBe(resolve(cwd, planDir, "design.mdx"));
  });
});


// ── writePlan / editPlan (integration — uses real fs in temp dir) ──

describe("writePlan + editPlan", () => {
  let testDir: string;
  let planDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `plan-tools-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    planDir = join(testDir, "pi-plans");
    mkdirSync(planDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

    describe("writePlan", () => {
    it("writes content to a relative path inside plan dir", () => {
      const result = writePlan("my-plan.md", testDir, "pi-plans", "# Hello Plan");
      expect(result.error).toBeNull();
      expect(result.message).toContain("Successfully wrote");
      expect(result.message).toContain("my-plan.md");
      const written = readFileSync(join(planDir, "my-plan.md"), "utf-8");
      expect(written).toBe("# Hello Plan");
    });

        it("auto-creates parent directories", () => {
      const result = writePlan("deep/nested/plan.md", testDir, "pi-plans", "content");
      expect(result.error).toBeNull();
      const written = readFileSync(join(planDir, "deep/nested/plan.md"), "utf-8");
      expect(written).toBe("content");
        });

        it("writes through an absolute path that is inside the plan directory", () => {
            const absolutePath = join(planDir, "absolute.md");

            const result = writePlan(absolutePath, testDir, "pi-plans", "# Absolute");

            expect(result.error).toBeNull();
            expect(readFileSync(absolutePath, "utf-8")).toBe("# Absolute");
        });

        it("records an audited scoped-write event when creating a plan", () => {
            const result = writePlan(
                "audited.md",
                testDir,
                "pi-plans",
                "# Audited",
                { agent: "plan", role: "plan", runId: "session-1" },
            );

            expect(result.error).toBeNull();
            const audit = readFileSync(
                join(testDir, ".pi", "artifacts", ".audit", "session-1.jsonl"),
                "utf-8",
            );
            expect(JSON.parse(audit)).toMatchObject({
                tool: "write_plan",
                operation: "create",
                path: "pi-plans/audited.md",
                agent: "plan",
            });
        });

    it("rejects path outside plan dir", () => {
      const result = writePlan("../outside.md", testDir, "pi-plans", "x");
      expect(result.error).toContain("must be inside");
      expect(existsSync(join(testDir, "outside.md"))).toBeFalse();
    });

    it("returns error when no plan dir configured", () => {
      const result = writePlan("plan.md", testDir, "", "x");
      expect(result.error).toContain("No plan directory configured");
    });
  });

  describe("editPlan", () => {
    it("edits a file with unique oldText match", () => {
      const planPath = join(planDir, "edit-test.md");
      writeFileSync(planPath, "Line 1\nLine 2\nLine 3", "utf-8");

      const result = editPlan("edit-test.md", testDir, "pi-plans", [
        { oldText: "Line 2", newText: "Line 2 EDITED" },
      ]);

      expect(result.error).toBeNull();
      expect(result.message).toContain("Successfully replaced 1 block");
      const updated = readFileSync(planPath, "utf-8");
      expect(updated).toBe("Line 1\nLine 2 EDITED\nLine 3");
    });

    it("rejects when oldText not found", () => {
      const planPath = join(planDir, "missing-test.md");
      writeFileSync(planPath, "only one line", "utf-8");

      const result = editPlan("missing-test.md", testDir, "pi-plans", [
        { oldText: "not in file", newText: "x" },
      ]);

      expect(result.error).toContain("Could not find match");
    });

    it("rejects when oldText is not unique", () => {
      const planPath = join(planDir, "dup-test.md");
      writeFileSync(planPath, "foo\nbar\nfoo", "utf-8");

      const result = editPlan("dup-test.md", testDir, "pi-plans", [
        { oldText: "foo", newText: "replaced" },
      ]);

      expect(result.error).toContain("matches 2 locations");
    });

    it("handles multiple edits", () => {
      const planPath = join(planDir, "multi-edit.md");
      writeFileSync(planPath, "A\nB\nC", "utf-8");

      const result = editPlan("multi-edit.md", testDir, "pi-plans", [
        { oldText: "A", newText: "Alpha" },
        { oldText: "C", newText: "Charlie" },
      ]);

      expect(result.error).toBeNull();
      expect(result.message).toContain("Successfully replaced 2 block");
      const updated = readFileSync(planPath, "utf-8");
      expect(updated).toBe("Alpha\nB\nCharlie");
    });

    it("rejects when file does not exist", () => {
      const result = editPlan("nonexistent.md", testDir, "pi-plans", [
        { oldText: "x", newText: "y" },
      ]);

      expect(result.error).toContain("File not found");
    });

    it("rejects path outside plan dir", () => {
      const result = editPlan("../outside.md", testDir, "pi-plans", [
        { oldText: "x", newText: "y" },
      ]);

      expect(result.error).toContain("must be inside");
    });
  });
});
