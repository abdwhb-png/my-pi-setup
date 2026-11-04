import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateBundle } from './distribution.ts';
import { inventory, json, writeJson } from './files.ts';

function withProfile(
    path: string,
    value: Record<string, unknown>,
    verify: (root: string) => void,
) {
    const root = mkdtempSync(join(tmpdir(), 'pi-profile-admission-'));
    try {
        for (const name of [
            'setup/bin/pi',
            'setup/bin/pi-setup',
            'setup/agent/settings.json',
            'pi/release-manifest.json',
            'zerobox/manifest.json',
            'zerobox/provenance.json',
        ])
            writeJson(join(root, name), {});
        writeJson(join(root, `setup/agent/${path}`), value);
        writeJson(join(root, 'manifest.json'), {
            schemaVersion: 1,
            platform: 'linux-x64',
            sourceCommit: 'a'.repeat(40),
            packages: [],
            files: inventory(root),
        });
        verify(root);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

test.each([
    {
        path: 'mcp.json',
        value: {
            mcpServers: {
                fixture: {
                    url: 'https://fixture.invalid/mcp',
                    headers: {
                        Authorization: 'Bearer ${FIXTURE_TOKEN}',
                        'x-api-key': '${FIXTURE_KEY}',
                    },
                },
            },
        },
    },
    {
        path: 'mcp-adapter.json',
        value: {
            mcpServers: {
                fixture: {
                    command: 'fixture',
                    auth: 'bearer',
                    env: {
                        FIXTURE_API_KEY: '${FIXTURE_API_KEY}',
                        NODE_ENV: 'production',
                    },
                },
            },
        },
    },
    {
        path: 'models.json',
        value: {
            providers: {
                fixture: {
                    baseUrl: 'https://fixture.invalid/v1',
                    apiKey: '${FIXTURE_KEY}',
                    headers: { Authorization: 'Bearer ${FIXTURE_TOKEN}' },
                },
            },
        },
    },
    {
        path: 'mcp.json',
        value: {
            mcpServers: {
                fixture: {
                    command: 'fixture',
                    args: ['--max-tokens', '2048'],
                    env: {
                        TOKENIZERS_PARALLELISM: 'false',
                        MAX_TOKENS: '2048',
                    },
                },
            },
        },
    },
])(
    'admission preserves credential references in $path without resolving them',
    ({ path, value }) => {
        withProfile(path, value, (root) => {
            expect(() => validateBundle(root)).not.toThrow();
            expect(json(join(root, `setup/agent/${path}`))).toEqual(value);
        });
    },
);

test.each([
    {
        label: 'model key',
        path: 'models.json',
        value: {
            providers: { fixture: { apiKey: 'fixture-clear-credential' } },
        },
    },
    {
        label: 'authorization header',
        path: 'mcp.json',
        value: {
            mcpServers: {
                fixture: {
                    headers: {
                        Authorization: 'Bearer fixture-clear-credential',
                    },
                },
            },
        },
    },
    {
        label: 'custom key header',
        path: 'mcp.json',
        value: {
            mcpServers: {
                fixture: {
                    headers: { 'x-api-key': 'fixture-clear-credential' },
                },
            },
        },
    },
    {
        label: 'environment key',
        path: 'mcp-adapter.json',
        value: {
            mcpServers: {
                fixture: {
                    env: { FIXTURE_API_KEY: 'fixture-clear-credential' },
                },
            },
        },
    },
    {
        label: 'private environment key',
        path: 'mcp-adapter.json',
        value: {
            mcpServers: {
                fixture: { env: { PRIVATE_KEY: 'fixture-clear-credential' } },
            },
        },
    },
    {
        label: 'credential command',
        path: 'models.json',
        value: {
            providers: {
                fixture: { apiKey: '!printf fixture-clear-credential' },
            },
        },
    },
    {
        label: 'reference suffix',
        path: 'models.json',
        value: {
            providers: {
                fixture: { apiKey: '${FIXTURE_KEY}fixture-clear-credential' },
            },
        },
    },
    {
        label: 'escaped reference',
        path: 'models.json',
        value: { providers: { fixture: { apiKey: '$${FIXTURE_KEY}' } } },
    },
    {
        label: 'inline argument',
        path: 'mcp.json',
        value: {
            mcpServers: {
                fixture: { args: ['--token=fixture-clear-credential'] },
            },
        },
    },
    {
        label: 'argument value',
        path: 'mcp.json',
        value: {
            mcpServers: {
                fixture: { args: ['--api-key', 'fixture-clear-credential'] },
            },
        },
    },
    {
        label: 'URL credential',
        path: 'mcp.json',
        value: {
            mcpServers: {
                fixture: {
                    url: 'https://fixture.invalid/mcp?token=fixture-clear-credential',
                },
            },
        },
    },
    {
        label: 'prototype-named field',
        path: 'fancy-footer.json',
        value: { ['__proto__']: { token: 'fixture-clear-credential' } },
    },
    {
        label: 'custom header command',
        path: 'mcp.json',
        value: {
            mcpServers: {
                fixture: {
                    headers: { 'X-Custom': '!printf fixture-clear-credential' },
                },
            },
        },
    },
    {
        label: 'OAuth client secret',
        path: 'mcp.json',
        value: {
            mcpServers: {
                fixture: {
                    oauth: { clientSecret: 'fixture-clear-credential' },
                },
            },
        },
    },
])(
    'admission rejects $label without disclosing its value',
    ({ path, value }) => {
        withProfile(path, value, (root) => {
            let message = '';
            try {
                validateBundle(root);
            } catch (error) {
                if (!(error instanceof Error)) throw error;
                message = error.message;
            }
            expect(message).toContain(`agent/${path}`);
            expect(message).toContain('credential');
            expect(message).not.toContain('fixture-clear-credential');
        });
    },
);

test.each(['malformed JSON', 'symbolic link'])(
    'admission refuses a profile containing %s without disclosing its content',
    (kind) => {
        withProfile('fancy-footer.json', {}, (root) => {
            const path = join(root, 'setup/agent/fancy-footer.json');
            if (kind === 'malformed JSON')
                writeFileSync(path, '{"fixture-clear-credential"');
            else {
                rmSync(path);
                symlinkSync('settings.json', path);
            }
            const manifest = json(join(root, 'manifest.json'));
            rmSync(join(root, 'manifest.json'));
            writeJson(join(root, 'manifest.json'), {
                ...manifest,
                files: inventory(root),
            });
            let message = '';
            try {
                validateBundle(root);
            } catch (error) {
                if (!(error instanceof Error)) throw error;
                message = error.message;
            }
            expect(message).toContain('agent/fancy-footer.json');
            expect(message).toContain(
                kind === 'malformed JSON'
                    ? 'Invalid JSON profile'
                    : 'regular file',
            );
            expect(message).not.toContain('fixture-clear-credential');
        });
    },
);
