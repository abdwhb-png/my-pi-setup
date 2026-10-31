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

for (const phase of ['sdk-import', 'startup', 'shutdown'])
    test(`profile diagnostics identify ${phase} failure without exposing credentials`, () => {
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
                phase === 'sdk-import'
                    ? 'throw new Error("Cannot find module \'PRIVATE_FIXTURE_SENTINEL\'");'
                    : `
export const SessionManager = { inMemory: () => ({}) };
let report;
const failure = { extensionPath: ${JSON.stringify(join(target, 'agent/extensions/fixture/index.ts'))}, event: ${JSON.stringify(phase === 'startup' ? 'session_start' : 'session_shutdown')}, error: "Cannot find module 'PRIVATE_FIXTURE_SENTINEL'", stack: ${JSON.stringify(`at fixture (${target}/agent/extensions/fixture/index.ts:12:3)`)} };
export async function createAgentSession() { return {
 extensionsResult: { errors: [], extensions: [] },
 session: {
  bindExtensions: async ({onError}) => { report=onError; if (${JSON.stringify(phase)} === 'startup') report(failure); },
  extensionRunner: { emit: async () => { if (${JSON.stringify(phase)} === 'shutdown') report(failure); } },
  resourceLoader: { getSkills:()=>({diagnostics:[],skills:[]}), getPrompts:()=>({diagnostics:[],prompts:[]}), getThemes:()=>({diagnostics:[],themes:[]}) },
  getAllTools:()=>[], dispose() {},
 }
}; }
`,
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
                        QUALIFICATION_CATALOG_ONLY: 'false',
                    },
                    stdout: 'pipe',
                    stderr: 'pipe',
                },
            );
            expect(result.exitCode).toBe(1);
            const output = readFileSync(evidence, 'utf8');
            expect(JSON.parse(output)).toMatchObject({
                status: 'failed',
                stage: phase,
                failure:
                    phase === 'sdk-import'
                        ? 'module-not-found'
                        : 'lifecycle-error',
            });
            expect(output).not.toContain('PRIVATE_FIXTURE_SENTINEL');
            if (phase !== 'sdk-import')
                expect(JSON.parse(output).lifecycleErrors[0]).toMatchObject({
                    path: 'extensions/fixture/index.ts',
                    failure: 'module-not-found',
                    frames: [
                        {
                            path: 'agent/extensions/fixture/index.ts',
                            line: 12,
                            column: 3,
                        },
                    ],
                });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
