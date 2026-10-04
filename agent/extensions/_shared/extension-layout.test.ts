import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadExtensionConfig } from './config-loader.ts';
const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0))
        rmSync(dir, { recursive: true, force: true });
});
test('owned configuration loads from config with a trusted cwd overlay', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-layout-'));
    dirs.push(root);
    const agentDir = join(root, 'agent'),
        cwd = join(root, 'project');
    for (const [base, value] of [
        [agentDir, 1],
        [join(cwd, '.pi'), 2],
    ] as const) {
        mkdirSync(join(base, 'config'), { recursive: true });
        writeFileSync(
            join(base, 'config', 'slow-mode.json'),
            JSON.stringify({ value }),
        );
    }
    new ProjectTrustStore(agentDir).set(cwd, true);
    const options = {
        defaults: { value: 0 },
        normalize: (raw: unknown) => (raw ?? {}) as { value: number },
        agentDir,
        owner: 'slowMode' as const,
    };
    expect(
        loadExtensionConfig(cwd, { ...options, projectTrusted: false }).value,
    ).toBe(1);
    expect(
        loadExtensionConfig(cwd, { ...options, projectTrusted: true }).value,
    ).toBe(2);
});
