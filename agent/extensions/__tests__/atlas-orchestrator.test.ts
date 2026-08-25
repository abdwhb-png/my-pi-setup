import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const rolePath = join(import.meta.dir, 'atlas-orchestrator.md');

describe('atlas-orchestrator role contract', () => {
    it('uses portable delegation, bounded recovery, and safe concurrency rules', () => {
        const role = readFileSync(rolePath, 'utf8');

        expect(role).not.toMatch(/runSubagent|sessionId/);
        expect(role).not.toMatch(/under 30 lines|30 lines|PARALLEL fan-out/i);
        expect(role).not.toMatch(/pi-subagents|sdd-orchestrator/i);
        expect(role).not.toMatch(
            /workflowScript|runs\.run|contact_supervisor|context:\s*["'](?:fork|fresh)|runId/i,
        );

        expect(role).toContain('Observable outcome');
        expect(role).toContain('Allowed scope');
        expect(role).toContain('Executable validation');
        expect(role).toContain('two follow-ups');
        expect(role).toContain('fresh replacement');
        expect(role).toContain('escalate to the user');
        expect(role).toContain('one writer per shared workspace');
        expect(role).toContain('isolated workspaces');
    });
});