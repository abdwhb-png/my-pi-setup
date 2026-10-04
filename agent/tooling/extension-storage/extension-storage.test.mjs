import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

const agentRoot = resolve(import.meta.dir, '../..');

test('package lint rejects storage violations in production scripts ignored by general lint', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-storage-lint-command-'));
    try {
        mkdirSync(join(cwd, 'extensions/example/scripts'), { recursive: true });
        writeFileSync(
            join(cwd, 'extensions/example/index.ts'),
            "import './scripts/state.ts';\nexport default function example() {}\n",
        );
        writeFileSync(
            join(cwd, 'extensions/example/scripts/state.ts'),
            `
            import { join } from 'node:path';
            import { getAgentDir } from '@earendil-works/pi-coding-agent';
            export const state = join(getAgentDir(), 'new-state.json');
        `,
        );
        const { scripts } = JSON.parse(
            readFileSync(join(agentRoot, 'package.json'), 'utf8'),
        );
        writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts }));
        writeFileSync(
            join(cwd, '.oxlintrc.json'),
            JSON.stringify({
                extends: [join(agentRoot, '.oxlintrc.json')],
                options: { typeAware: false },
                // Anchor the real script exclusion to this disposable project.
                ignorePatterns: ['scripts/'],
            }),
        );
        for (const entry of [
            'tooling',
            '.oxlintrc.boundaries.json',
            '.oxlintrc.storage.json',
        ])
            symlinkSync(join(agentRoot, entry), join(cwd, entry));
        const result = spawnSync(process.execPath, ['run', 'lint'], {
            cwd,
            env: {
                ...process.env,
                PATH: `${join(agentRoot, 'node_modules/.bin')}${delimiter}${process.env.PATH ?? ''}`,
            },
            encoding: 'utf8',
        });
        if (result.error) throw result.error;
        expect(result.status).toBe(1);
        expect(result.stdout + result.stderr).toContain(
            'pi-storage(managed-paths)',
        );
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});

function lint(source, file = 'extensions/example/index.ts') {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-storage-lint-'));
    try {
        mkdirSync(dirname(join(cwd, file)), { recursive: true });
        writeFileSync(
            join(cwd, '.oxlintrc.json'),
            JSON.stringify({
                extends: [join(agentRoot, '.oxlintrc.json')],
                options: { typeAware: false },
            }),
        );
        writeFileSync(join(cwd, file), source);
        const result = spawnSync(
            join(agentRoot, 'node_modules/.bin/oxlint'),
            ['-c', join(cwd, '.oxlintrc.json'), '--format', 'json', file],
            { cwd, encoding: 'utf8' },
        );
        if (result.error) throw result.error;
        expect(result.stderr).toBe('');
        if (!result.stdout.trimStart().startsWith('{'))
            throw new Error(result.stdout);
        return { status: result.status, report: JSON.parse(result.stdout) };
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
}

test('configured Oxlint rejects an owned config constructed directly under the agent directory', () => {
    const { status, report } = lint(`
        import { join } from 'node:path';
        import { getAgentDir } from '@earendil-works/pi-coding-agent';
        export const config = join(getAgentDir(), 'slow-mode.json');
    `);
    expect(status).toBe(1);
    expect(report.diagnostics).toContainEqual(
        expect.objectContaining({
            code: 'pi-storage(managed-paths)',
        }),
    );
});

const imports = `
    import { join, resolve, join as pathJoin } from 'node:path';
    import * as fs from 'node:fs';
    import * as os from 'node:os';
    import { getAgentDir as agentHome, CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent';
    import { extensionPath } from '../_shared/extension-paths.ts';
    import { extensionConfigPath } from '../_shared/config-loader.ts';
    const cwd = process.cwd();
`;

test.each([
    [
        'canonical global artifacts',
        `export const p = join(agentHome(), 'artifacts', 'probe.json');`,
    ],
    [
        'new global state',
        `export const p = pathJoin(agentHome(), 'new-state.json');`,
    ],
    [
        'constant aliases',
        `const root = agentHome(); const file = 'slow-mode.json'; export const p = pathJoin(root, file);`,
    ],
    [
        'old project plans',
        `export const p = join(cwd, '.pi', 'plans', 'p.md');`,
    ],
    [
        'canonical project config',
        `export const p = resolve(cwd, '.pi/config/translate.json');`,
    ],
    [
        'split project root',
        `const root = join(cwd, CONFIG_DIR_NAME); export const p = join(root, 'new-artifact');`,
    ],
    [
        'home-relative agent root',
        `export const p = join(os.homedir(), '.pi', 'agent', 'config', 'slow-mode.json');`,
    ],
    [
        'template path',
        'fs.writeFileSync(`${agentHome()}/new-state.json`, "{}");',
    ],
    ['literal path', `fs.readFileSync('~/.pi/agent/slow-mode.json');`],
    [
        'concatenated path',
        `fs.writeFileSync(agentHome() + '/new-state.json', '{}');`,
    ],
    [
        'agentDir parameter',
        `export function location(agentDir: string) { return join(agentDir, 'new-state.json'); }`,
    ],
    [
        'managed root escape',
        `export const p = join(extensionPath({scope: 'global'}, 'artifacts'), '..', '..', 'rogue.json');`,
    ],
    [
        'returned template path',
        'export const p = `${agentHome()}/new-state.json`;',
    ],
    [
        'returned concatenated path',
        `export const p = agentHome() + '/new-state.json';`,
    ],
    [
        'copy destination',
        `fs.copyFileSync('/tmp/input', '.pi/new-state.json');`,
    ],
    ['Bun file destination', `Bun.write('.pi/new-state.json', '{}');`],
    [
        'extension-local config',
        `export const p = join(import.meta.dir, 'config.json');`,
    ],
    [
        'extension-local config URL',
        `export const p = new URL('./config.json', import.meta.url);`,
    ],
])('rejects %s', (_name, source) => {
    const { status, report } = lint(imports + source);
    expect(status).toBe(1);
    expect(
        report.diagnostics.some(
            (diagnostic) => diagnostic.code === 'pi-storage(managed-paths)',
        ),
    ).toBe(true);
});

test.each([
    [
        'managed artifacts',
        `export const p = extensionPath({scope: 'project', cwd}, 'artifacts', 'probe.json');`,
    ],
    [
        'managed config',
        `fs.readFileSync(extensionConfigPath('translate', {scope: 'global'}));`,
    ],
    [
        'managed subdirectory',
        `export const p = join(extensionPath({scope: 'global'}, 'artifacts'), 'nested', 'probe.json');`,
    ],
    ['core settings', `export const p = join(agentHome(), 'settings.json');`],
    [
        'core resources',
        `export const p = join(cwd, '.pi', 'skills', 'foo', 'SKILL.md');`,
    ],
    [
        'core sessions',
        `export const p = join(agentHome(), 'sessions', 'session.jsonl');`,
    ],
    [
        'external package config',
        `export const p = join(agentHome(), 'mcp.json');`,
    ],
    [
        'Pi installation runtime',
        `export const p = join(os.homedir(), '.pi', 'runtime', 'pi-core');`,
    ],
    ['agent parent discovery', `export const p = resolve(agentHome(), '..');`],
    [
        'ordinary project output',
        `export const p = join(cwd, 'build', 'config.json');`,
    ],
    [
        'shadowed path function',
        `export function helper(join: (...parts: unknown[]) => unknown) { return join(agentHome(), 'slow-mode.json'); }`,
    ],
    [
        'guidance text',
        `export const notice = 'Move .pi/plans into .pi/planning/plans';`,
    ],
    [
        'extension asset',
        `export const p = new URL('./assets/icon.svg', import.meta.url);`,
    ],
])('allows %s', (_name, source) => {
    const { status, report } = lint(imports + source);
    expect(
        report.diagnostics.filter((diagnostic) =>
            diagnostic.code?.startsWith('pi-storage('),
        ),
    ).toEqual([]);
    expect(status).toBe(0);
});

test.each([
    [
        'direct settings getter',
        `export const config = manager.getGlobalSettings().slowMode;`,
    ],
    [
        'settings alias',
        `const settings = manager.getProjectSettings(); export const config = settings['pi-roles'];`,
    ],
    [
        'settings destructuring',
        `const { saveTokens: config } = manager.getGlobalSettings(); export { config };`,
    ],
    [
        'settings JSON read',
        `const settings = JSON.parse(fs.readFileSync(join(agentHome(), 'settings.json'), 'utf8')); export const config = settings.translate;`,
    ],
    [
        'settings presence check',
        `const settings = manager.getProjectSettings(); export const enabled = 'plans' in settings;`,
    ],
    [
        'computed settings key',
        `const key = 'slowMode'; export const config = manager.getGlobalSettings()[key];`,
    ],
    [
        'settings JSON write',
        `const settings = {slowMode: {enabled: true}}; fs.writeFileSync(join(agentHome(), 'settings.json'), JSON.stringify(settings));`,
    ],
])('rejects legacy configuration through %s', (_name, source) => {
    const { status, report } = lint(
        imports + 'declare const manager: any;\n' + source,
    );
    expect(status).toBe(1);
    expect(
        report.diagnostics.some((diagnostic) =>
            diagnostic.message.includes('loadExtensionConfig'),
        ),
    ).toBe(true);
});

test.each([
    [
        'core model settings',
        `export const model = manager.getGlobalSettings().defaultModel;`,
    ],
    [
        'external package settings',
        `export const agents = manager.getProjectSettings().subagents;`,
    ],
    [
        'unrelated domain object',
        `export const config = { slowMode: false }; export const value = config.slowMode;`,
    ],
    [
        'unrelated settings file',
        `const settings = JSON.parse(fs.readFileSync('settings.json', 'utf8')); export const config = settings.plans;`,
    ],
])(
    'allows %s without treating every matching property as Pi settings',
    (_name, source) => {
        const { status, report } = lint(
            imports + 'declare const manager: any;\n' + source,
        );
        expect(
            report.diagnostics.filter((diagnostic) =>
                diagnostic.code?.startsWith('pi-storage('),
            ),
        ).toEqual([]);
        expect(status).toBe(0);
    },
);

test.each([
    'extensions/_shared/config-loader.ts',
    'extensions/_shared/extension-paths.ts',
    'extensions/_shared/scripts/extension-layout-migration.ts',
    'extensions/sandbox/testing/dashboard-fixture.ts',
    'extensions/__tests__/storage-fixture.ts',
    'extensions/example/index.test.ts',
    'extensions/sandbox/runtime/integration-fixtures.ts',
])('allows the storage owner or explicit fixture boundary at %s', (file) => {
    const { status, report } = lint(
        imports + `export const p = join(agentHome(), 'slow-mode.json');`,
        file,
    );
    expect(
        report.diagnostics.filter((diagnostic) =>
            diagnostic.code?.startsWith('pi-storage('),
        ),
    ).toEqual([]);
    expect(status).toBe(0);
});

test('does not exempt arbitrary shared modules', () => {
    const { status } = lint(
        imports + `export const p = join(agentHome(), 'slow-mode.json');`,
        'extensions/_shared/new-storage.ts',
    );
    expect(status).toBe(1);
});

test.each([
    ['sandbox/capabilities/migration.ts', 'sandbox.capabilities.json'],
    ['sandbox/capabilities/migration.ts', 'sandbox.global.json'],
    ['sandbox/capabilities/legacy-authority.ts', 'sandbox.capabilities.json'],
])('allows only the named legacy recovery file in %s', (file, legacy) => {
    expect(
        lint(
            imports + `export const p = join(agentHome(), '${legacy}');`,
            `extensions/${file}`,
        ).status,
    ).toBe(0);
    expect(
        lint(
            imports + `export const p = join(agentHome(), 'new-state.json');`,
            `extensions/${file}`,
        ).status,
    ).toBe(1);
});
