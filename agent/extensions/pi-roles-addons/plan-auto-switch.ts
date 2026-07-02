/**
 * plan-auto-switch — Auto-switch to pi-agent role after plan approval.
 *
 * This extension listens on `before_agent_start` and scans the session log
 * for unprocessed `plannotator:plan-approved` entries (emitted by the
 * plannotator-bridge extension's `plan_submit` tool). When one is found,
 * it writes a `pi-roles:switch-request` entry via the shared protocol.
 * pi-roles consumes the request in its own `before_agent_start` handler
 * and applies the role switch — pi-roles remains the sole owner of
 * `state.activeRole` and the system prompt.
 *
 * This extension no longer returns a systemPrompt, no longer reads role
 * files, and no longer calls setActiveTools. All role-application logic
 * lives in pi-roles. The only job here is detecting the approval event
 * and forwarding it as a typed protocol request.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeRoleSwitchRequest } from "pi-roles/protocol";
import { getSettingsValue } from "../_shared/settings";

// ── Constants ──

/** Custom entry type emitted by plannotator-bridge on plan approval. */
const PLAN_APPROVED_ENTRY_TYPE = "plannotator:plan-approved";

/** Custom entry type we persist to mark an approval as processed. */
export const PROCESSED_MARKER_PREFIX = "plan-auto-switch:processed";

// ── Types ──

interface PlanApprovedPayload {
  planPath?: string;
  approved?: boolean;
  feedback?: string;
  timestamp?: number;
}

// ── Pure helpers (exported for tests) ──

/**
 * Scan session entries (newest-first) for an unprocessed
 * `plannotator:plan-approved` entry.
 *
 * "Unprocessed" means there is no subsequent `plan-auto-switch:processed`
 * entry whose `sourceEntryId` matches the approval entry's id.
 *
 * Returns `{ entry, data }` for the latest unprocessed approval, or `null`.
 */
export function findUnprocessedPlanApproval(
  entries: ReadonlyArray<{
    type: string;
    customType?: string;
    data?: unknown;
    id: string;
  }>,
): { entry: { id: string }; data: PlanApprovedPayload } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.type !== "custom" || e.customType !== PLAN_APPROVED_ENTRY_TYPE) continue;

    const data = (e.data ?? {}) as PlanApprovedPayload;
    if (data.approved !== true) continue;

    const processed = entries
      .slice(i + 1)
      .some(
        (p) =>
          p &&
          p.type === "custom" &&
          p.customType === PROCESSED_MARKER_PREFIX &&
          ((p.data as { sourceEntryId?: string } | undefined)?.sourceEntryId === e.id),
      );

    if (!processed) {
      return { entry: { id: e.id }, data };
    }
  }
  return null;
}

// ── Extension entry point ──

export default function planAutoSwitch(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (_event, ctx) => {
    let entries;
    try {
      entries = ctx.sessionManager.getEntries();
    } catch {
      return;
    }

    const approval = findUnprocessedPlanApproval(entries);
    if (!approval) return;

    // Write the switch-request through pi-roles' shared protocol.
    // pi-roles consumes this in its own before_agent_start handler
    // and applies the role switch (mutates state.activeRole, sets
    // tools/model, returns the correct systemPrompt).
    // Default to "pi-agent" if pi-roles.defaultRole is not defined.
    const targetRole = getSettingsValue("pi-roles.defaultRole", "pi-agent");
    writeRoleSwitchRequest(pi, {
      targetRole,
      reason: "plannotator:plan-approved",
      sourceEntryId: approval.entry.id,
    });

    // Mark the approval as processed so we don't re-trigger.
    pi.appendEntry(PROCESSED_MARKER_PREFIX, {
      sourceEntryId: approval.entry.id,
      timestamp: Date.now(),
    });

    // No systemPrompt return — pi-roles owns the prompt. Our request
    // entry will be consumed by pi-roles' handler this same turn.
  });
}