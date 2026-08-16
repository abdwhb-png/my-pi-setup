import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { createArtifactRootRegistry, createScopedWriter, purgeArtifacts } from './core.ts';

const temporaryDirectories: string[] = [];

function temporaryProject(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-scoped-write-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("createScopedWriter", () => {
  test("creates a report only under its declared root and appends an audit event", () => {
    const projectRoot = temporaryProject();
    const writer = createScopedWriter({
      projectRoot,
      policy: {
        id: "report-v1",
        root: ".pi/artifacts/reports/sdd-qa-tester/run-1",
        allowedExtensions: [".md", ".json"],
        operations: ["create", "edit"],
        maxBytes: 1024,
        auditNamespace: "reports",
        allowNestedDirectories: true,
      },
      actor: {
        agent: "sdd-qa-tester",
        role: "sdd-qa-tester",
        runId: "run-1",
      },
    });

    const result = writer.create({
      path: "result.md",
      content: "# Passed\n",
      tool: "write_report",
    });

    expect(result.kind).toBe("success");
    expect(
      readFileSync(join(projectRoot, ".pi/artifacts/reports/sdd-qa-tester/run-1/result.md"), "utf8"),
    ).toBe("# Passed\n");

    const auditPath = join(projectRoot, ".pi/artifacts/.audit/run-1.jsonl");
    expect(existsSync(auditPath)).toBeTrue();
    expect(JSON.parse(readFileSync(auditPath, "utf8"))).toMatchObject({
      version: 1,
      operation: "create",
      tool: "write_report",
      path: ".pi/artifacts/reports/sdd-qa-tester/run-1/result.md",
      sha256Before: null,
      agent: "sdd-qa-tester",
      role: "sdd-qa-tester",
      runId: "run-1",
    });
  });

  test("edits exactly one matching block and rejects an ambiguous replacement", () => {
    const projectRoot = temporaryProject();
    const root = join(projectRoot, ".pi/artifacts/reports/sdd-qa-tester/run-1");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "result.md"), "first\nneedle\nlast\n", "utf8");
    const writer = createScopedWriter({
      projectRoot,
      policy: {
        id: "report-v1",
        root: ".pi/artifacts/reports/sdd-qa-tester/run-1",
        allowedExtensions: [".md"],
        operations: ["edit"],
        maxBytes: 1024,
        auditNamespace: "reports",
        allowNestedDirectories: true,
      },
      actor: { agent: "sdd-qa-tester", role: "sdd-qa-tester", runId: "run-1" },
    });

    expect(
      writer.edit({
        path: "result.md",
        tool: "edit_report",
        edits: [{ oldText: "needle", newText: "changed" }],
      }).kind,
    ).toBe("success");
    expect(readFileSync(join(root, "result.md"), "utf8")).toBe("first\nchanged\nlast\n");

    writeFileSync(join(root, "result.md"), "x\nx\n", "utf8");
    expect(
      writer.edit({
        path: "result.md",
        tool: "edit_report",
        edits: [{ oldText: "x", newText: "changed" }],
      }),
    ).toMatchObject({ kind: "rejected", reason: "Edit text matches 2 locations." });
    expect(readFileSync(join(root, "result.md"), "utf8")).toBe("x\nx\n");
  });

  test("edits an empty existing artifact as one exact whole-file match", () => {
    const projectRoot = temporaryProject();
    const root = join(projectRoot, ".pi/artifacts/reports/sdd-qa-tester/run-1");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "empty.md"), "", "utf8");
    const writer = createScopedWriter({
      projectRoot,
      policy: {
        id: "report-v1",
        root: ".pi/artifacts/reports/sdd-qa-tester/run-1",
        allowedExtensions: [".md"],
        operations: ["edit"],
        maxBytes: 1024,
        auditNamespace: "reports",
        allowNestedDirectories: true,
      },
      actor: { agent: "sdd-qa-tester", role: "sdd-qa-tester", runId: "run-1" },
    });

    const result = writer.edit({
      path: "empty.md",
      tool: "edit_report",
      edits: [{ oldText: "", newText: "# First content\n" }],
    });
    expect(result.kind).toBe("success");
    expect(readFileSync(join(root, "empty.md"), "utf8")).toBe("# First content\n");
    const audit = JSON.parse(
      readFileSync(join(projectRoot, ".pi/artifacts/.audit/run-1.jsonl"), "utf8"),
    );
    expect(audit.sha256Before).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("rejects traversal, unsupported extensions, and symlink escapes without writing", () => {
    const projectRoot = temporaryProject();
    const outside = join(projectRoot, "outside.md");
    const root = join(projectRoot, ".pi/artifacts/reports/sdd-qa-tester/run-1");
    mkdirSync(root, { recursive: true });
    const writer = createScopedWriter({
      projectRoot,
      policy: {
        id: "report-v1",
        root: ".pi/artifacts/reports/sdd-qa-tester/run-1",
        allowedExtensions: [".md"],
        operations: ["create"],
        maxBytes: 1024,
        auditNamespace: "reports",
        allowNestedDirectories: true,
      },
      actor: { agent: "sdd-qa-tester", role: "sdd-qa-tester", runId: "run-1" },
    });

    expect(writer.create({ path: "../outside.md", content: "x", tool: "write_report" }).kind).toBe(
      "rejected",
    );
    expect(writer.create({ path: "report.ts", content: "x", tool: "write_report" }).kind).toBe(
      "rejected",
    );
    symlinkSync(projectRoot, join(root, "escape"));
    expect(
      writer.create({ path: "escape/outside.md", content: "x", tool: "write_report" }).kind,
    ).toBe("rejected");
    expect(existsSync(outside)).toBeFalse();
  });

  test("reports a partial failure when the artifact is written but audit recording fails", () => {
    const projectRoot = temporaryProject();
    const writer = createScopedWriter({
      projectRoot,
      policy: {
        id: "report-v1",
        root: ".pi/artifacts/reports/sdd-qa-tester/run-1",
        allowedExtensions: [".md"],
        operations: ["create"],
        maxBytes: 1024,
        auditNamespace: "reports",
        allowNestedDirectories: true,
      },
      actor: { agent: "sdd-qa-tester", role: "sdd-qa-tester", runId: "run-1" },
      appendAudit: () => {
        throw new Error("disk full");
      },
    });

    expect(
      writer.create({ path: "report.md", content: "proof", tool: "write_report" }),
    ).toMatchObject({
      kind: "partial_failure",
      path: ".pi/artifacts/reports/sdd-qa-tester/run-1/report.md",
    });
    expect(
      readFileSync(join(projectRoot, ".pi/artifacts/reports/sdd-qa-tester/run-1/report.md"), "utf8"),
    ).toBe("proof");
  });

  test("purges only the registered roots of one confirmed run and audits it", () => {
    const projectRoot = temporaryProject();
    const firstRun = join(projectRoot, ".pi/artifacts/reports/sdd-qa-tester/run-1");
    const secondRun = join(projectRoot, ".pi/artifacts/reports/sdd-qa-tester/run-2");
    mkdirSync(firstRun, { recursive: true });
    mkdirSync(secondRun, { recursive: true });
    writeFileSync(join(firstRun, "report.md"), "old", "utf8");
    writeFileSync(join(secondRun, "report.md"), "keep", "utf8");
    const roots = createArtifactRootRegistry();
    roots.register({
      id: "reports",
      resolve: (root, runId) => [join(root, ".pi/artifacts/reports/sdd-qa-tester", runId)],
    });

    const result = purgeArtifacts({
      projectRoot,
      runId: "run-1",
      actor: { agent: "operator", role: "operator", runId: "run-1" },
      tool: "artifacts_purge",
      registry: roots,
      confirmed: true,
    });

    expect(result.kind).toBe("success");
    expect(existsSync(firstRun)).toBeFalse();
    expect(existsSync(secondRun)).toBeTrue();
    expect(readFileSync(join(projectRoot, ".pi/artifacts/.audit/run-1.jsonl"), "utf8")).toContain(
      '"operation":"purge"',
    );
  });
});
