import { describe, expect, it } from 'bun:test';
import {
    createVisibilityBroker,
    getSharedVisibilityBroker,
} from './broker.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeControl(
    initial: string[] = ['read', 'edit', 'write'],
): {
    control: {
        getActiveTools(): string[];
        setActiveTools(names: string[]): void;
    };
    active: () => string[];
} {
    let activeTools = [...initial];
    return {
        control: {
            getActiveTools: () => [...activeTools],
            setActiveTools: (names: string[]) => {
                activeTools = [...names];
            },
        },
        active: () => [...activeTools],
    };
}

function makeBroker(): ReturnType<typeof createVisibilityBroker> {
    return createVisibilityBroker();
}

describe('getSharedVisibilityBroker', () => {
    it('returns the same instance across calls', () => {
        const a = getSharedVisibilityBroker();
        const b = getSharedVisibilityBroker();
        expect(a).toBe(b);
    });
});

// ---------------------------------------------------------------------------
// registerWorkflowGroup
// ---------------------------------------------------------------------------

describe('createVisibilityBroker.registerWorkflowGroup', () => {
    it('registers a workflow group with its member names', () => {
        const broker = makeBroker();
        broker.registerWorkflowGroup('brainstorm', [
            'brainstorm_submit_discovery',
            'brainstorm_transition',
        ]);
        expect(broker.getWorkflowGroups()).toEqual([
            'brainstorm',
        ]);
        expect(
            broker.isMemberOf(
                'brainstorm',
                'brainstorm_submit_discovery',
            ),
        ).toBe(true);
    });

    it('rejects an invalid group name', () => {
        const broker = makeBroker();
        expect(() => broker.registerWorkflowGroup('has space', ['read'])).toThrow(
            /invalid workflow group name/i,
        );
        expect(() => broker.registerWorkflowGroup('', ['read'])).toThrow(
            /invalid workflow group name/i,
        );
    });

    it('rejects a group with no members', () => {
        const broker = makeBroker();
        expect(() => broker.registerWorkflowGroup('brainstorm', [])).toThrow(
            /must have members/i,
        );
    });

    it('is idempotent for identical re-registration', () => {
        const broker = makeBroker();
        broker.registerWorkflowGroup('brainstorm', ['read']);
        expect(() =>
            broker.registerWorkflowGroup('brainstorm', ['read']),
        ).not.toThrow();
    });

    it('rejects conflicting re-registration of the same group name', () => {
        const broker = makeBroker();
        broker.registerWorkflowGroup('brainstorm', ['read']);
        expect(() =>
            broker.registerWorkflowGroup('brainstorm', ['edit']),
        ).toThrow(/already registered/i);
    });

    it('rejects overlapping membership across workflow groups', () => {
        const broker = makeBroker();
        broker.registerWorkflowGroup('brainstorm', ['read', 'edit']);
        expect(() =>
            broker.registerWorkflowGroup('sdd', ['edit', 'write']),
        ).toThrow(/already belongs to workflow group/i);
    });

    it('isMemberOf returns false for unknown group or member', () => {
        const broker = makeBroker();
        broker.registerWorkflowGroup('brainstorm', ['read']);
        expect(broker.isMemberOf('brainstorm', 'edit')).toBe(false);
        expect(broker.isMemberOf('nope', 'read')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// activateWorkflow / deactivateWorkflow
// ---------------------------------------------------------------------------

describe('createVisibilityBroker.activateWorkflow', () => {
    it('adds workflow members to the current active set, preserving baseline (exclusive lease)', () => {
        const { control, active } = makeControl(['read', 'edit', 'write']);
        const broker = makeBroker();
        broker.registerWorkflowGroup('brainstorm', [
            'brainstorm_submit_discovery',
        ]);

        const result = broker.activateWorkflow(control, 'brainstorm');
        expect(result.ok).toBe(true);
        expect(active().sort()).toEqual([
            'brainstorm_submit_discovery',
            'edit',
            'read',
            'write',
        ]);
    });

    it('refuses to activate a second exclusive workflow while one is active', () => {
        const { control, active } = makeControl(['read']);
        const broker = makeBroker();
        broker.registerWorkflowGroup('brainstorm', [
            'brainstorm_submit_discovery',
        ]);
        broker.registerWorkflowGroup('sdd', ['sdd_prepare']);

        expect(broker.activateWorkflow(control, 'brainstorm').ok).toBe(true);
        const second = broker.activateWorkflow(control, 'sdd');
        expect(second.ok).toBe(false);
        expect(second.error).toMatch(/exclusive|active/i);
        // active set still has brainstorm, not sdd
        expect(active().sort()).toEqual([
            'brainstorm_submit_discovery',
            'read',
        ]);
    });

    it('enforces one lease across distinct extension API wrappers', () => {
        const { control: brainstormControl } = makeControl(['read']);
        const { control: sddControl } = makeControl(['read']);
        const broker = makeBroker();
        broker.registerWorkflowGroup('brainstorm', [
            'brainstorm_submit_discovery',
        ]);
        broker.registerWorkflowGroup('sdd', ['sdd_prepare']);

        expect(
            broker.activateWorkflow(brainstormControl, 'brainstorm').ok,
        ).toBe(true);
        const second = broker.activateWorkflow(sddControl, 'sdd');

        expect(second.ok).toBe(false);
        expect(broker.getActiveWorkflow(sddControl)).toBe('brainstorm');
    });

    it('is idempotent for the same already-active workflow', () => {
        const { control } = makeControl(['read']);
        const broker = makeBroker();
        broker.registerWorkflowGroup('brainstorm', [
            'brainstorm_submit_discovery',
        ]);
        expect(broker.activateWorkflow(control, 'brainstorm').ok).toBe(true);
        expect(broker.activateWorkflow(control, 'brainstorm').ok).toBe(true);
    });

    it('rejects unknown workflow group', () => {
        const { control } = makeControl(['read']);
        const broker = makeBroker();
        const result = broker.activateWorkflow(control, 'nope');
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/unknown|not registered/i);
    });
});

describe('createVisibilityBroker.deactivateWorkflow', () => {
    it('removes workflow members from active set, restoring baseline', () => {
        const { control, active } = makeControl(['read', 'edit', 'write']);
        const broker = makeBroker();
        broker.registerWorkflowGroup('brainstorm', [
            'brainstorm_submit_discovery',
        ]);
        broker.activateWorkflow(control, 'brainstorm');
        expect(active()).toContain('brainstorm_submit_discovery');

        expect(broker.deactivateWorkflow(control, 'brainstorm').ok).toBe(true);
        expect(active().sort()).toEqual(['edit', 'read', 'write']);
    });

    it('is a no-op success when no lease is active', () => {
        const { control, active } = makeControl(['read']);
        const broker = makeBroker();
        const result = broker.deactivateWorkflow(control, 'brainstorm');
        expect(result.ok).toBe(true);
        expect(active()).toEqual(['read']);
    });
});

// ---------------------------------------------------------------------------
// computeBaseline
// ---------------------------------------------------------------------------

describe('createVisibilityBroker.computeBaseline', () => {
    it('strips all workflow members from a tool list, preserving others', () => {
        const broker = makeBroker();
        broker.registerWorkflowGroup('brainstorm', [
            'brainstorm_submit_discovery',
        ]);
        broker.registerWorkflowGroup('sdd', ['sdd_prepare']);

        const baseline = broker.computeBaseline([
            'read',
            'write',
            'brainstorm_submit_discovery',
            'sdd_prepare',
        ]);
        expect(baseline.sort()).toEqual(['read', 'write']);
    });

    it('leaves non-workflow tools untouched', () => {
        const broker = makeBroker();
        const baseline = broker.computeBaseline(['read', 'edit', 'write']);
        expect(baseline.sort()).toEqual(['edit', 'read', 'write']);
    });
});

describe('createVisibilityBroker.reconcileWithLease', () => {
    const storm = 'brainstorm_submit_discovery';
    const sdd = 'sdd_prepare';

    function setupBroker() {
        const broker = makeBroker();
        broker.registerWorkflowGroup('brainstorm', [storm]);
        broker.registerWorkflowGroup('sdd', [sdd]);
        return broker;
    }

    it('strips all workflow members when no lease is held', () => {
        const { control } = makeControl(['read', storm, sdd]);
        const broker = setupBroker();
        const result = broker.reconcileWithLease(control, [
            'read',
            storm,
            sdd,
        ]);
        expect(result.sort()).toEqual(['read']);
    });

    it('keeps the active workflow members when a lease is held', () => {
        const { control } = makeControl(['read', storm]);
        const broker = setupBroker();
        broker.activateWorkflow(control, 'brainstorm');
        const result = broker.reconcileWithLease(control, [
            'read',
            storm,
            sdd,
        ]);
        expect([...result].sort()).toEqual(['read', storm].sort());
    });

    it('keeps leased members when reconciliation uses another extension wrapper', () => {
        const { control: workflowControl } = makeControl(['read', storm]);
        const { control: toolGroupsControl } = makeControl([
            'read',
            storm,
            sdd,
        ]);
        const broker = setupBroker();
        broker.activateWorkflow(workflowControl, 'brainstorm');

        const result = broker.reconcileWithLease(toolGroupsControl, [
            'read',
            storm,
            sdd,
        ]);

        expect([...result].sort()).toEqual(['read', storm].sort());
    });
});

// ---------------------------------------------------------------------------
// getWorkflowGroups / state
// ---------------------------------------------------------------------------

describe('createVisibilityBroker.getWorkflowGroups', () => {
    it('returns registered groups in registration order', () => {
        const broker = makeBroker();
        broker.registerWorkflowGroup('sdd', ['read']);
        broker.registerWorkflowGroup('brainstorm', ['edit']);
        expect(broker.getWorkflowGroups()).toEqual(['sdd', 'brainstorm']);
    });

    it('returns empty list when none registered', () => {
        expect(makeBroker().getWorkflowGroups()).toEqual([]);
    });
});