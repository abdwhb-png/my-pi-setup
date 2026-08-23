// oxlint-disable typescript/no-restricted-types -- Pi tool results and session entries intentionally expose unknown at extension boundaries.
import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
    loadPlannotatorConfig,
    resolvePlanFileDir,
} from "@plannotator/pi-extension/config.js";
import {
    getActiveRole,
    readFrontmatter,
    registerRoleTransitionPolicy,
} from "../_shared/pi-roles.ts";
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

const HANDOFF_GUARD = "plan-submission";
const POLICY_KEY = "pi-roles-addons.plan-submission-guard";

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

function getPlanDir(cwd: string): string | undefined {
    const config = loadPlannotatorConfig(cwd);
    return resolvePlanFileDir(config.config);
}

function requiresPlanSubmission(ctx: ExtensionContext): boolean {
    const active = getActiveRole(ctx.sessionManager.getEntries());
    if (!active) return false;
    const frontmatter = readFrontmatter<{ handoffGuard?: unknown }>(
        active.path,
    );
    return frontmatter?.handoffGuard === HANDOFF_GUARD;
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

function pendingStates(entries: readonly LifecycleEntry[]): PlanReviewState[] {
    return listPlanReviewStates(entries).filter(
        (state) => state.status !== "approved" && state.status !== "abandoned",
    );
}

function appendRevision(
    pi: ExtensionAPI,
    event: ToolResultEvent,
    ctx: ExtensionContext,
): void {
    const rawPath = readString(event.input, "path");
    const planDir = getPlanDir(ctx.cwd);
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
    const planDir = getPlanDir(ctx.cwd);
    if (!rawPath || approved === null || !planDir) return;
    const path = normalizeSubmittedPlanPath(rawPath, ctx.cwd, planDir);
    if (!path) return;

    const entries = ctx.sessionManager.getEntries();
    if (event.toolCallId && wasToolCallRecorded(entries, event.toolCallId))
        return;
    const state = getPlanReviewState(entries, path);
    if (!state) return;
    pi.appendEntry(PLAN_REVIEW_SUBMITTED_ENTRY, {
        path,
        revision: state.revision,
        approved,
        toolCallId: event.toolCallId,
        timestamp: Date.now(),
    });
}

export default function registerPlanSubmissionGuard(pi: ExtensionAPI): void {
    let currentCwd: string | null = null;
    const reminded = new Set<string>();

    registerRoleTransitionPolicy((input: RoleTransitionPolicyInput) => {
        if (input.from?.handoffGuard !== HANDOFF_GUARD) {
            return { allow: true };
        }
        if (input.to.handoffGuard === HANDOFF_GUARD) {
            return { allow: true };
        }
        if (!currentCwd) {
            return {
                allow: false,
                reason: "Plan review guard is not initialized for this session.",
            };
        }

        const pending = pendingStates(asLifecycleEntries(input.sessionEntries));
        if (pending.length === 0) return { allow: true };
        const paths = pending.map((state) => state.path).join(", ");
        return {
            allow: false,
            reason: `Plan review required for ${paths}. Submit it or abandon it explicitly.`,
        };
    }, POLICY_KEY);

    pi.on("session_start", (_event, ctx) => {
        currentCwd = ctx.cwd;
    });

    pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) => {
        currentCwd = ctx.cwd;
        if (event.isError || !requiresPlanSubmission(ctx)) return;
        if (event.toolName === "write_plan" || event.toolName === "edit_plan") {
            appendRevision(pi, event, ctx);
        }
        if (event.toolName === "plan_submit") {
            appendSubmission(pi, event, ctx);
        }
    });

    pi.on("turn_end", (_event, ctx) => {
        currentCwd = ctx.cwd;
        if (!ctx.hasUI || !requiresPlanSubmission(ctx)) return;
        for (const state of pendingStates(ctx.sessionManager.getEntries())) {
            const key = `${state.path}:${state.revision}`;
            if (reminded.has(key)) continue;
            reminded.add(key);
            ctx.ui.notify(
                `Plan review pending for ${state.path}. Submit it with plan_submit or abandon it explicitly.`,
                "warning",
            );
        }
    });

    pi.registerCommand("abandon-plan", {
        description:
            "Explicitly abandon one tracked plan revision before leaving a guarded planning role",
        handler: async (args, ctx: ExtensionCommandContext) => {
            currentCwd = ctx.cwd;
            if (!requiresPlanSubmission(ctx)) {
                ctx.ui.notify("No plan-submission guard is active.", "info");
                return;
            }
            const planDir = getPlanDir(ctx.cwd);
            const path = planDir
                ? normalizeSubmittedPlanPath(args, ctx.cwd, planDir)
                : null;
            if (!path) {
                ctx.ui.notify(
                    "Provide a plan path inside the configured plan directory.",
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
            if (!ctx.hasUI) {
                throw new Error(
                    "Abandoning a plan requires an interactive confirmation.",
                );
            }
            const confirmed = await ctx.ui.confirm(
                "Abandon plan revision",
                `Allow leaving the planning workflow without approving ${path} revision ${state.revision}? The file will remain on disk.`,
            );
            if (!confirmed) return;
            pi.appendEntry(PLAN_REVIEW_ABANDONED_ENTRY, {
                path,
                revision: state.revision,
                timestamp: Date.now(),
            });
            ctx.ui.notify(
                `Abandoned ${path} revision ${state.revision}.`,
                "info",
            );
        },
    });
}
