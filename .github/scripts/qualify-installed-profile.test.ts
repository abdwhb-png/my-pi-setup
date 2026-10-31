import { expect, test } from 'bun:test';
import {
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('profile diagnostics identify SDK import failure without exposing credentials', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-profile-diagnostic-'));
    try {
        const target = join(root, '.pi');
        mkdirSync(join(target, 'agent'), { recursive: true });
        const sdk = join(
            target,
            'agent/node_modules/@earendil-works/pi-coding-agent',
        );
        mkdirSync(sdk, { recursive: true });
        writeFileSync(join(target, 'agent/package.json'), '{}');
        writeFileSync(
            join(sdk, 'package.json'),
            JSON.stringify({
                name: '@earendil-works/pi-coding-agent',
                type: 'module',
                exports: './index.js',
            }),
        );
        writeFileSync(
            join(sdk, 'index.js'),
            'throw new Error("Cannot find module \'PRIVATE_FIXTURE_SENTINEL\'");',
        );
        const evidence = join(root, 'profile.json');
        const result = Bun.spawnSync(
            [
                process.execPath,
                join(import.meta.dir, 'qualify-installed-profile.ts'),
                target,
                evidence,
            ],
            {
                env: {
                    ...process.env,
                    HOME: root,
                    PI_OFFLINE: '1',
                    GITHUB_ACTIONS: 'true',
                    GITHUB_REPOSITORY: 'abdwhb-png/my-pi-distribution',
                    PI_QUALIFICATION_AUTH_JSON:
                        '{"fixture":{"apiKey":"PRIVATE_FIXTURE_SENTINEL"}}',
                    PI_QUALIFICATION_PROVIDER_SECRETS_JSON: '',
                    QUALIFICATION_PROVIDERS: 'false',
                },
                stdout: 'pipe',
                stderr: 'pipe',
            },
        );
        expect(result.exitCode).toBe(1);
        const output = readFileSync(evidence, 'utf8');
        expect(JSON.parse(output)).toMatchObject({
            status: 'failed',
            stage: 'sdk-import',
            failure: 'module-not-found',
        });
        expect(output).not.toContain('PRIVATE_FIXTURE_SENTINEL');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
