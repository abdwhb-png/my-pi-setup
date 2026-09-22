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
 * Writes local processed markers, while recognizing legacy Plannotator
 * approvals and deduplication markers when old sessions are resumed.
 *
 * pi-roles remains the sole owner of `state.activeRole` and the
 * system prompt. This extension's only job is detecting the approval
 * and forwarding it as a typed protocol request at the earliest
 * possible moment.
 */

import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    findUnprocessedSwitchRequest,
    isPlanApprovalReason,
    writeRoleSwitchRequest,
} from "../../_shared/pi-roles/index.ts";
import { loadSettings } from "../core/settings.ts";
import {
    createLatestIdleTaskScheduler,
    queueWhenIdle,
    type IdleTaskScheduler,
} from "../../_shared/queue-when-idle.ts";

/** Custom entry type emitted by the local plans extension. */
const PLAN_APPROVED_ENTRY_TYPE = "plans:approved";

/**
 * Legacy fork marker, read only for backward-compatible deduplication.
 */
export const PLUG_PLANNOTATOR_AUTOEXECUTE_PROCESSED =
    "plannotator-autoexecute-processed";

/**
 * Local marker for handled approvals.
 */
export const PROCESSED_MARKER_PREFIX = "plan-auto-switch:processed";

const APPROVED_PLAN_CONTINUATION = "Continue with the approved plan.";
const PLAN_APPROVED_SWITCH_REASON = "plans:approved";

/**
 * Start a fresh top-level prompt after the current agent run becomes idle.
 *
 * A follow-up is consumed by `agent.continue()`, which bypasses
 * `before_agent_start`; pi-roles therefore cannot consume its switch request.
 * Bare `sendUserMessage` is correct only after Pi clears its active run.
 */
export function queueApprovedPlanContinuation(
    pi: Pick<ExtensionAPI, "sendUserMessage">,
    isIdle: () => boolean = () => true,
    schedule?: IdleTaskScheduler,
): void {
    queueWhenIdle(
        () => {
            pi.sendUserMessage(APPROVED_PLAN_CONTINUATION);
        },
        isIdle,
        schedule,
    );
}

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
        if (
            !e ||
            e.type !== "custom" ||
            (e.customType !== PLAN_APPROVED_ENTRY_TYPE &&
                e.customType !== "plannotator:plan-approved")
        )
            continue;

        const data = (e.data ?? {}) as PlanApprovedPayload;
        if (data.approved !== true) continue;

        // Check both our legacy marker and the shared marker
        const processed = entries.slice(i + 1).some(
            (p) =>
                p &&
                p.type === "custom" &&
                (p.customType === PROCESSED_MARKER_PREFIX ||
                    p.customType === PLUG_PLANNOTATOR_AUTOEXECUTE_PROCESSED) &&
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pi entry data is unknown
                (p.data as { sourceEntryId?: string } | undefined)
                    ?.sourceEntryId === e.id,
        );

        if (!processed) {
            return { entry: { id: e.id }, data };
        }
    }
    return null;
}

export default function planAutoSwitch(pi: ExtensionAPI): void {
    const continuationScheduler = createLatestIdleTaskScheduler();

    const reconcileApprovedPlanSwitch = (ctx: ExtensionContext): void => {
        let entries;
        try {
            entries = ctx.sessionManager.getEntries();
        } catch {
            continuationScheduler.invalidate();
            return;
        }

        const pending = findUnprocessedSwitchRequest(entries);
        if (!pending || !isPlanApprovalReason(pending.data.reason)) {
            continuationScheduler.invalidate();
            return;
        }

        const requestEntryId = pending.entry.id;
        continuationScheduler.schedule(
            () => {
                let latestEntries;
                try {
                    latestEntries = ctx.sessionManager.getEntries();
                } catch {
                    return;
                }

                const latestPending =
                    findUnprocessedSwitchRequest(latestEntries);
                if (
                    latestPending?.entry.id !== requestEntryId ||
                    !isPlanApprovalReason(latestPending.data.reason)
                ) {
                    return;
                }

                pi.sendUserMessage(APPROVED_PLAN_CONTINUATION);
            },
            () => ctx.isIdle(),
        );
    };

    pi.on("turn_end", async (_event, ctx) => {
        let entries;
        try {
            entries = ctx.sessionManager.getEntries();
        } catch {
            return;
        }

        const approval = findUnprocessedPlanApproval(entries);
        if (!approval) return;

        let targetRole: string;
        try {
            targetRole =
                loadSettings(ctx.cwd, ctx.isProjectTrusted())
                    .planApprovedRole ?? "pi-agent";
        } catch (error) {
            pi.appendEntry(PROCESSED_MARKER_PREFIX, {
                sourceEntryId: approval.entry.id,
                error: String(error),
                timestamp: Date.now(),
            });
            ctx.ui.notify(
                `Cannot switch after plan approval: ${String(error)}`,
                "error",
            );
            return;
        }
        writeRoleSwitchRequest(pi, {
            targetRole,
            reason: PLAN_APPROVED_SWITCH_REASON,
            sourceEntryId: approval.entry.id,
        });

        // Persist consumption before queuing the fresh implementation turn.
        pi.appendEntry(PROCESSED_MARKER_PREFIX, {
            sourceEntryId: approval.entry.id,
            timestamp: Date.now(),
        });
    });

    pi.on("agent_end", (_event, ctx) => {
        reconcileApprovedPlanSwitch(ctx);
    });

    pi.on("session_start", (_event, ctx) => {
        reconcileApprovedPlanSwitch(ctx);
    });
    pi.on("session_shutdown", () => continuationScheduler.invalidate());
}
