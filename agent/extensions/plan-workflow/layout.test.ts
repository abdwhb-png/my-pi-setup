import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { savePlan, readPlan } from './plan-store.ts';
test('session plans are versioned under cwd planning storage', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'plan-layout-'));
    try {
        const plan = savePlan(cwd, 'topic', '# First', 'session');
        expect(plan.path).toBe(
            join(cwd, '.pi/planning/session-plans/topic/v001.md'),
        );
        expect(readPlan(cwd, 'topic')).toEqual({
            content: '# First\n',
            version: 1,
        });
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});
