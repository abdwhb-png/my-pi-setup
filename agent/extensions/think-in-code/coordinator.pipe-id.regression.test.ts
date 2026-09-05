import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CommandExecutionService } from "../_shared/command-execution/core.ts";
import type { AnalysisSandboxPort } from "../_shared/sandbox-runtime/index.ts";

import type { ThinkCommandOperation } from "./command-policy.ts";
import { DEFAULT_THINK_IN_CODE_CONFIG } from "./config.ts";
import { ThinkStore } from "./storage/store.ts";
import { ThinkCoordinator } from "./coordinator.ts";

function ctx(cwd: string): ExtensionContext {
  return { cwd, hasUI: false, ui: {} } as unknown as ExtensionContext;
}

describe("Defect 1 RED: pipe-form Pi toolCallId through public execution boundary", () => {
  let home: string | undefined;
  let store: ThinkStore | undefined;
  let coordinator: ThinkCoordinator | undefined;

  afterEach(async () => {
    coordinator?.close();
    store?.close();
    if (home) await rm(home, { recursive: true, force: true });
    home = undefined;
    store = undefined;
    coordinator = undefined;
  });

  it("execute with real Pi pipe ID must produce derived output and a deterministic allowed analysis ID <=128", async () => {
    const PI_PIPE_ID = "call_01a05fb7afc07c33bac7f3468cf87034|fc_01a05fb7afc07c33bac7f3468cf87034";
    home = await mkdtemp(join(tmpdir(), "think-pipe-red-"));
    const storeRoot = join(home, "store");
    await mkdir(storeRoot, { recursive: true });
    const capturedIds: string[] = [];
    const safeExec: CommandExecutionService<ThinkCommandOperation> = {
      execute: mock(async () => ({
        content: [{ type: "text" as const, text: "payload-bytes" }],
        details: undefined,
      })),
    };
    const analysis: AnalysisSandboxPort = {
      run: mock(async (req) => {
        capturedIds.push(req.id);
        return {
          output: "DERIVED_PIPE_OK",
          stderr: "",
          runtime: "quickjs" as const,
          durationMs: 1,
          truncated: false,
        };
      }),
      shutdown: async () => undefined,
    };
    store = new ThinkStore({ config: DEFAULT_THINK_IN_CODE_CONFIG, storeRoot, canonicalPath: "/workspace/proj" });
    coordinator = new ThinkCoordinator({ store, config: DEFAULT_THINK_IN_CODE_CONFIG, commandExecution: safeExec, getAnalysisPort: () => analysis });

    const result = await coordinator.execute(
      {
        id: PI_PIPE_ID,
        language: "javascript",
        program: "return INPUT.length",
        source: { kind: "command", command: "echo hi" },
      },
      ctx("/workspace/proj"),
    );

    // Must not be blocked by Invalid analysis request id
    expect(result.details.blockedReason).toBeUndefined();
    expect(result.content[0]?.text).toBe("DERIVED_PIPE_OK");
    expect(result.details.derivedBytes).toBeGreaterThan(0);
    expect(capturedIds.length).toBe(1);
    const seen = capturedIds[0]!;
    expect(seen).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    expect(seen.length).toBeLessThanOrEqual(128);
    // deterministic: second call with same PI id yields same mapped id
    await coordinator.execute(
      { id: PI_PIPE_ID, language: "javascript", program: "return 1", source: { kind: "command", command: "echo hi2" } },
      ctx("/workspace/proj"),
    );
    expect(capturedIds[1]).toBe(seen);
    expect(capturedIds[0]).not.toBe(PI_PIPE_ID);
    expect(capturedIds[0]).not.toContain("|");
  });

  it("executeFile with pipe ID must also map deterministically", async () => {
    const PI_PIPE_ID = "call_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|fc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    home = await mkdtemp(join(tmpdir(), "think-pipe-file-"));
    const storeRoot = join(home, "store");
    await mkdir(storeRoot, { recursive: true });
    const capturedIds: string[] = [];
    const safeExec: CommandExecutionService<ThinkCommandOperation> = {
      execute: mock(async () => ({
        content: [{ type: "text" as const, text: "x" }],
        details: undefined,
      })),
    };
    const analysis: AnalysisSandboxPort = {
      run: mock(async (req) => {
        capturedIds.push(req.id);
        return { output: "FILE_DERIVED", stderr: "", runtime: "quickjs" as const, durationMs: 1, truncated: false };
      }),
      shutdown: async () => undefined,
    };
    store = new ThinkStore({ config: DEFAULT_THINK_IN_CODE_CONFIG, storeRoot, canonicalPath: "/workspace/proj" });
    coordinator = new ThinkCoordinator({ store, config: DEFAULT_THINK_IN_CODE_CONFIG, commandExecution: safeExec, getAnalysisPort: () => analysis });
    await Bun.write(join(home, "data.txt"), "hello file");
    const result = await coordinator.executeFile(
      { id: PI_PIPE_ID, path: "data.txt", language: "javascript", program: "return FILE_CONTENT" },
      ctx(home),
    );
    expect(result.details.blockedReason).toBeUndefined();
    expect(capturedIds[0]).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    expect(capturedIds[0]!.length).toBeLessThanOrEqual(128);
    expect(capturedIds[0]).not.toContain("|");
  });

  it("batchExecute with pipe ID must map deterministically", async () => {
    const PI_PIPE_ID = "call_cccccccccccccccccccccccccccccccc|fc_dddddddddddddddddddddddddddddddd";
    home = await mkdtemp(join(tmpdir(), "think-pipe-batch-"));
    const storeRoot = join(home, "store");
    await mkdir(storeRoot, { recursive: true });
    const capturedIds: string[] = [];
    const safeExec: CommandExecutionService<ThinkCommandOperation> = {
      execute: mock(async () => ({
        content: [{ type: "text" as const, text: "out" }],
        details: undefined,
      })),
    };
    const analysis: AnalysisSandboxPort = {
      run: mock(async (req) => {
        capturedIds.push(req.id);
        return { output: "BATCH_DERIVED", stderr: "", runtime: "quickjs" as const, durationMs: 1, truncated: false };
      }),
      shutdown: async () => undefined,
    };
    store = new ThinkStore({ config: DEFAULT_THINK_IN_CODE_CONFIG, storeRoot, canonicalPath: "/workspace/proj" });
    coordinator = new ThinkCoordinator({ store, config: DEFAULT_THINK_IN_CODE_CONFIG, commandExecution: safeExec, getAnalysisPort: () => analysis });
    const result = await coordinator.batchExecute(
      { id: PI_PIPE_ID, language: "javascript", program: "return INPUTS", items: [{ id: "a", command: "echo 1" }] },
      ctx("/workspace/proj"),
    );
    expect(result.details.blockedReason).toBeUndefined();
    expect(capturedIds[0]).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    expect(capturedIds[0]).not.toContain("|");
  });
});
