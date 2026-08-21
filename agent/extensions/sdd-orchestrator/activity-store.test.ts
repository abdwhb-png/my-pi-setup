import { describe, expect, it } from "bun:test";
import type {
  SddDelegationResponse as SubagentDelegationResponse,
  SddDelegationStarted,
  SddDelegationUpdate as SubagentDelegationUpdate,
} from "./delegation-contract.ts";

import type { ApprovedManifest } from "./manifest";
import type { RunSnapshot } from "./state-machine";
import { SddActivityStore } from "./activity-store";
import type { SddDelegationActivityContext } from "./workflow-observer";

function manifest(finalIntegrationReview = false): ApprovedManifest {
  return {
    manifestId: "run-1",
    manifestVersion: 1,
    ruleSetVersion: 1,
    state: "approved",
    planTitle: "Observable plan",
    planPath: "/repo/plan.md",
    sourceDigest: "source",
    assessmentDigest: "assessment",
    assessorModel: "assessor",
    globalProfile: "light",
    parallelismEnabled: true,
    maxConcurrentWriters: 2,
    finalIntegrationReview,
    maximumLaunches: 2,
    tasks: ["one", "two"].map((name, index) => ({
      id: `task-${index + 1}`,
      title: `Task ${name}`,
      description: `Implement ${name}`,
      recommendedProfile: "light" as const,
      effectiveProfile: "light" as const,
      classificationRules: [],
      signals: ["isolated_scope" as const],
      dependencies: [],
      files: [`src/${name}.ts`],
      verify: [],
      budgets: {
        initialWorkers: 1,
        correctionWorkers: 0,
        reviewerAttempts: 0,
        maxLaunches: 1,
      },
      parallelEligible: true,
    })),
    decision: {
      globalProfile: "light",
      taskOverrides: {},
      parallelismEnabled: true,
      finalIntegrationReview,
      criticalDowngradeConfirmations: {},
      criticalDowngradeJustifications: {},
      approvedBy: "operator",
      approvedAt: "2026-08-02T10:00:00.000Z",
    },
    approvalDigest: "approval",
  };
}

function snapshot(state: RunSnapshot["state"] = "running"): RunSnapshot {
  return {
    runId: "run-1",
    revision: 1,
    state,
    tasks: {
      "task-1": { id: "task-1", state: "implementing", launches: 1, maxLaunches: 1 },
      "task-2": { id: "task-2", state: "pending", launches: 0, maxLaunches: 1 },
    },
    consumedIdempotencyKeys: [],
    plannedDelegations: {},
  };
}

function context(
  taskId = "task-1",
  requestId = `${taskId}:worker:1`,
): SddDelegationActivityContext {
  return {
    runId: "run-1",
    taskId,
    requestId,
    stage: "worker",
    attempt: 1,
    agent: "quick-worker",
    model: "model-a",
  };
}

function started(requestId: string): SddDelegationStarted {
  return { requestId, ownerRunId: "run-1", nodeId: requestId };
}

function update(
  requestId: string,
  fields: Omit<SubagentDelegationUpdate, "requestId" | "ownerRunId" | "nodeId">,
): SubagentDelegationUpdate {
  return { ...started(requestId), ...fields };
}

describe("SddActivityStore", () => {
  it("registers a live manifest and merges durable snapshots with live activity", () => {
    const store = new SddActivityStore({ now: () => Date.parse("2026-08-02T10:01:00Z") });
    store.trackRun(manifest(), snapshot(), { live: true });
    store.onDelegationPrepared(context());
    store.onDelegationStarted(context(), started("task-1:worker:1"));
    store.onSnapshot({
      ...snapshot(),
      revision: 2,
      tasks: { ...snapshot().tasks, "task-2": { ...snapshot().tasks["task-2"]!, state: "verified" } },
    });

    const run = store.getRun("run-1");
    expect(run).toMatchObject({ runId: "run-1", state: "running", live: true });
    expect(run?.startedAt).toBe(Date.parse("2026-08-02T10:00:00.000Z"));
    expect(run?.tasks.find((task) => task.id === "task-1")?.delegations[0]).toMatchObject({
      phase: "running",
      agent: "quick-worker",
    });
    expect(run?.tasks.find((task) => task.id === "task-2")?.state).toBe("verified");
  });

  it("strictly correlates requests, ignores stale terminal updates, and deduplicates tools", () => {
    const store = new SddActivityStore();
    store.trackRun(manifest(), snapshot(), { live: true });
    store.onDelegationPrepared(context());

    const mismatched = update("other-request", {
      currentTool: "write",
    });
    store.onDelegationUpdate(context(), mismatched);
    expect(store.getRun("run-1")?.tasks[0]?.delegations[0]?.currentTool).toBeUndefined();

    store.onDelegationUpdate(context(), update(context().requestId, {
      currentTool: "exec",
      currentToolArgs: '{"token":"secret","cmd":"bun test"}',
      recentTools: Array.from({ length: 10 }, (_, index) => ({
        tool: index < 2 ? "read" : `tool-${index}`,
        args: index < 2 ? "same" : `arg-${index}`,
      })),
      recentOutputLines: ["one", "two", "three", "four", "five", "six"],
      model: "model-b",
      durationMs: 1500,
      tokens: 42,
    }));
    const response: SubagentDelegationResponse = {
      version: 1,
      requestId: context().requestId,
      ownerRunId: "run-1",
      nodeId: context().requestId,
      status: "completed",
      result: { kind: "text", text: "done" },
      agent: "quick-worker",
    };
    store.onDelegationFinished(context(), response);
    store.onDelegationUpdate(context(), update(context().requestId, {
      currentTool: "stale",
    }));

    const activity = store.getRun("run-1")?.tasks[0]?.delegations[0];
    expect(activity?.phase).toBe("terminal");
    expect(activity?.currentTool?.tool).toBe("exec");
    expect(activity?.currentTool?.args).not.toContain("secret");
    expect(activity?.recentTools).toHaveLength(8);
    expect(new Set(activity?.recentTools.map((tool) => `${tool.tool}:${tool.args}`))).toHaveLength(8);
    expect(activity?.recentOutputLines).toEqual(["three", "four", "five", "six", "done"]);
  });

  it("keeps parallel delegations independent and notifies subscribers only for accepted changes", () => {
    const store = new SddActivityStore();
    store.trackRun(manifest(), snapshot(), { live: true });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => { notifications += 1; });
    const first = context("task-1");
    const second = context("task-2");
    store.onDelegationPrepared(first);
    store.onDelegationPrepared(second);
    store.onDelegationUpdate(first, update(first.requestId, { currentTool: "edit" }));
    store.onDelegationUpdate(second, update("wrong", { currentTool: "ignored" }));
    unsubscribe();
    store.onDelegationStarted(second, started(second.requestId));

    expect(notifications).toBe(3);
    expect(store.getRun("run-1")?.tasks.map((task) => task.delegations.length)).toEqual([1, 1]);
  });

  it("presents needs_input as terminal and adds an integration review task", () => {
    const store = new SddActivityStore();
    store.trackRun(manifest(true), snapshot("needs_input"), { live: true });
    const run = store.getRun("run-1");
    expect(run?.presentationTerminal).toBe(true);
    expect(run?.tasks.at(-1)).toMatchObject({
      id: "__integration__",
      title: "Integration review",
      virtual: true,
    });
  });

  it("hydrates historical runs without making them widget candidates", () => {
    const store = new SddActivityStore();
    store.trackRun(manifest(), snapshot("completed"), { live: false });
    expect(store.getRun("run-1")?.live).toBe(false);
    expect(store.getLiveRuns()).toEqual([]);
    expect(store.getRun("run-1")?.historyNotice).toContain("unavailable");
  });
});
