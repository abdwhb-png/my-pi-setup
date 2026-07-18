import { describe, expect, it } from 'bun:test';
import {
    findLatestYeetRoleTransition,
    YEET_ROLE_TRANSITION_ENTRY_TYPE,
} from './role-transition';

describe('findLatestYeetRoleTransition', () => {
    it('returns the newest valid persisted transition', () => {
        const entries = [
            {
                id: 'entry-1',
                type: 'custom',
                customType: YEET_ROLE_TRANSITION_ENTRY_TYPE,
                data: {
                    id: 'yeet-1',
                    phase: 'queued',
                    targetCwd: '/repo',
                    timestamp: 1,
                },
            },
            {
                id: 'entry-2',
                type: 'custom',
                customType: YEET_ROLE_TRANSITION_ENTRY_TYPE,
                data: { phase: 'active' },
            },
            {
                id: 'entry-3',
                type: 'custom',
                customType: YEET_ROLE_TRANSITION_ENTRY_TYPE,
                data: {
                    id: 'yeet-1',
                    phase: 'active',
                    previousRole: 'architect',
                    targetCwd: '/repo',
                    timestamp: 2,
                },
            },
        ];

        expect(findLatestYeetRoleTransition(entries)).toEqual({
            id: 'yeet-1',
            phase: 'active',
            previousRole: 'architect',
            targetCwd: '/repo',
            timestamp: 2,
        });
    });
});
