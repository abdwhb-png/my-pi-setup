/**
 * Visibility broker for workflow-scoped tool groups.
 *
 * Sole owner of `setActiveTools` for workflow-group members. Workflow
 * extensions (brainstorm-forcer, sdd-orchestrator) register their own groups
 * programmatically and request activation/deactivation at run start/stop.
 * The broker composes the active set as `baseline ∪ activeWorkflowMembers`
 * and enforces one exclusive workflow lease at a time.
 *
 * Pure module: takes a minimal `ToolControl` (getActiveTools/setActiveTools)
 * so it is fully unit-testable without the pi runtime.
 *
 * `registerWorkflowGroup` intentionally does NOT require members to exist in a
 * frozen tool registry: pi's `setActiveTools` silently ignores unknown tool
 * names anyway, and requiring existence would race against extension load
 * order. Member-list integrity is asserted by exact-count tests in each
 * workflow extension instead.
 */

/** Minimal API surface the broker needs from the extension host. */
export interface ToolControl {
    getActiveTools(): string[];
    setActiveTools(toolNames: string[]): void;
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

function membersOf(groups: WorkflowGroup[], name: string): string[] {
    return findGroup(groups, name)?.members ?? [];
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
            // Preserve original order, dedupe, then append missing workflow members
            const seen = new Set<string>();
            const merged: string[] = [];
            for (const name of active) {
                if (!seen.has(name)) {
                    seen.add(name);
                    merged.push(name);
                }
            }
            for (const name of group.members) {
                if (!seen.has(name)) {
                    seen.add(name);
                    merged.push(name);
                }
            }
            const changed =
                merged.length !== active.length ||
                merged.some((n, i) => n !== active[i]);
            if (changed) {
                control.setActiveTools(merged);
            }
            activeWorkflow = groupName;
            return makeResult(true, changed);
        },

        deactivateWorkflow(
            control: ToolControl,
            groupName: string,
        ): WorkflowResult {
            const members = membersOf(groups, groupName);
            const active = control.getActiveTools();
            const memberSet = new Set(members);
            const target = active.filter((n) => !memberSet.has(n));
            const changed = target.length !== active.length;
            if (changed) {
                control.setActiveTools(target);
            }
            if (activeWorkflow === groupName) {
                activeWorkflow = null;
            }
            return makeResult(true, changed);
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
            control: ToolControl,
            toolNames: string[],
        ): string[] {
            const activeWorkflow = this.getActiveWorkflow(control);
            const activeGroup = findGroup(groups, activeWorkflow ?? "");
            const protectedMembers = new Set(activeGroup?.members ?? []);
            const workflowMembers = new Set<string>();
            for (const g of groups) {
                for (const m of g.members) {
                    workflowMembers.add(m);
                }
            }
            return toolNames.filter(
                (n) => !workflowMembers.has(n) || protectedMembers.has(n),
            );
        },
    };
}

/**
 * Process-lifetime shared broker instance.
 *
 * Workflow extensions (brainstorm, sdd) and tool-groups extension all consume
 * the same instance so the one-exclusive-lease rule holds across extensions.
 * pi loads extensions independently with no wiring seam, so a module singleton
 * is the pragmatic way to share state while keeping `createVisibilityBroker`
 * available for isolated tests.
 */
const SHARED_BROKER_KEY = Symbol.for("pi.workflow-tool-visibility-broker.v1");

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
