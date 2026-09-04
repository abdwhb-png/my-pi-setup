import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionContext,
    MessageEndEvent,
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
} from "../_shared/pi-roles.ts";

const HANDOFF_GUARD = "session-plan-persistence";
const SAVED_ENTRY = "session-plan-persistence-guard:saved";
const POLICY_KEY = "session-plan-persistence-guard";
const INTERVENTION_CAP = 5;

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

const SavedEntrySchema = Type.Object({
    type: Type.Literal("custom"),
    customType: Type.Literal(SAVED_ENTRY),
    data: Type.Object({
        role: Type.String({ minLength: 1 }),
        roleAppliedAt: Type.Number(),
    }),
});

type GuardState = {
    saveRequired: boolean;
    pendingFollowUp: boolean;
    interventions: number;
};

function sessionIdentity(ctx: ExtensionContext): string {
    return (
        ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId()
    );
}

function guardedRole(
    ctx: ExtensionContext,
): { name: string; appliedAt: number } | null {
    const active = getActiveRole(ctx.sessionManager.getEntries());
    if (!active) return null;
    const frontmatter = readFrontmatter<{ handoffGuard?: string }>(active.path);
    if (frontmatter?.handoffGuard !== HANDOFF_GUARD) return null;
    return { name: active.name, appliedAt: active.appliedAt };
}

function isFinalAssistantProse(message: AssistantMessage): boolean {
    if (message.content.some((part) => part.type === "toolCall")) return false;
    return message.content.some(
        (part) => part.type === "text" && part.text.trim().length > 0,
    );
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

function hasCurrentRoleSave(
    // oxlint-disable-next-line typescript/no-restricted-types -- pi-roles policies expose session entries as unknown.
    entries: readonly unknown[],
    expectedRole: string,
): boolean {
    const activation = activeRoleActivation(entries);
    if (!activation || activation.name !== expectedRole) return false;

    const activationTimes = new Set<number>();
    const savedActivationTimes = new Set<number>();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (Value.Check(ActiveRoleEntrySchema, entry)) {
            if (entry.data.name !== expectedRole) return false;
            activationTimes.add(entry.data.appliedAt);
            if (savedActivationTimes.has(entry.data.appliedAt)) return true;
            continue;
        }
        if (
            Value.Check(SavedEntrySchema, entry) &&
            entry.data.role === expectedRole
        ) {
            savedActivationTimes.add(entry.data.roleAppliedAt);
            if (activationTimes.has(entry.data.roleAppliedAt)) return true;
        }
    }
    return false;
}

function replacementMessage(message: AssistantMessage): AssistantMessage {
    return {
        ...message,
        content: [
            {
                type: "text",
                text: '[session-plan-persistence-guard] Answer withheld: current planning role did not persist its plan. Call session_plan with action="save", complete Markdown content, and a stable topic. Then present the saved plan.',
            },
        ],
    };
}

export function buildPlanPersistenceFollowUp(): string {
    return (
        "[session-plan-persistence-guard] Do not finalize yet. " +
        'Call session_plan now with action="save", a stable topic, and the complete Markdown plan. ' +
        "After the save succeeds, present that plan to the user."
    );
}

function evaluateTransition(
    input: RoleTransitionPolicyInput,
): RoleTransitionDecision {
    if (input.from?.handoffGuard !== HANDOFF_GUARD) return { allow: true };
    if (hasCurrentRoleSave(input.sessionEntries, input.from.name)) {
        return { allow: true };
    }
    return {
        allow: false,
        reason: "A successful session_plan save is required before leaving this planning role.",
    };
}

function requireSave(
    states: Map<string, GuardState>,
    ctx: ExtensionContext,
): void {
    const role = guardedRole(ctx);
    if (!role) return;
    const id = sessionIdentity(ctx);
    const previous = states.get(id);
    states.set(id, {
        saveRequired: !hasCurrentRoleSave(
            ctx.sessionManager.getEntries(),
            role.name,
        ),
        pendingFollowUp: false,
        interventions: previous?.interventions ?? 0,
    });
}

function recordSave(
    pi: ExtensionAPI,
    states: Map<string, GuardState>,
    event: ToolResultEvent,
    ctx: ExtensionContext,
): void {
    const role = guardedRole(ctx);
    if (!role || !isSuccessfulPlanSave(event)) return;
    states.set(sessionIdentity(ctx), {
        saveRequired: false,
        pendingFollowUp: false,
        interventions: 0,
    });
    pi.appendEntry(SAVED_ENTRY, {
        role: role.name,
        roleAppliedAt: role.appliedAt,
        topic: event.details.topic,
        version: event.details.version,
        timestamp: Date.now(),
    });
}

function withholdUnpersistedAnswer(
    states: Map<string, GuardState>,
    event: MessageEndEvent,
    ctx: ExtensionContext,
): { message: AssistantMessage } | undefined {
    if (!guardedRole(ctx) || event.message.role !== "assistant")
        return undefined;
    if (!isFinalAssistantProse(event.message)) return undefined;
    const id = sessionIdentity(ctx);
    const state = states.get(id) ?? {
        saveRequired: true,
        pendingFollowUp: false,
        interventions: 0,
    };
    states.set(id, state);
    if (!state.saveRequired || state.interventions >= INTERVENTION_CAP) {
        return undefined;
    }
    state.interventions += 1;
    state.pendingFollowUp = true;
    return { message: replacementMessage(event.message) };
}

function consumePendingFollowUp(
    states: Map<string, GuardState>,
    ctx: ExtensionContext,
): boolean {
    if (!guardedRole(ctx)) return false;
    const state = states.get(sessionIdentity(ctx));
    if (!state?.pendingFollowUp) return false;
    state.pendingFollowUp = false;
    return true;
}

export default function registerSessionPlanPersistenceGuard(
    pi: ExtensionAPI,
): void {
    const states = new Map<string, GuardState>();
    const sendUserMessage = pi.sendUserMessage.bind(pi);

    registerRoleTransitionPolicy(evaluateTransition, POLICY_KEY);
    pi.on("before_agent_start", (_event, ctx) => requireSave(states, ctx));
    pi.on("tool_result", (event, ctx) => recordSave(pi, states, event, ctx));
    pi.on("message_end", (event, ctx) =>
        withholdUnpersistedAnswer(states, event, ctx),
    );
    pi.on("turn_end", (_event, ctx) => {
        if (!consumePendingFollowUp(states, ctx)) return;
        sendUserMessage(buildPlanPersistenceFollowUp(), {
            deliverAs: "followUp",
        });
    });
    pi.on("session_shutdown", () => states.clear());
}
