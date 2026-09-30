// oxlint-disable typescript/no-restricted-types -- Pi tool results and session entries intentionally expose unknown at extension boundaries.
import { resolve } from "node:path";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
    requiresPlanSubmission as roleRequiresPlanSubmission,
    registerRoleTransitionPolicy,
} from "../_shared/pi-roles/index.ts";
import {
    loadPlansConfig,
    resolvePlanFileDir,
} from "../_shared/plans-config.ts";
import { getToolPolicy } from "../_shared/tool-policy/index.ts";
import {
    getPlanReviewState,
    listPlanReviewStates,
    nextPlanRevision,
    normalizeSubmittedPlanPath,
    normalizeWrittenPlanPath,
    PLAN_REVIEW_ABANDONED_ENTRY,
    PLAN_REVIEW_REVISION_ENTRY,
    PLAN_REVIEW_SUBMITTED_ENTRY,
    type PlanReviewState,
} from "./plan-submission-lifecycle.ts";
import type { SubmissionReviews } from "./plannotator-review.ts";

const HANDOFF_GUARD = "plan-submission";
// Keep the registration key across relocation so a Pi reload replaces the old handler.
const POLICY_KEY = "pi-roles.plan-submission-guard";

function isPending(state: PlanReviewState): boolean {
    return state.status === "draft" || state.status === "submitted-denied";
}

type LifecycleEntry = {
    type: string;
    customType?: string;
    data?: unknown;
};

type RoleTransitionPolicyInput = {
    from: { handoffGuard?: string } | null;
    to: { handoffGuard?: string };
    sessionEntries: readonly unknown[];
};

function asLifecycleEntries(entries: readonly unknown[]): LifecycleEntry[] {
    return entries.filter(
        (entry): entry is LifecycleEntry =>
            typeof entry === "object" &&
            entry !== null &&
            "type" in entry &&
            typeof entry.type === "string",
    );
}

function getPlanDir(ctx: ExtensionContext): string | undefined {
    return resolvePlanFileDir(loadPlansConfig(ctx.cwd, ctx.isProjectTrusted()));
}

function requiresPlanSubmission(): boolean {
    return roleRequiresPlanSubmission(getToolPolicy().getRole());
}

function readString(
    input: Record<string, unknown>,
    key: string,
): string | null {
    const value = input[key];
    return typeof value === "string" ? value : null;
}

function readApproved(details: unknown): boolean | null {
    if (!details || typeof details !== "object") return null;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validated custom tool-result boundary.
    const approved = (details as { approved?: unknown }).approved;
    return typeof approved === "boolean" ? approved : null;
}

function wasToolCallRecorded(
    entries: readonly LifecycleEntry[],
    toolCallId: string,
): boolean {
    return entries.some((entry) => {
        if (
            entry.type !== "custom" ||
            (entry.customType !== PLAN_REVIEW_REVISION_ENTRY &&
                entry.customType !== PLAN_REVIEW_SUBMITTED_ENTRY)
        ) {
            return false;
        }
        if (!entry.data || typeof entry.data !== "object") return false;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validated custom session-entry boundary.
        return (
            (entry.data as { toolCallId?: unknown }).toolCallId === toolCallId
        );
    });
}

function appendRevision(
    pi: ExtensionAPI,
    event: ToolResultEvent,
    ctx: ExtensionContext,
): void {
    const rawPath = readString(event.input, "path");
    const planDir = getPlanDir(ctx);
    if (!rawPath || !planDir) return;
    const path = normalizeWrittenPlanPath(rawPath, ctx.cwd, planDir);
    if (!path) return;

    const entries = ctx.sessionManager.getEntries();
    if (event.toolCallId && wasToolCallRecorded(entries, event.toolCallId))
        return;
    pi.appendEntry(PLAN_REVIEW_REVISION_ENTRY, {
        path,
        revision: nextPlanRevision(entries, path),
        operation: event.toolName,
        toolCallId: event.toolCallId,
        timestamp: Date.now(),
    });
}

function appendSubmission(
    pi: ExtensionAPI,
    event: ToolResultEvent,
    ctx: ExtensionContext,
): void {
    const rawPath = readString(event.input, "filePath");
    const approved = readApproved(event.details);
    const planDir = getPlanDir(ctx);
    if (!rawPath || approved === null || !planDir) return;
    const path = normalizeSubmittedPlanPath(rawPath, ctx.cwd, planDir);
    if (!path) return;

    const entries = ctx.sessionManager.getEntries();
    if (event.toolCallId && wasToolCallRecorded(entries, event.toolCallId))
        return;
    const state = getPlanReviewState(entries, path);
    if (!state || state.status === "abandoned") return;
    pi.appendEntry(PLAN_REVIEW_SUBMITTED_ENTRY, {
        path,
        revision: state.revision,
        approved,
        toolCallId: event.toolCallId,
        timestamp: Date.now(),
    });
}

export default function registerPlanSubmissionGuard(
    pi: ExtensionAPI,
    reviews: SubmissionReviews,
): void {
    let currentContext: ExtensionContext | null = null;

    registerRoleTransitionPolicy((input: RoleTransitionPolicyInput) => {
        if (input.from?.handoffGuard !== HANDOFF_GUARD) {
            return { allow: true };
        }
        if (input.to.handoffGuard === HANDOFF_GUARD) {
            return { allow: true };
        }
        if (!currentContext) {
            return {
                allow: false,
                reason: "Plan review guard is not initialized for this session.",
            };
        }

        const states = listPlanReviewStates(
            asLifecycleEntries(input.sessionEntries),
        );
        if (states.length === 0) {
            return {
                allow: false,
                reason: "An approved plan revision is required before leaving this planning role.",
            };
        }

        const pending = states.filter(isPending);
        if (pending.length === 0) return { allow: true };
        const paths = pending.map((state) => state.path).join(", ");
        return {
            allow: false,
            reason: `Plan approval required for ${paths}. Submit it for approval before leaving this planning role.`,
        };
    }, POLICY_KEY);

    pi.on("session_start", (_event, ctx) => {
        currentContext = ctx;
    });
    pi.on("session_shutdown", () => {
        currentContext = null;
    });

    pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) => {
        currentContext = ctx;
        if (event.isError || !requiresPlanSubmission()) return;
        if (event.toolName === "write_plan" || event.toolName === "edit_plan") {
            appendRevision(pi, event, ctx);
        }
        // Old tool results can still appear when an existing session resumes.
        if (
            event.toolName === "submit_plan" ||
            event.toolName === "plan_submit"
        ) {
            appendSubmission(pi, event, ctx);
        }
    });

    pi.registerCommand("abandon-plan", {
        description:
            "Pause a pending plan and cancel its review: /abandon-plan [plan-path]. Omit the path for the active submission.",
        getArgumentCompletions: (prefix) => {
            const ctx = currentContext;
            if (!ctx || !requiresPlanSubmission()) return null;
            return listPlanReviewStates(ctx.sessionManager.getEntries())
                .filter(isPending)
                .map((state) => ({
                    value: state.path.startsWith("../")
                        ? resolve(ctx.cwd, state.path)
                        : state.path,
                    label: state.path,
                    description: `Revision ${state.revision} · ${state.status}`,
                }))
                .filter((item) => item.value.startsWith(prefix));
        },
        handler: async (args, ctx: ExtensionCommandContext) => {
            currentContext = ctx;
            if (!requiresPlanSubmission()) {
                ctx.ui.notify("No plan-submission guard is active.", "info");
                return;
            }
            const sessionId = ctx.sessionManager.getSessionId();
            const active = reviews.getActiveSubmission(ctx);
            const planDir = getPlanDir(ctx);
            const path = !args.trim()
                ? active?.path
                : planDir
                  ? normalizeSubmittedPlanPath(args, ctx.cwd, planDir)
                  : null;
            if (!path) {
                ctx.ui.notify(
                    "Provide a pending plan path inside the configured plan directory; use /abandon-plan autocomplete to choose one.",
                    "warning",
                );
                return;
            }
            const state = getPlanReviewState(
                ctx.sessionManager.getEntries(),
                path,
            );
            if (!state) {
                ctx.ui.notify(
                    `No tracked plan revision exists for ${path}.`,
                    "warning",
                );
                return;
            }
            if (!isPending(state)) {
                ctx.ui.notify(
                    `Plan ${path} is already ${state.status}.`,
                    "info",
                );
                return;
            }
            if (!ctx.hasUI) {
                throw new Error(
                    "Abandoning a plan requires an interactive confirmation.",
                );
            }
            const confirmed = await ctx.ui.confirm(
                "Abandon plan revision",
                `Pause ${path} revision ${state.revision}? The file will remain on disk. This revision will no longer require approval before a manual role switch.`,
            );
            if (!confirmed) return;
            const latest = getPlanReviewState(
                ctx.sessionManager.getEntries(),
                path,
            );
            const activeNow = reviews.getActiveSubmission(ctx);
            if (
                ctx.signal?.aborted ||
                ctx.sessionManager.getSessionId() !== sessionId ||
                !requiresPlanSubmission() ||
                latest?.revision !== state.revision ||
                latest.status !== state.status ||
                ((active?.path === path || activeNow?.path === path) &&
                    active !== activeNow)
            ) {
                ctx.ui.notify(
                    "Plan or session changed during confirmation; nothing was abandoned. Try again.",
                    "warning",
                );
                return;
            }
            pi.appendEntry(PLAN_REVIEW_ABANDONED_ENTRY, {
                path,
                revision: state.revision,
                timestamp: Date.now(),
            });
            const notice = `I have abandoned ${path} revision ${state.revision} for now. Keep the saved file and pause planning. Do not resubmit or implement it unless I explicitly ask.`;
            if (ctx.isIdle()) {
                // A fresh prompt would consume an unrelated paused approval's role switch.
                pi.sendMessage(
                    {
                        customType: "plans:abandoned",
                        content: notice,
                        display: true,
                    },
                    { triggerTurn: false },
                );
            } else {
                pi.sendUserMessage(notice, { deliverAs: "followUp" });
            }
            if (active?.path === path) reviews.abandonSubmission(ctx, active);
            ctx.ui.notify(
                `Abandoned ${path} revision ${state.revision}.`,
                "info",
            );
        },
    });
}
