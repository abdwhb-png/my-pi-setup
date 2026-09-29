import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
    ACTIVE_ROLE_ENTRY_TYPE,
    getActiveRole,
    readFrontmatter,
    registerRoleTransitionPolicy,
    type RoleTransitionDecision,
    type RoleTransitionPolicyInput,
} from "../../_shared/pi-roles/index.ts";

const HANDOFF_GUARD = "session-plan-persistence";
const SAVED_ENTRY = "session-plan-persistence-guard:saved";
const ABANDONED_ENTRY = "session-plan-persistence-guard:abandoned";
const POLICY_KEY = "pi-roles.session-plan-persistence-guard";

const SuccessfulSaveDetailsSchema = Type.Object({
    action: Type.Literal("save"),
    topic: Type.String({ minLength: 1 }),
    version: Type.Integer({ minimum: 1 }),
    exists: Type.Literal(true),
});

const ActiveRoleEntrySchema = Type.Object({
    type: Type.Literal("custom"),
    customType: Type.Literal(ACTIVE_ROLE_ENTRY_TYPE),
    data: Type.Object({
        name: Type.String({ minLength: 1 }),
        appliedAt: Type.Number(),
    }),
});

const ResolutionEntryDataSchema = Type.Object({
    role: Type.String({ minLength: 1 }),
    roleAppliedAt: Type.Number(),
});

// A guarded planning turn is resolved by exactly two operator-visible facts:
// the plan was persisted, or the operator explicitly abandoned planning.
const ResolutionEntrySchema = Type.Union([
    Type.Object({
        type: Type.Literal("custom"),
        customType: Type.Literal(SAVED_ENTRY),
        data: ResolutionEntryDataSchema,
    }),
    Type.Object({
        type: Type.Literal("custom"),
        customType: Type.Literal(ABANDONED_ENTRY),
        data: ResolutionEntryDataSchema,
    }),
]);

function guardedRole(
    ctx: ExtensionContext,
): { name: string; appliedAt: number } | null {
    const active = getActiveRole(ctx.sessionManager.getEntries());
    if (!active) return null;
    const frontmatter = readFrontmatter<{ handoffGuard?: string }>(active.path);
    if (frontmatter?.handoffGuard !== HANDOFF_GUARD) return null;
    return { name: active.name, appliedAt: active.appliedAt };
}

function isSuccessfulPlanSave(event: {
    toolName: string;
    isError: boolean;
    // oxlint-disable-next-line typescript/no-restricted-types -- Pi tool-result details are unknown at the package boundary.
    details?: unknown;
}): event is typeof event & {
    details: {
        action: "save";
        topic: string;
        version: number;
        exists: true;
    };
} {
    if (event.toolName !== "session_plan" || event.isError) return false;
    if (!Value.Check(SuccessfulSaveDetailsSchema, event.details)) return false;
    return event.details.topic.trim().length > 0;
}

function activeRoleActivation(
    // oxlint-disable-next-line typescript/no-restricted-types -- pi-roles policies expose session entries as unknown.
    entries: readonly unknown[],
): { name: string; appliedAt: number; index: number } | null {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (!Value.Check(ActiveRoleEntrySchema, entry)) continue;
        return {
            name: entry.data.name,
            appliedAt: entry.data.appliedAt,
            index,
        };
    }
    return null;
}

function hasCurrentRoleResolution(
    // oxlint-disable-next-line typescript/no-restricted-types -- pi-roles policies expose session entries as unknown.
    entries: readonly unknown[],
    expectedRole: string,
): boolean {
    const activation = activeRoleActivation(entries);
    if (!activation || activation.name !== expectedRole) return false;

    const activationTimes = new Set<number>();
    const resolvedActivationTimes = new Set<number>();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (Value.Check(ActiveRoleEntrySchema, entry)) {
            if (entry.data.name !== expectedRole) return false;
            activationTimes.add(entry.data.appliedAt);
            if (resolvedActivationTimes.has(entry.data.appliedAt)) return true;
            continue;
        }
        if (
            Value.Check(ResolutionEntrySchema, entry) &&
            entry.data.role === expectedRole
        ) {
            resolvedActivationTimes.add(entry.data.roleAppliedAt);
            if (activationTimes.has(entry.data.roleAppliedAt)) return true;
        }
    }
    return false;
}

function evaluateTransition(
    input: RoleTransitionPolicyInput,
): RoleTransitionDecision {
    if (input.from?.handoffGuard !== HANDOFF_GUARD) return { allow: true };
    if (hasCurrentRoleResolution(input.sessionEntries, input.from.name)) {
        return { allow: true };
    }
    return {
        allow: false,
        reason: "A successful session_plan save or /session-plan-abandon is required before leaving this planning role.",
    };
}

function recordSave(
    pi: ExtensionAPI,
    event: ToolResultEvent,
    ctx: ExtensionContext,
): void {
    const role = guardedRole(ctx);
    if (!role || !isSuccessfulPlanSave(event)) return;
    pi.appendEntry(SAVED_ENTRY, {
        role: role.name,
        roleAppliedAt: role.appliedAt,
        topic: event.details.topic,
        version: event.details.version,
        timestamp: Date.now(),
    });
}

export default function registerSessionPlanPersistenceGuard(
    pi: ExtensionAPI,
): void {
    registerRoleTransitionPolicy(evaluateTransition, POLICY_KEY);

    // This guard owns the handoff boundary only. It never withholds, rewrites,
    // or delays an assistant answer: a planning role that is asked to stop and
    // explain must be able to answer without first manufacturing a plan.
    pi.on("tool_result", (event, ctx) => recordSave(pi, event, ctx));

    pi.registerCommand("session-plan-abandon", {
        description:
            "Release the session-plan persistence guard for the current planning role without saving a plan. /session-plan-abandon",
        handler: async (_args, ctx: ExtensionCommandContext) => {
            const role = guardedRole(ctx);
            if (!role) {
                ctx.ui.notify(
                    "No session-plan persistence guard is active.",
                    "info",
                );
                return;
            }
            if (!ctx.hasUI) {
                throw new Error(
                    "Abandoning the session plan requires an interactive confirmation.",
                );
            }
            const confirmed = await ctx.ui.confirm(
                "Abandon planning",
                `Release the plan-persistence guard for "${role.name}"? Saved plans stay on disk.`,
            );
            if (!confirmed) return;
            pi.appendEntry(ABANDONED_ENTRY, {
                role: role.name,
                roleAppliedAt: role.appliedAt,
                timestamp: Date.now(),
            });
            ctx.ui.notify(
                `Released the plan-persistence guard for "${role.name}".`,
                "info",
            );
        },
    });
}
