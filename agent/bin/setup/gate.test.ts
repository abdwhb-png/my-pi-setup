import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSetupLaunchAllowed } from './gate.ts';
test('a setup transaction blocks ordinary Pi launches but admits its provisioning child', () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-setup-gate-'));
    const root = join(home, '.pi');
    try {
        writeFileSync(
            `${root}.setup-journal.json`,
            JSON.stringify({ id: 'fixture', phase: 'activating' }),
        );
        expect(() => assertSetupLaunchAllowed(root, '')).toThrow('transaction');
        expect(() => assertSetupLaunchAllowed(root, 'unrelated')).toThrow(
            'transaction',
        );
        expect(() => assertSetupLaunchAllowed(root, 'fixture')).not.toThrow();
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
