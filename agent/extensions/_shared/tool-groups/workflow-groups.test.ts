/**
 * Workflow group member invariants.
 *
 * Assert that each workflow extension exports its full member list with the
 * correct count and prefix, and that both groups register on the same broker
 * without conflict. Importing the real modules keeps the constant and the
 * registration wiring in sync (catches accidental drift from a new prefixed
 * tool or a missed constant update).
 */
import { describe, expect, it } from 'bun:test';
import { BRAINSTORM_WORKFLOW_TOOLS } from '../../brainstorm-forcer/index';
import { SDD_WORKFLOW_TOOLS } from '../../sdd-orchestrator/extension-tools';
import { createVisibilityBroker } from './broker.ts';

describe('BRAINSTORM_WORKFLOW_TOOLS', () => {
    it('contains exactly 9 brainstorm_* members', () => {
        expect(BRAINSTORM_WORKFLOW_TOOLS.length).toBe(9);
        for (const name of BRAINSTORM_WORKFLOW_TOOLS) {
            expect(name.startsWith('brainstorm_')).toBe(true);
        }
    });

    it('has unique members', () => {
        expect(new Set(BRAINSTORM_WORKFLOW_TOOLS).size).toBe(
            BRAINSTORM_WORKFLOW_TOOLS.length,
        );
    });
});

describe('SDD_WORKFLOW_TOOLS', () => {
    it('contains exactly 8 sdd_* members', () => {
        expect(SDD_WORKFLOW_TOOLS.length).toBe(8);
        for (const name of SDD_WORKFLOW_TOOLS) {
            expect(name.startsWith('sdd_')).toBe(true);
        }
    });

    it('has unique members', () => {
        expect(new Set(SDD_WORKFLOW_TOOLS).size).toBe(
            SDD_WORKFLOW_TOOLS.length,
        );
    });
});

describe('workflow group coexistence on a broker', () => {
    it('registers both groups without overlap', () => {
        const broker = createVisibilityBroker();
        broker.registerWorkflowGroup('brainstorm', [
            ...BRAINSTORM_WORKFLOW_TOOLS,
        ]);
        broker.registerWorkflowGroup('sdd', [...SDD_WORKFLOW_TOOLS]);
        expect(broker.getWorkflowGroups()).toEqual(['brainstorm', 'sdd']);
    });
});