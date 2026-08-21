import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createRuntime } from './index.ts';

test('the production runtime provides Git workspace isolation to SDD', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'sdd-runtime-'));
    try {
        const runtime = createRuntime(
            {
                events: { on: () => () => {} },
            } as unknown as ExtensionAPI,
            agentDir,
        );

        expect(runtime.workspace).toBeDefined();
        expect(runtime.workspace?.prepare).toBeFunction();
    } finally {
        rmSync(agentDir, { recursive: true, force: true });
    }
});
