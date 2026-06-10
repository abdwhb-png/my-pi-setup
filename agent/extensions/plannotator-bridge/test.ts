/**
 * Tests for plannotator-bridge extension core logic.
 *
 * Self-contained tests for pure helper functions.
 * Functions are copied here to avoid jiti import issues in vitest.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

// ── Pure helper functions (copied for standalone testing) ──
// These are the same as in index.ts - see vitest skill: copying is OK when imports fail due to jiti

function validatePlanPath(inputPath: string, cwd: string): string | null {
  if (!inputPath || !inputPath.trim()) {
    return "Path is required";
  }

  const resolved = path.resolve(cwd, inputPath.trim());
  const rel = path.relative(path.resolve(cwd), resolved);

  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return `Path must be inside the working directory: ${inputPath}`;
  }

  const ext = path.extname(resolved).toLowerCase();
  if (ext !== ".md" && ext !== ".mdx") {
    return `Plan file must be a markdown file (.md or .mdx), got: ${ext}`;
  }

  try {
    if (!fs.statSync(resolved).isFile()) {
      return `Not a regular file: ${inputPath}`;
    }
  } catch {
    return `File not found: ${inputPath}`;
  }

  return null;
}

function validateAnnotatePath(inputPath: string, cwd: string): string | null {
  if (!inputPath || !inputPath.trim()) {
    return "Path is required";
  }

  const resolved = path.resolve(cwd, inputPath.trim());
  const rel = path.relative(path.resolve(cwd), resolved);

  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return `Path must be inside the working directory: ${inputPath}`;
  }

  try {
    if (!fs.statSync(resolved).isFile()) {
      return `Not a regular file: ${inputPath}`;
    }
  } catch {
    return `File not found: ${inputPath}`;
  }

  return null;
}

function readPlanFile(inputPath: string, cwd: string): { ok: true; content: string } | { ok: false; error: string } {
  const validationError = validatePlanPath(inputPath, cwd);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  const resolved = path.resolve(cwd, inputPath.trim());

  try {
    const content = fs.readFileSync(resolved, "utf-8");
    if (!content.trim()) {
      return { ok: false, error: `Plan file is empty: ${inputPath}` };
    }
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function formatReviewResult(decision: { approved: boolean; feedback?: string }): string {
  if (decision.approved) {
    const notes = decision.feedback ? `\n\n**Reviewer notes:**\n${decision.feedback}` : "";
    return `## Plan Approved ✓${notes}\n\nProceed with execution. Mark completed steps with [DONE:n].`;
  }

  const feedback = decision.feedback || "No specific feedback provided.";
  return `## Plan Requires Revision\n\n**Feedback:**\n${feedback}\n\nEdit the plan file and re-submit via plan_submit.`;
}

function formatAnnotationResult(result: { feedback?: string; exit?: boolean; approved?: boolean }): string {
  if (result.approved) {
    return "## Annotation Approved ✓";
  }
  if (result.exit) {
    return "## Annotation Closed\n\nThe annotation session was closed without feedback.";
  }
  if (result.feedback) {
    return `## Annotation Feedback\n\n${result.feedback}`;
  }
  return "## Annotation Closed\n\nNo feedback was provided.";
}

// ── Tests ──

describe("validatePlanPath", () => {
  describe("rejections", () => {
    it("rejects empty path", () => {
      const result = validatePlanPath("", "/tmp");
      expect(result).not.toBeNull();
      expect(result).toContain("required");
    });

    it("rejects non-markdown extension (.txt)", () => {
      const result = validatePlanPath("plan.txt", "/tmp");
      expect(result).not.toBeNull();
      expect(result).toContain(".txt");
    });

    it("rejects path outside cwd (../outside.md)", () => {
      const result = validatePlanPath("../outside.md", "/tmp");
      expect(result).not.toBeNull();
      expect(result).toContain("working directory");
    });

    it("rejects non-existent file", () => {
      const result = validatePlanPath("nonexistent.md", "/tmp");
      expect(result).not.toBeNull();
      expect(result).toContain("not found");
    });
  });

  describe("accepts valid paths", () => {
    let testMd: string;
    let testMdx: string;

    beforeAll(() => {
      testMd = path.join("/tmp", `test-plan-${Date.now()}.md`);
      fs.writeFileSync(testMd, "# Test Plan");
      
      testMdx = path.join("/tmp", `test-plan-${Date.now()}.mdx`);
      fs.writeFileSync(testMdx, "# Test Plan");
    });

    afterAll(() => {
      fs.unlinkSync(testMd);
      fs.unlinkSync(testMdx);
    });

    it("accepts valid .md file", () => {
      const result = validatePlanPath(path.basename(testMd), "/tmp");
      expect(result).toBeNull();
    });

    it("accepts valid .mdx file", () => {
      const result = validatePlanPath(path.basename(testMdx), "/tmp");
      expect(result).toBeNull();
    });
  });
});

describe("validateAnnotatePath", () => {
  describe("rejections", () => {
    it("rejects empty path", () => {
      const result = validateAnnotatePath("", "/tmp");
      expect(result).not.toBeNull();
      expect(result).toContain("required");
    });

    it("rejects path outside cwd (../outside.ts)", () => {
      const result = validateAnnotatePath("../outside.ts", "/tmp");
      expect(result).not.toBeNull();
      expect(result).toContain("working directory");
    });

    it("rejects non-existent file", () => {
      const result = validateAnnotatePath("nonexistent.ts", "/tmp");
      expect(result).not.toBeNull();
      expect(result).toContain("not found");
    });
  });

  describe("accepts valid paths", () => {
    let testFile: string;

    beforeAll(() => {
      testFile = path.join("/tmp", `test-annotate-${Date.now()}.ts`);
      fs.writeFileSync(testFile, "const x = 1;");
    });

    afterAll(() => {
      fs.unlinkSync(testFile);
    });

    it("accepts any file type (.ts)", () => {
      const result = validateAnnotatePath(path.basename(testFile), "/tmp");
      expect(result).toBeNull();
    });
  });
});

describe("readPlanFile", () => {
  describe("success cases", () => {
    let testMd: string;
    const testContent = "# My Plan\n\n1. Step one\n2. Step two";

    beforeAll(() => {
      testMd = path.join("/tmp", `test-plan-${Date.now()}.md`);
      fs.writeFileSync(testMd, testContent);
    });

    afterAll(() => {
      fs.unlinkSync(testMd);
    });

    it("reads valid .md file content", () => {
      const result = readPlanFile(path.basename(testMd), "/tmp");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).toBe(testContent);
      }
    });
  });

  describe("error cases", () => {
    it("errors on non-existent file", () => {
      const result = readPlanFile("nonexistent-plan.md", "/tmp");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("not found");
      }
    });

    it("errors on empty file", () => {
      const emptyMd = path.join("/tmp", `test-empty-${Date.now()}.md`);
      fs.writeFileSync(emptyMd, "");
      const result = readPlanFile(path.basename(emptyMd), "/tmp");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("empty");
      }
      fs.unlinkSync(emptyMd);
    });

    it("errors on non-markdown file (.txt)", () => {
      const result = readPlanFile("plan.txt", "/tmp");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(".txt");
      }
    });
  });
});

describe("formatReviewResult", () => {
  it("formats approved result without feedback", () => {
    const result = formatReviewResult({ approved: true });
    expect(result).toContain("Approved");
    expect(result).toContain("[DONE:n]");
  });

  it("formats denied result with feedback", () => {
    const result = formatReviewResult({ approved: false, feedback: "Missing test cases" });
    expect(result).toContain("Revision");
    expect(result).toContain("Missing test cases");
  });

  it("formats approved result with notes", () => {
    const result = formatReviewResult({ approved: true, feedback: "Consider adding error handling" });
    expect(result).toContain("Approved");
    expect(result).toContain("Consider adding");
  });
});

describe("formatAnnotationResult", () => {
  it("formats approved annotation", () => {
    const result = formatAnnotationResult({ approved: true });
    expect(result).toContain("Approved");
  });

  it("formats closed annotation without feedback", () => {
    const result = formatAnnotationResult({ exit: true });
    expect(result).toContain("Closed");
    expect(result).toContain("without feedback");
  });

  it("formats annotation feedback", () => {
    const result = formatAnnotationResult({ feedback: "Add docstring" });
    expect(result).toContain("Feedback");
    expect(result).toContain("Add docstring");
  });
});