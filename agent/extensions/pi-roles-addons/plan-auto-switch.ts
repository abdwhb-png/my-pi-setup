/**
 * plan-auto-switch — Auto-switch role after plan approval.
 *
 * Listens on `turn_end` (was `before_agent_start`) to detect plan
 * approvals as soon as the turn that produced them ends — not at the
 * start of the *next* turn. On detection it writes a
 * `pi-roles:switch-request` entry and sends a "Continue" user message
 * to force an immediate new turn so pi-roles can consume the request
 * in its own `before_agent_start` handler.
 *
 * Uses the main plannotator's `plannotator-autoexecute-processed`
 * marker so the main plannotator's `agent_end` handler doesn't
 * double-fire.
 *
 * pi-roles remains the sole owner of `state.activeRole` and the
 * system prompt. This extension's only job is detecting the approval
 * and forwarding it as a typed protocol request at the earliest
 * possible moment.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeRoleSwitchRequest } from "../_shared/pi-roles";
import { getSettingsValue } from "../_shared/settings";


/** Custom entry type emitted by plannotator-bridge on plan approval. */
const PLAN_APPROVED_ENTRY_TYPE = "plannotator:plan-approved";

/**
 * Processed marker used by this extension AND the main plannotator.
 * Using the same marker prevents both from firing on the same approval.
 */
export const PLUG_PLANNOTATOR_AUTOEXECUTE_PROCESSED = "plannotator-autoexecute-processed";

/**
 * Legacy marker — kept exported for backward-compatible dedup in
 * `findUnprocessedPlanApproval`. New entries use the shared marker above.
 */
export const PROCESSED_MARKER_PREFIX = "plan-auto-switch:processed";

/** Fully-qualified event name for the marker we write. */

interface PlanApprovedPayload {
  planPath?: string;
  approved?: boolean;
  feedback?: string;
  timestamp?: number;
}


/**
 * Scan session entries (newest-first) for an unprocessed
 * `plannotator:plan-approved` entry.
 *
 * "Unprocessed" means no subsequent marker with a matching
 * `sourceEntryId` — we check both our legacy marker and the
 * main plannotator's marker.
 */
// oxlint-disable-next-line typescript/no-restricted-types -- pi entry data is unknown by API contract
export function findUnprocessedPlanApproval(
  entries: ReadonlyArray<{
    type: string;
    customType?: string;
    // oxlint-disable-next-line typescript/no-restricted-types -- pi entry data is unknown by API contract
    data?: unknown;
    id: string;
  }>,
): { entry: { id: string }; data: PlanApprovedPayload } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.type !== "custom" || e.customType !== PLAN_APPROVED_ENTRY_TYPE) continue;

    const data = (e.data ?? {}) as PlanApprovedPayload;
    if (data.approved !== true) continue;

    // Check both our legacy marker and the shared marker
    const processed = entries
      .slice(i + 1)
      .some(
        (p) =>
          p &&
          p.type === "custom" &&
          (
            p.customType === PROCESSED_MARKER_PREFIX ||
            p.customType === PLUG_PLANNOTATOR_AUTOEXECUTE_PROCESSED
          ) &&
          (
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pi entry data is unknown
            (p.data as { sourceEntryId?: string } | undefined)?.sourceEntryId === e.id
          ),
      );

    if (!processed) {
      return { entry: { id: e.id }, data };
    }
  }
  return null;
}


export default function planAutoSwitch(pi: ExtensionAPI): void {
  pi.on("turn_end", async (_event, ctx) => {
    let entries;
    try {
      entries = ctx.sessionManager.getEntries();
    } catch {
      return;
    }

    const approval = findUnprocessedPlanApproval(entries);
    if (!approval) return;

    const targetRole = getSettingsValue("pi-roles.defaultRole", "pi-agent");
    writeRoleSwitchRequest(pi, {
      targetRole,
      reason: "plannotator:plan-approved",
      sourceEntryId: approval.entry.id,
    });

    // Use the shared marker so the main plannotator's agent_end
    // handler sees this as already processed.
    pi.appendEntry(PLUG_PLANNOTATOR_AUTOEXECUTE_PROCESSED, {
      sourceEntryId: approval.entry.id,
      timestamp: Date.now(),
    });

    // Force a new turn so pi-roles' before_agent_start fires and
    // consumes the switch request we just wrote.
    pi.sendUserMessage("Continue with the approved plan.");
  });
}
