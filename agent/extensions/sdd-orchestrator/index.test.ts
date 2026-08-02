import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
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

test('the extension entrypoint loads through Pi’s Jiti loader', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'sdd-runtime-loader-'));
    try {
        const extensionPath = join(import.meta.dir, 'index.ts');
        const jitiPath = require.resolve('jiti');
        const script = `const { createJiti } = require(${JSON.stringify(jitiPath)});
const jiti = createJiti(${JSON.stringify(extensionPath)}, { moduleCache: false });
jiti.import(${JSON.stringify(extensionPath)}, { default: true })
    .then((extension) => {
        if (typeof extension !== 'function') process.exitCode = 1;
    })
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });`;

        expect(() =>
            execFileSync('node', ['-e', script], {
                cwd: agentDir,
                stdio: 'pipe',
            }),
        ).not.toThrow();
    } finally {
        rmSync(agentDir, { recursive: true, force: true });
    }
});
