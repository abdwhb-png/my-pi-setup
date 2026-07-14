/**
 * Tests for plan-auto-switch pure helpers.
 *
 * After the rewrite (v3), plan-auto-switch listens on `turn_end` instead
 * of `before_agent_start` to detect plan approvals sooner. It also
 * recognizes the main plannotator's `plannotator-autoexecute-processed`
 * marker to avoid double-firing.
 *
 * The testable surface:
 *   - `findUnprocessedPlanApproval` — scan session entries (cross-marker aware)
 *   - The handler delegates to `writeRoleSwitchRequest` from pi-roles/protocol
 *     (mocked in smoke test)
 */

import { describe, expect, it, mock } from "bun:test";
import {
  findUnprocessedPlanApproval,
  PROCESSED_MARKER_PREFIX,
  PLUG_PLANNOTATOR_AUTOEXECUTE_PROCESSED,
} from "./plan-auto-switch";


describe("findUnprocessedPlanApproval", () => {
  function makeEntry(customType: string, data: unknown, id: string) {
    return { type: "custom" as const, customType, data, id, parentId: null, timestamp: Date.now() };
  }

  it("returns the latest unprocessed plan-approved entry", () => {
    const entries = [
      makeEntry("plannotator:plan-approved", { planPath: "/a.md", approved: true, timestamp: 1 }, "e1"),
      makeEntry("plan-auto-switch:processed", { sourceEntryId: "e1" }, "e2"),
      makeEntry("plannotator:plan-approved", { planPath: "/b.md", approved: true, timestamp: 2 }, "e3"),
    ];
    const result = findUnprocessedPlanApproval(entries as any);
    expect(result).toBeDefined();
    expect(result?.entry.id).toBe("e3");
    expect(result?.data.planPath).toBe("/b.md");
  });

  it("returns null when all plan-approved entries are processed (own marker)", () => {
    const entries = [
      makeEntry("plannotator:plan-approved", { planPath: "/a.md", approved: true, timestamp: 1 }, "e1"),
      makeEntry("plan-auto-switch:processed", { sourceEntryId: "e1" }, "e2"),
    ];
    expect(findUnprocessedPlanApproval(entries as any)).toBeNull();
  });

  it("returns null when entry is processed by main plannotator marker", () => {
    const entries = [
      makeEntry("plannotator:plan-approved", { planPath: "/a.md", approved: true, timestamp: 1 }, "e1"),
      makeEntry("plannotator-autoexecute-processed", { sourceEntryId: "e1" }, "e2"),
    ];
    expect(findUnprocessedPlanApproval(entries as any)).toBeNull();
  });

  it("returns null when no plan-approved entries exist", () => {
    const entries = [makeEntry("other:event", {}, "e1")];
    expect(findUnprocessedPlanApproval(entries as any)).toBeNull();
  });

  it("returns null for empty entries", () => {
    expect(findUnprocessedPlanApproval([])).toBeNull();
  });

  it("handles multiple unprocessed — returns the latest", () => {
    const entries = [
      makeEntry("plannotator:plan-approved", { planPath: "/a.md", approved: true, timestamp: 1 }, "e1"),
      makeEntry("plannotator:plan-approved", { planPath: "/b.md", approved: true, timestamp: 2 }, "e2"),
    ];
    const result = findUnprocessedPlanApproval(entries as any);
    expect(result?.entry.id).toBe("e2");
  });

  it("ignores entries with approved !== true", () => {
    const entries = [
      makeEntry("plannotator:plan-approved", { planPath: "/a.md", approved: false, timestamp: 1 }, "e1"),
    ];
    expect(findUnprocessedPlanApproval(entries as any)).toBeNull();
  });
});


describe("module exports", () => {
  it("exports PROCESSED_MARKER_PREFIX", () => {
    expect(PROCESSED_MARKER_PREFIX).toBe("plan-auto-switch:processed");
  });

  it("exports PLUG_PLANNOTATOR_AUTOEXECUTE_PROCESSED", () => {
    expect(PLUG_PLANNOTATOR_AUTOEXECUTE_PROCESSED).toBe("plannotator-autoexecute-processed");
  });

  it("exports findUnprocessedPlanApproval as a function", () => {
    expect(typeof findUnprocessedPlanApproval).toBe("function");
  });
});
