import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { qualifyProviders } from './portable-provider-checks.ts';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.GITHUB_REPOSITORY, 'abdwhb-png/my-pi-distribution');
const target = resolve(process.argv[2]);
const agentDir = join(target, 'agent');
const credentials = [
    ['PI_QUALIFICATION_AUTH_JSON', join(agentDir, 'auth.json')],
    [
        'PI_QUALIFICATION_PROVIDER_SECRETS_JSON',
        join(agentDir, 'config/ai-providers.secrets.json'),
    ],
] as const;
let session:
    | import('../../agent/node_modules/@earendil-works/pi-coding-agent/dist/index.js').AgentSession
    | undefined;
let stage = 'credentials';
try {
    for (const [key, path] of credentials) {
        const value = process.env[key];
        delete process.env[key];
        if (value) {
            const parsed = JSON.parse(value);
            assert(
                parsed && typeof parsed === 'object' && !Array.isArray(parsed),
                'Credential secret must be a JSON object',
            );
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            writeFileSync(path, JSON.stringify(parsed), { mode: 0o600 });
        }
    }
    stage = 'load-resources';
    const sdk: typeof import('../../agent/node_modules/@earendil-works/pi-coding-agent/dist/index.js') =
        await import(
            import.meta.resolve(
                '@earendil-works/pi-coding-agent',
                pathToFileURL(join(agentDir, 'package.json')).href,
            )
        );
    const created = await sdk.createAgentSession({
        cwd: process.env.HOME!,
        agentDir,
        sessionManager: sdk.SessionManager.inMemory(process.env.HOME!),
    });
    session = created.session;
    assert.equal(
        created.extensionsResult.errors.length,
        0,
        'Installed profile has extension loading errors',
    );
    let lifecycleErrors = 0;
    stage = 'startup';
    await session.bindExtensions({
        mode: 'rpc',
        onError: () => {
            lifecycleErrors++;
        },
    });
    const resources = session.resourceLoader;
    for (const result of [
        resources.getSkills(),
        resources.getPrompts(),
        resources.getThemes(),
    ]) {
        assert.equal(
            result.diagnostics.length,
            0,
            'Installed profile has resource diagnostics',
        );
    }
    stage = 'provider-checks';
    const providers =
        process.env.QUALIFICATION_PROVIDERS === 'true'
            ? await qualifyProviders(
                  session.modelRuntime,
                  process.env.PI_QUALIFICATION_PROVIDER_CASES ?? '',
                  Number(process.env.QUALIFICATION_PROVIDER_BUDGET),
              )
            : [];
    stage = 'shutdown';
    await session.extensionRunner.emit({
        type: 'session_shutdown',
        reason: 'quit',
    });
    assert.equal(lifecycleErrors, 0, 'Installed profile has lifecycle errors');
    writeFileSync(
        process.argv[3],
        JSON.stringify(
            {
                status: 'passed',
                extensions: created.extensionsResult.extensions.length,
                skills: resources.getSkills().skills.length,
                prompts: resources.getPrompts().prompts.length,
                themes: resources.getThemes().themes.length,
                tools: session.getAllTools().map((tool) => tool.name),
                providers,
                providerConnectivity: providers.length
                    ? 'passed'
                    : 'not requested',
            },
            null,
            2,
        ),
        { mode: 0o600 },
    );
} catch {
    writeFileSync(
        process.argv[3],
        JSON.stringify({ status: 'failed', stage }),
        { mode: 0o600 },
    );
    process.exitCode = 1;
} finally {
    session?.dispose();
    for (const [, path] of credentials) rmSync(path, { force: true });
}
