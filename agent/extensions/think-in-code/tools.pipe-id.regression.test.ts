import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  claimAnalysisSandboxBroker,
  publishAnalysisSandboxService,
  releaseAnalysisSandboxBroker,
} from "../_shared/analysis/sandbox-analysis-broker.ts";
import {
  claimSafeExecutionBroker,
  publishSafeExecutionService,
  releaseSafeExecutionBroker,
} from "../_shared/safe-execution/broker.ts";
import type { SafeExecutionService } from "../_shared/safe-execution/core.ts";
import type { AnalysisSandboxService } from "../sandbox/analysis/client.ts";
import { DEFAULT_THINK_IN_CODE_CONFIG } from "./config.ts";
import { ThinkStore } from "./storage/store.ts";
import { ThinkCoordinator } from "./coordinator.ts";
import { buildToolHandlers } from "./tools.ts";

const owner = Symbol("tools-pipe-red");

function ctx(cwd: string): ExtensionContext {
  return { cwd, hasUI: false, ui: {} } as unknown as ExtensionContext;
}

describe("Defect 1 RED: tools layer pipe ID mapping through public execution boundary", () => {
  let home: string | undefined;
  let coord: ThinkCoordinator | undefined;
  beforeEach(() => {
    claimSafeExecutionBroker(owner);
    claimAnalysisSandboxBroker(owner);
  });
  afterEach(async () => {
    coord?.close();
    releaseSafeExecutionBroker(owner);
    releaseAnalysisSandboxBroker(owner);
    if (home) await rm(home, { recursive: true, force: true });
    home = undefined;
    coord = undefined;
  });

  it("think_execute via buildToolHandlers with exact pipe-form Pi ID must not return Invalid analysis request id and must derive output", async () => {
    const PI_PIPE_ID = "call_01a05fb7afc07c33bac7f3468cf87034|fc_01a05fb7afc07c33bac7f3468cf87034";
    home = await mkdtemp(join(tmpdir(), "tools-pipe-"));
    const storeRoot = join(home, "store");
    await mkdir(storeRoot, { recursive: true });
    const captured: string[] = [];
    const safe: SafeExecutionService = {
      execute: mock(async () => ({ content: [{ type: "text" as const, text: "hello" }], details: undefined })),
    };
    const analysis: AnalysisSandboxService = {
      run: mock(async (req) => {
        captured.push(req.id);
        return { output: "DERIVED_VIA_TOOLS", stderr: "", runtime: "quickjs" as const, durationMs: 1, truncated: false };
      }),
      shutdown: async () => {},
    };
    publishSafeExecutionService(owner, safe);
    publishAnalysisSandboxService(owner, analysis);
    const store = new ThinkStore({ config: DEFAULT_THINK_IN_CODE_CONFIG, storeRoot, canonicalPath: "/proj" });
    coord = new ThinkCoordinator({ store, config: DEFAULT_THINK_IN_CODE_CONFIG });
    const handlers = buildToolHandlers(coord);
    const result = (await handlers.execute(
      { language: "javascript", program: "return INPUT", command: "echo hi" },
      ctx("/proj"),
      { toolCallId: PI_PIPE_ID },
    )) as { content: { text: string }[]; details: { blockedReason?: string; derivedBytes: number } };
    expect(result.details.blockedReason).toBeUndefined();
    expect(result.content[0]?.text).toBe("DERIVED_VIA_TOOLS");
    expect(result.details.derivedBytes).toBeGreaterThan(0);
    expect(captured[0]).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    expect(captured[0]).not.toContain("|");
    expect(captured[0]!.length).toBeLessThanOrEqual(128);
    store.close();
  });
});
