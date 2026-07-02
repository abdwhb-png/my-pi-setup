/**
 * Tests for plan-auto-switch pure helpers.
 *
 * After the rewrite (v2), plan-auto-switch no longer reads role files,
 * parses tool lists, or returns systemPrompts. It only detects
 * `plannotator:plan-approved` entries and writes a
 * `pi-roles:switch-request` via the shared protocol.
 *
 * The testable surface is now:
 *   - `findUnprocessedPlanApproval` — scan session entries
 *   - The handler delegates to `writeRoleSwitchRequest` from pi-roles/protocol
 *     (mocked in the smoke test)
 */

import { describe, expect, it, mock } from "bun:test";
import {
  findUnprocessedPlanApproval,
  PROCESSED_MARKER_PREFIX,
} from "./plan-auto-switch";

// ---------------------------------------------------------------------------
// findUnprocessedPlanApproval
// ---------------------------------------------------------------------------

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

  it("returns null when all plan-approved entries are processed", () => {
    const entries = [
      makeEntry("plannotator:plan-approved", { planPath: "/a.md", approved: true, timestamp: 1 }, "e1"),
      makeEntry("plan-auto-switch:processed", { sourceEntryId: "e1" }, "e2"),
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

// ---------------------------------------------------------------------------
// Exports sanity
// ---------------------------------------------------------------------------

describe("module exports", () => {
  it("exports PROCESSED_MARKER_PREFIX", () => {
    expect(PROCESSED_MARKER_PREFIX).toBe("plan-auto-switch:processed");
  });

  it("exports findUnprocessedPlanApproval as a function", () => {
    expect(typeof findUnprocessedPlanApproval).toBe("function");
  });
});