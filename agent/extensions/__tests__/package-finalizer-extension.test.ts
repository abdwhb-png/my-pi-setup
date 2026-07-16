import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('package-finalizer extension', () => {
    it('runs startup repair in non-force mode', async () => {
        const mod = await import('../package-finalizer.ts');
        const cwd = mkdtempSync(join(tmpdir(), 'pi-finalizer-cwd-'));
        const agentDir = mkdtempSync(join(tmpdir(), 'pi-finalizer-agent-'));
        const result = await mod.runPackageFinalizerStartup(cwd, agentDir);
        expect(result.inspected).toBe(0);
        expect(result.skipped).toBe(0);
    });
});
