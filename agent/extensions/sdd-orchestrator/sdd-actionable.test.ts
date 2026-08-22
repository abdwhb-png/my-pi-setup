import { describe, expect, it } from 'bun:test';
import {
    isSddActionable,
    type ActionableSnapshot,
} from './sdd-actionable.ts';

function snapshot(
    state: ActionableSnapshot['state'],
    overrides: Partial<ActionableSnapshot> = {},
): ActionableSnapshot {
    return {
        runId: 'run-1',
        revision: 0,
        state,
        tasks: {},
        consumedIdempotencyKeys: [],
        plannedDelegations: {},
        ...overrides,
    };
}

describe('isSddActionable', () => {
    it('is actionable for in-progress and pre-run states', () => {
        for (const state of [
            'draft',
            'assessed',
            'awaiting_approval',
            'approved',
            'running',
            'needs_input',
        ] as const) {
            expect(isSddActionable(snapshot(state))).toBe(true);
        }
    });

    it('exposes a completed isolated run with delivery pending (needs sdd_apply)', () => {
        const run = snapshot('completed', {
            workspace: {
                mode: 'isolated',
                sourceRoot: '/src',
                baseCommit: 'a'.repeat(40),
                worktreePath: '/wt',
                delivery: { status: 'pending' },
            },
        });
        expect(isSddActionable(run)).toBe(true);
    });

    it('hides a completed run after delivery is applied', () => {
        const run = snapshot('completed', {
            workspace: {
                mode: 'isolated',
                sourceRoot: '/src',
                baseCommit: 'a'.repeat(40),
                worktreePath: '/wt',
                delivery: { status: 'applied', appliedAt: 'now' },
            },
        });
        expect(isSddActionable(run)).toBe(false);
    });

    it('hides a completed run without an isolated workspace', () => {
        expect(isSddActionable(snapshot('completed'))).toBe(false);
    });

    it('hides failed and cancelled runs', () => {
        expect(isSddActionable(snapshot('failed'))).toBe(false);
        expect(isSddActionable(snapshot('cancelled'))).toBe(false);
    });
});