import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Opt in with PI_WRAPPER_RUNTIME_CONTRACT=1 and explicit PI_WRAPPER_{RUNTIME,TODO,SUBAGENTS}_PACKAGE_ROOT paths; only temporary user state is created.
test.skipIf(process.env.PI_WRAPPER_RUNTIME_CONTRACT !== "1")(
  "the Bun launcher preserves todo schemas in provider payloads and fresh child sessions",
  () => {
    const packageRoot = process.env.PI_WRAPPER_RUNTIME_PACKAGE_ROOT;
    const todoRoot = process.env.PI_WRAPPER_TODO_PACKAGE_ROOT;
    const subagentsRoot = process.env.PI_WRAPPER_SUBAGENTS_PACKAGE_ROOT;
    assert(packageRoot && todoRoot && subagentsRoot, "Explicit runtime, todo and subagents package roots are required");
    const root = mkdtempSync(join(tmpdir(), "pi-wrapper-schema-"));
    try {
      const agentDir = join(root, "agent");
      mkdirSync(agentDir);
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [], extensions: [], skills: [] }));
      const output = join(root, "schema.json");
      const probe = join(root, "probe.ts");
      writeFileSync(probe, `import { TodoParamsSchema } from ${JSON.stringify(join(todoRoot, "tool/types.ts"))};\nimport check from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "fixtures/pi-wrapper-schema-probe.mjs")).href)};\nexport default () => check(TodoParamsSchema);\n`);
      const result = spawnSync(process.execPath, [
        resolve(import.meta.dir, "../../bin/pi"),
        "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-session",
        "-e", probe,
      ], {
        cwd: root, encoding: "utf-8", timeout: 30_000,
        env: {
          ...process.env, HOME: root, USERPROFILE: root,
          PI_REAL_BIN: join(packageRoot, "dist/bundle/cli.js"),
          PI_CODING_AGENT_DIR: agentDir, PI_PACKAGE_FINALIZER_ACTIVE: "1", PI_OFFLINE: "1",
          JITI_TRY_NATIVE: "true",
          PI_WRAPPER_TODO_ENTRY: join(todoRoot, "index.ts"),
          PI_WRAPPER_CHILD_FACTORY: join(subagentsRoot, "src/runs/shared/child-session.ts"),
          PI_WRAPPER_SCHEMA_OUTPUT: output,
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const captured = JSON.parse(readFileSync(output, "utf-8"));
      expect(captured.bun).toBe(process.versions.bun);
      expect([captured.started, captured.stopped, captured.networkAttempts]).toEqual([1, 1, 0]);
      expect(captured.payloads).toHaveLength(2);
      for (const [index, schema] of captured.payloads.entries()) {
        expect(JSON.stringify(schema), index === 0 ? "parent payload" : "child payload").not.toMatch(/"~[^"\s]+"\s*:/);
        expect(schema.properties.status.enum).toEqual(["pending", "in_progress", "completed", "deleted"]);
        expect(schema.required ?? []).not.toContain("status");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, { timeout: 40_000 },
);
