/**
 * Tests for plannotator-bridge extension core logic.
 *
 * Self-contained: no imports from pi packages (they use jiti which isn't
 * available in standalone Node). Tests the pure helper functions directly.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const HOME = process.env.HOME || "/home/abdwhb";
const EXT_DIR = path.join(HOME, ".pi", "agent", "extensions", "plannotator-bridge");

// ── Pure helper functions (tested in isolation) ──

/**
 * Validate that a file path is a readable markdown file inside cwd.
 * Returns null on success, or an error message string on failure.
 */
function validatePlanPath(inputPath: string, cwd: string): string | null {
  if (!inputPath || !inputPath.trim()) {
    return "Path is required";
  }

  const resolved = path.resolve(cwd, inputPath.trim());
  const rel = path.relative(path.resolve(cwd), resolved);

  // Must be inside cwd
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return `Path must be inside the working directory: ${inputPath}`;
  }

  // Must be .md or .mdx
  const ext = path.extname(resolved).toLowerCase();
  if (ext !== ".md" && ext !== ".mdx") {
    return `Plan file must be a markdown file (.md or .mdx), got: ${ext}`;
  }

  // Must exist
  try {
    if (!fs.statSync(resolved).isFile()) {
      return `Not a regular file: ${inputPath}`;
    }
  } catch {
    return `File not found: ${inputPath}`;
  }

  return null;
}

/**
 * Validate that a file path is a readable file (any type) inside cwd.
 * Returns null on success, or an error message string on failure.
 */
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

/**
 * Read a plan file from disk. Returns content string or error message.
 */
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

/**
 * Format a plan review result for the agent.
 */
function formatReviewResult(decision: { approved: boolean; feedback?: string }): string {
  if (decision.approved) {
    const notes = decision.feedback ? `\n\n**Reviewer notes:**\n${decision.feedback}` : "";
    return `## Plan Approved ✓${notes}\n\nProceed with execution. Mark completed steps with [DONE:n].`;
  }

  const feedback = decision.feedback || "No specific feedback provided.";
  return `## Plan Requires Revision\n\n**Feedback:**\n${feedback}\n\nEdit the plan file and re-submit via plan_submit.`;
}

/**
 * Format an annotation result for the agent.
 */
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

// ── Test: validatePlanPath ──

function testValidatePlanPath() {
  console.log("TEST: validatePlanPath");
  let passed = 0;
  let failed = 0;

  // 1. Reject empty path
  const r1 = validatePlanPath("", "/tmp");
  if (r1 !== null && r1.includes("required")) {
    console.log("  ✅ Rejects empty path");
    passed++;
  } else {
    console.log(`  ❌ Should reject empty path, got: ${r1}`);
    failed++;
  }

  // 2. Reject non-markdown extension
  const r2 = validatePlanPath("plan.txt", "/tmp");
  if (r2 !== null && r2.includes(".txt")) {
    console.log("  ✅ Rejects non-.md/.mdx file");
    passed++;
  } else {
    console.log(`  ❌ Should reject .txt, got: ${r2}`);
    failed++;
  }

  // 3. Reject path outside cwd
  const r3 = validatePlanPath("../outside.md", "/tmp");
  if (r3 !== null && r3.includes("working directory")) {
    console.log("  ✅ Rejects path outside cwd");
    passed++;
  } else {
    console.log(`  ❌ Should reject ../ path, got: ${r3}`);
    failed++;
  }

  // 4. Reject non-existent file
  const r4 = validatePlanPath("nonexistent.md", "/tmp");
  if (r4 !== null && r4.includes("not found")) {
    console.log("  ✅ Rejects non-existent file");
    passed++;
  } else {
    console.log(`  ❌ Should reject non-existent file, got: ${r4}`);
    failed++;
  }

  // 5. Accept valid .md file
  const testMd = path.join("/tmp", `test-plan-${Date.now()}.md`);
  fs.writeFileSync(testMd, "# Test Plan");
  const r5 = validatePlanPath(path.basename(testMd), "/tmp");
  if (r5 === null) {
    console.log("  ✅ Accepts valid .md file");
    passed++;
  } else {
    console.log(`  ❌ Should accept valid .md, got: ${r5}`);
    failed++;
  }
  fs.unlinkSync(testMd);

  // 6. Accept .mdx file
  const testMdx = path.join("/tmp", `test-plan-${Date.now()}.mdx`);
  fs.writeFileSync(testMdx, "# Test Plan");
  const r6 = validatePlanPath(path.basename(testMdx), "/tmp");
  if (r6 === null) {
    console.log("  ✅ Accepts valid .mdx file");
    passed++;
  } else {
    console.log(`  ❌ Should accept valid .mdx, got: ${r6}`);
    failed++;
  }
  fs.unlinkSync(testMdx);

  console.log(`  → ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

// ── Test: validateAnnotatePath ──

function testValidateAnnotatePath() {
  console.log("TEST: validateAnnotatePath");
  let passed = 0;
  let failed = 0;

  // 1. Reject empty path
  const r1 = validateAnnotatePath("", "/tmp");
  if (r1 !== null && r1.includes("required")) {
    console.log("  ✅ Rejects empty path");
    passed++;
  } else {
    console.log(`  ❌ Should reject empty path, got: ${r1}`);
    failed++;
  }

  // 2. Reject path outside cwd
  const r2 = validateAnnotatePath("../outside.ts", "/tmp");
  if (r2 !== null && r2.includes("working directory")) {
    console.log("  ✅ Rejects path outside cwd");
    passed++;
  } else {
    console.log(`  ❌ Should reject ../ path, got: ${r2}`);
    failed++;
  }

  // 3. Reject non-existent file
  const r3 = validateAnnotatePath("nonexistent.ts", "/tmp");
  if (r3 !== null && r3.includes("not found")) {
    console.log("  ✅ Rejects non-existent file");
    passed++;
  } else {
    console.log(`  ❌ Should reject non-existent file, got: ${r3}`);
    failed++;
  }

  // 4. Accept any file type
  const testFile = path.join("/tmp", `test-annotate-${Date.now()}.ts`);
  fs.writeFileSync(testFile, "const x = 1;");
  const r4 = validateAnnotatePath(path.basename(testFile), "/tmp");
  if (r4 === null) {
    console.log("  ✅ Accepts .ts file for annotation");
    passed++;
  } else {
    console.log(`  ❌ Should accept .ts file, got: ${r4}`);
    failed++;
  }
  fs.unlinkSync(testFile);

  console.log(`  → ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

// ── Test: readPlanFile ──

function testReadPlanFile() {
  console.log("TEST: readPlanFile");
  let passed = 0;
  let failed = 0;

  // 1. Read valid file
  const testContent = "# My Plan\n\n1. Step one\n2. Step two";
  const testMd = path.join("/tmp", `test-plan-${Date.now()}.md`);
  fs.writeFileSync(testMd, testContent);
  const r1 = readPlanFile(path.basename(testMd), "/tmp");
  if (r1.ok && r1.content === testContent) {
    console.log("  ✅ Reads valid .md file content");
    passed++;
  } else {
    console.log(`  ❌ Should read file content, got: ${JSON.stringify(r1)}`);
    failed++;
  }
  fs.unlinkSync(testMd);

  // 2. Error on non-existent file
  const r2 = readPlanFile("nonexistent-plan.md", "/tmp");
  if (!r2.ok && r2.error.includes("not found")) {
    console.log("  ✅ Errors on non-existent file");
    passed++;
  } else {
    console.log(`  ❌ Should error on non-existent file, got: ${JSON.stringify(r2)}`);
    failed++;
  }

  // 3. Error on empty file
  const emptyMd = path.join("/tmp", `test-empty-${Date.now()}.md`);
  fs.writeFileSync(emptyMd, "");
  const r3 = readPlanFile(path.basename(emptyMd), "/tmp");
  if (!r3.ok && r3.error.includes("empty")) {
    console.log("  ✅ Errors on empty file");
    passed++;
  } else {
    console.log(`  ❌ Should error on empty file, got: ${JSON.stringify(r3)}`);
    failed++;
  }
  fs.unlinkSync(emptyMd);

  // 4. Error on non-markdown file
  const r4 = readPlanFile("plan.txt", "/tmp");
  if (!r4.ok && r4.error.includes(".txt")) {
    console.log("  ✅ Errors on non-markdown file");
    passed++;
  } else {
    console.log(`  ❌ Should error on non-markdown path, got: ${JSON.stringify(r4)}`);
    failed++;
  }

  console.log(`  → ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

// ── Test: formatReviewResult ──

function testFormatReviewResult() {
  console.log("TEST: formatReviewResult");
  let passed = 0;
  let failed = 0;

  const r1 = formatReviewResult({ approved: true });
  if (r1.includes("Approved") && r1.includes("[DONE:n]")) {
    console.log("  ✅ Formats approved result");
    passed++;
  } else {
    console.log(`  ❌ Should include Approved and [DONE:n], got: ${r1.substring(0, 80)}`);
    failed++;
  }

  const r2 = formatReviewResult({ approved: false, feedback: "Missing test cases" });
  if (r2.includes("Revision") && r2.includes("Missing test cases")) {
    console.log("  ✅ Formats denied result with feedback");
    passed++;
  } else {
    console.log(`  ❌ Should include Revision and feedback, got: ${r2.substring(0, 80)}`);
    failed++;
  }

  const r3 = formatReviewResult({ approved: true, feedback: "Consider adding error handling" });
  if (r3.includes("Approved") && r3.includes("Consider adding")) {
    console.log("  ✅ Formats approved result with notes");
    passed++;
  } else {
    console.log(`  ❌ Should include notes, got: ${r3.substring(0, 80)}`);
    failed++;
  }

  console.log(`  → ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

// ── Test: formatAnnotationResult ──

function testFormatAnnotationResult() {
  console.log("TEST: formatAnnotationResult");
  let passed = 0;
  let failed = 0;

  const r1 = formatAnnotationResult({ approved: true });
  if (r1.includes("Approved")) {
    console.log("  ✅ Formats approved annotation");
    passed++;
  } else {
    console.log(`  ❌ Should include Approved, got: ${r1}`);
    failed++;
  }

  const r2 = formatAnnotationResult({ exit: true });
  if (r2.includes("Closed") && r2.includes("without feedback")) {
    console.log("  ✅ Formats closed annotation");
    passed++;
  } else {
    console.log(`  ❌ Should include Closed, got: ${r2}`);
    failed++;
  }

  const r3 = formatAnnotationResult({ feedback: "Add docstring" });
  if (r3.includes("Feedback") && r3.includes("Add docstring")) {
    console.log("  ✅ Formats annotation feedback");
    passed++;
  } else {
    console.log(`  ❌ Should include Feedback, got: ${r3}`);
    failed++;
  }

  console.log(`  → ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

// ── Main ──

function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  plannotator-bridge extension tests          ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("");

  const results = [
    testValidatePlanPath(),
    testValidateAnnotatePath(),
    testReadPlanFile(),
    testFormatReviewResult(),
    testFormatAnnotationResult(),
  ];

  const total = results.length;
  const passed = results.filter(Boolean).length;
  const failed = total - passed;

  console.log("═══════════════════════════════════════════════");
  console.log(`  Total: ${total}  |  Passed: ${passed}  |  Failed: ${failed}`);
  console.log("═══════════════════════════════════════════════");

  process.exit(failed > 0 ? 1 : 0);
}

main();