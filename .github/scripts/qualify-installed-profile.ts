import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    qualifyProviders,
    inspectProviderCases,
    type ProviderCheckEvent,
} from './portable-provider-checks.ts';

function failureCode(error: unknown): string {
    const message =
        error instanceof Error
            ? error.message
            : typeof error === 'string'
              ? error
              : '';
    if (/Cannot find (module|package)|ModuleNotFound|ENOENT/i.test(message))
        return 'module-not-found';
    if (/not exported|does not provide an export/i.test(message))
        return 'missing-export';
    if (/is not a function/i.test(message)) return 'api-unavailable';
    if (/syntax|unexpected token/i.test(message)) return 'syntax-error';
    if (/extension loading errors/i.test(message))
        return 'extension-load-errors';
    if (/resource diagnostics/i.test(message)) return 'resource-diagnostics';
    if (/Selected provider model is unavailable/.test(message))
        return 'provider-model-unavailable';
    if (/no configured authentication/.test(message))
        return 'provider-auth-unavailable';
    if (/authentication mode differs/.test(message))
        return 'provider-auth-mode-mismatch';
    if (/exceeds the approved budget/.test(message))
        return 'provider-budget-exceeded';
    if (/Provider catalog refresh failed/.test(message))
        return 'provider-catalog-unavailable';
    if (/Provider request failed/.test(message))
        return 'provider-request-failed';
    if (/Provider returned no text/.test(message))
        return 'provider-empty-response';
    if (/Invalid configured model prices/.test(message))
        return 'provider-invalid-prices';
    if (/Invalid configured model token limits/.test(message))
        return 'provider-invalid-token-limits';
    if (/Provider returned invalid cost accounting/.test(message))
        return 'provider-invalid-cost';
    if (/Explicit provider budget/.test(message))
        return 'provider-invalid-budget';
    return 'unclassified';
}

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
const providerEvents: ProviderCheckEvent[] = [];
let extensionErrors: Array<{ path: string; failure: string }> = [];
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
    stage = 'sdk-import';
    const sdk: typeof import('../../agent/node_modules/@earendil-works/pi-coding-agent/dist/index.js') =
        await import(
            import.meta.resolve(
                '@earendil-works/pi-coding-agent',
                pathToFileURL(join(agentDir, 'package.json')).href,
            )
        );
    stage = 'session-create';
    const created = await sdk.createAgentSession({
        cwd: process.env.HOME!,
        agentDir,
        sessionManager: sdk.SessionManager.inMemory(process.env.HOME!),
    });
    session = created.session;
    stage = 'extension-load';
    extensionErrors = created.extensionsResult.errors.map(
        ({ path, error }) => ({
            path: relative(agentDir, path),
            failure: failureCode(error),
        }),
    );
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
    assert(
        !(
            process.env.QUALIFICATION_CATALOG_ONLY === 'true' &&
            process.env.QUALIFICATION_PROVIDERS === 'true'
        ),
        'Catalog-only inspection cannot request completions',
    );
    stage = 'provider-catalog';
    const providerCatalog =
        process.env.QUALIFICATION_CATALOG_ONLY === 'true'
            ? (
                  await inspectProviderCases(
                      session.modelRuntime,
                      process.env.PI_QUALIFICATION_PROVIDER_CASES ?? '',
                      Number(process.env.QUALIFICATION_PROVIDER_BUDGET),
                  )
              ).map(({ item, reservation }) => ({
                  ...item,
                  maximumCostUSD: reservation,
              }))
            : [];
    stage = 'provider-checks';
    const providers =
        process.env.QUALIFICATION_PROVIDERS === 'true'
            ? await qualifyProviders(
                  session.modelRuntime,
                  process.env.PI_QUALIFICATION_PROVIDER_CASES ?? '',
                  Number(process.env.QUALIFICATION_PROVIDER_BUDGET),
                  (event) => {
                      providerEvents.push(event);
                      writeFileSync(
                          process.argv[3],
                          JSON.stringify({
                              status: 'running',
                              stage,
                              providerEvents,
                          }),
                          { mode: 0o600 },
                      );
                  },
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
                providerCatalog,
                providerEvents,
                providerConnectivity: providers.length
                    ? 'passed'
                    : 'not requested',
            },
            null,
            2,
        ),
        { mode: 0o600 },
    );
} catch (error) {
    writeFileSync(
        process.argv[3],
        JSON.stringify({
            status: 'failed',
            stage,
            failure: failureCode(error),
            extensionErrors,
            providerEvents,
        }),
        { mode: 0o600 },
    );
    process.exitCode = 1;
} finally {
    session?.dispose();
    for (const [, path] of credentials) rmSync(path, { force: true });
}
