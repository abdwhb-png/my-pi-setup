/**
 * Visibility broker for workflow-scoped tool groups.
 *
 * Keep one exclusive workflow lease. Expose its declarative contribution to
 * the shared tool-policy coordinator, which owns active-list calculation.
 * Update the lease before invalidating policy. Do not write Pi tools here.
 */

/** Minimal API surface the broker needs from the extension host. */
import { getToolPolicy } from "../tool-policy/index.ts";
import type { ToolPolicyContribution } from "../tool-policy/index.ts";

export interface ToolControl {
    getActiveTools(): string[];
}

/** Result of a workflow activation/deactivation request. */
export interface WorkflowResult {
    ok: boolean;
    error?: string;
    /** True when the active tool set actually changed. */
    changed: boolean;
}

/** Exclusive lease registry, keyed by group name. */
export interface VisibilityBroker {
    contribution(registered: readonly string[]): ToolPolicyContribution;
    resetSession(): void;
    /**
     * Register a workflow group with its member tool names.
     * A group may be registered once; identical re-registration is a no-op;
     * conflicting re-registration throws. A member may belong to only one
     * workflow group.
     */
    registerWorkflowGroup(groupName: string, members: string[]): void;
    /** Whether a tool name belongs to the given workflow group. */
    isMemberOf(groupName: string, toolName: string): boolean;
    /** Names of all registered workflow groups. */
    getWorkflowGroups(): string[];
    /**
     * Activate a workflow group: add its members to the active set,
     * preserving baseline. Enforces one exclusive lease at a time.
     */
    activateWorkflow(control: ToolControl, groupName: string): WorkflowResult;
    /** Deactivate a workflow group: remove its members, restoring baseline. */
    deactivateWorkflow(control: ToolControl, groupName: string): WorkflowResult;
    /** Which workflow group currently holds the lease, if any. */
    getActiveWorkflow(control: ToolControl): string | null;
    /**
     * Strips every registered workflow group's members from a tool list.
     */
    computeBaseline(toolNames: string[]): string[];
    /**
     * Given a candidate active list, keep only the currently-active workflow
     * group's members; strip every other workflow group's members. When no
     * lease is held, all workflow members are stripped (baseline only).
     */
    reconcileWithLease(control: ToolControl, toolNames: string[]): string[];
}

interface WorkflowGroup {
    name: string;
    members: string[];
}

function findGroup(
    groups: WorkflowGroup[],
    name: string,
): WorkflowGroup | undefined {
    return groups.find((g) => g.name === name);
}

function makeResult(
    ok: boolean,
    changed: boolean,
    error?: string,
): WorkflowResult {
    return { ok, changed, ...(error ? { error } : {}) };
}

export function createVisibilityBroker(): VisibilityBroker {
    const groups: WorkflowGroup[] = [];
    const memberToGroup = new Map<string, string>();
    // Pi creates a distinct ExtensionAPI wrapper for every extension. Lease
    // ownership must therefore be broker-global, not keyed by wrapper identity.
    let activeWorkflow: string | null = null;

    return {
        contribution(registered) {
            const active = findGroup(groups, activeWorkflow ?? "");
            return {
                grants: active
                    ? registered.filter((name) => active.members.includes(name))
                    : [],
                deny: registered.filter(
                    (name) =>
                        memberToGroup.has(name) &&
                        memberToGroup.get(name) !== activeWorkflow,
                ),
            };
        },
        resetSession(): void {
            activeWorkflow = null;
        },
        registerWorkflowGroup(groupName: string, members: string[]): void {
            if (!groupName || !/^[a-z][a-z0-9_-]*$/.test(groupName)) {
                throw new Error(`Invalid workflow group name: ${groupName}`);
            }
            const existing = findGroup(groups, groupName);
            if (existing) {
                // Idempotent for identical re-registration (reload-safe).
                const sameMembers =
                    existing.members.length === members.length &&
                    existing.members.every((m, i) => m === members[i]);
                if (!sameMembers) {
                    throw new Error(
                        `Workflow group already registered: ${groupName}`,
                    );
                }
                return;
            }
            if (members.length === 0) {
                throw new Error(
                    `Workflow group ${groupName} must have members`,
                );
            }
            const seen = new Set<string>();
            for (const member of members) {
                if (seen.has(member)) {
                    throw new Error(
                        `Duplicate member ${member} in workflow group ${groupName}`,
                    );
                }
                seen.add(member);
                const owner = memberToGroup.get(member);
                if (owner && owner !== groupName) {
                    throw new Error(
                        `Tool ${member} already belongs to workflow group ${owner}`,
                    );
                }
            }
            for (const member of members) {
                memberToGroup.set(member, groupName);
            }
            groups.push({ name: groupName, members: [...members] });
        },

        isMemberOf(groupName: string, toolName: string): boolean {
            return memberToGroup.get(toolName) === groupName;
        },

        getWorkflowGroups(): string[] {
            return groups.map((g) => g.name);
        },

        activateWorkflow(
            control: ToolControl,
            groupName: string,
        ): WorkflowResult {
            const group = findGroup(groups, groupName);
            if (!group) {
                return makeResult(
                    false,
                    false,
                    `Unknown workflow group: ${groupName}. Register it first.`,
                );
            }

            const current = this.getActiveWorkflow(control);
            if (current && current !== groupName) {
                return makeResult(
                    false,
                    false,
                    `Workflow ${current} is active. Deactivate it before activating ${groupName}.`,
                );
            }

            const active = control.getActiveTools();
            activeWorkflow = groupName;
            getToolPolicy().refresh();
            const next = control.getActiveTools();
            return makeResult(
                true,
                active.length !== next.length ||
                    active.some((name, index) => name !== next[index]),
            );
        },

        deactivateWorkflow(
            control: ToolControl,
            groupName: string,
        ): WorkflowResult {
            const active = control.getActiveTools();
            if (activeWorkflow === groupName) {
                activeWorkflow = null;
            }
            getToolPolicy().refresh();
            const next = control.getActiveTools();
            return makeResult(
                true,
                active.length !== next.length ||
                    active.some((name, index) => name !== next[index]),
            );
        },

        getActiveWorkflow(_control: ToolControl): string | null {
            return activeWorkflow;
        },

        computeBaseline(toolNames: string[]): string[] {
            const workflowMembers = new Set<string>();
            for (const g of groups) {
                for (const m of g.members) {
                    workflowMembers.add(m);
                }
            }
            return toolNames.filter((n) => !workflowMembers.has(n));
        },

        reconcileWithLease(
            _control: ToolControl,
            toolNames: string[],
        ): string[] {
            const denied = new Set(this.contribution(toolNames).deny);
            return toolNames.filter((name) => !denied.has(name));
        },
    };
}

/**
 * Process-lifetime shared broker instance.
 *
 * Workflow extensions (brainstorm, sdd) and tool-groups extension all consume
 * the same instance so the one-exclusive-lease rule holds across extensions.
 * Share state through globalThis and Symbol.for because Pi uses independent
 * Jiti module caches. Keep createVisibilityBroker available for isolated tests.
 */
// v2 adds the declarative contribution/reset contract. Keep it isolated from
// v1 objects that can remain on globalThis across an in-process Pi reload.
const SHARED_BROKER_KEY = Symbol.for("pi.workflow-tool-visibility-broker.v2");

type BrokerGlobal = typeof globalThis & {
    [SHARED_BROKER_KEY]?: VisibilityBroker;
};

export function getSharedVisibilityBroker(): VisibilityBroker {
    const processGlobal = globalThis as BrokerGlobal;
    if (!processGlobal[SHARED_BROKER_KEY]) {
        processGlobal[SHARED_BROKER_KEY] = createVisibilityBroker();
    }
    return processGlobal[SHARED_BROKER_KEY];
}
