import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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

    it('pins tool-groups order and warns on reorder during startup', async () => {
        const mod = await import('../package-finalizer.ts');
        const cwd = mkdtempSync(join(tmpdir(), 'pi-pf-cwd-'));
        const agentDir = mkdtempSync(join(tmpdir(), 'pi-pf-agent-'));

        // Create settings with tool-groups not last.
        mkdirSync(join(agentDir, 'extensions', 'tool-groups'), {
            recursive: true,
        });
        mkdirSync(join(agentDir, 'extensions', 'other-pkg'), {
            recursive: true,
        });
        writeFileSync(
            join(agentDir, 'settings.json'),
            JSON.stringify({
                packages: [
                    './extensions/tool-groups',
                    './extensions/other-pkg',
                ],
            }),
        );

        const result = await mod.runPackageFinalizerStartup(cwd, agentDir);

        // Verify reorder in settings file.
        const raw = readFileSync(join(agentDir, 'settings.json'), 'utf-8');
        let settings: Record<string, unknown> = {};
        try {
            settings = JSON.parse(raw);
        } catch {
            /* test-wrote valid JSON */
        }
        expect(settings.packages).toEqual([
            './extensions/other-pkg',
            './extensions/tool-groups',
        ]);

        // Verify warning added.
        expect(result.warnings.length).toBeGreaterThanOrEqual(1);
        expect(result.warnings[0]).toContain('/reload');
    });
});
