import { emptyGrants } from './capabilities/authority.ts';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localMachineId } from './capabilities/authority.ts';
import type { Theme } from '@earendil-works/pi-coding-agent';
import {
    envSandboxStatus,
    dockerFooterState,
    explicitlyDisabled,
    loadSandboxConfig,
    loadSessionSandboxStatus,
    persistProjectDockerPreference,
    renderSandboxStatusDetails,
    renderSandboxWidget,
    saveSessionSandboxStatus,
    sessionStateFilename,
    type LoadSandboxConfigResult,
} from './index';

const ENV_OVERRIDE_KEY = 'PI_SANDBOX_SESSION_STATUS';
const SESSION_ID = 'session-a';

it('shows the effective Docker profile and exception instead of an ambiguous marker', () => {
    const render = (operations?: Array<'ps' | 'inspect' | 'logs' | 'stats' | 'exec' | 'start' | 'stop' | 'restart'>) => renderSandboxWidget(fakeTheme(), 'on', dockerFooterState({
        mode: 'targeted', endpoint: 'unix:///var/run/docker.sock',
        targets: [{ selector: { type: 'container-name', name: 'api' }, operations, allowUnsafeTarget: true }],
    }));
    expect(render()).toContain('Exploitation + inspection');
    expect(render()).not.toContain('Administration');
    expect(render(['ps','inspect','logs','stats','start','stop','restart'])).toContain('Exploitation');
    expect(render(['ps','inspect','logs','stats'])).toContain('Observation');
    expect(render(['logs'])).toContain('Custom');
    expect(render()).toContain('1 target');
    expect(render()).toContain('host-access exception');
    expect(render()).not.toContain('targeted!');
});

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try {
        return fn();
    } finally {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
    }
}

function fakeTheme(): Theme {
    return { fg: (color: string, text: string) => `fg:${color}:${text}` } as unknown as Theme;
}

const emptySettingsManager = {
    getGlobalSettings: () => ({}),
    getProjectSettings: () => ({}),
};

describe('active sandbox files', () => {
    let root: string; let agentDir: string; let cwd: string;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'sandbox-active-config-')); agentDir = join(root, 'agent'); cwd = join(root, 'project'); mkdirSync(agentDir); mkdirSync(join(cwd, '.pi'), { recursive: true }); });
    afterEach(() => rmSync(root, { recursive: true, force: true }));
    const writeGlobal = (value: Record<string, unknown>) => writeFileSync(join(agentDir, 'sandbox.json'), JSON.stringify({ version: 2, machineId: 'machine', ...value }), { mode: 0o600 });
    const load = () => loadSandboxConfig(cwd, { agentDir, machineId: 'machine' });
    it('keeps absent global lists, closes explicit empty project lists, and preserves exclusions', () => {
        writeGlobal({ network: { allowedDomains: ['example.com'] } });
        writeFileSync(join(cwd, '.pi', 'sandbox.json'), JSON.stringify({ network: { allowedDomains: [], deniedDomains: ['example.com'] } }));
        expect(load().config.network.allowedDomains).toEqual([]); expect(load().config.network.deniedDomains).toContain('example.com');
    });
    it('rejects invalid active files and never falls back to host', () => {
        writeGlobal({ mode: 'sandbox' }); writeFileSync(join(cwd, '.pi', 'sandbox.json'), JSON.stringify({ mode: 'host' }));
        expect(() => load()).toThrow('explicit current-session');
        writeFileSync(join(cwd, '.pi', 'sandbox.json'), '{'); expect(() => load()).toThrow('Could not parse project');
    });
    it('blocks admission while a migration marker remains', () => {
        writeGlobal({});
        writeFileSync(join(agentDir, 'sandbox.json.migration'), 'migration in progress\n');
        expect(() => load()).toThrow();
    });
    it('toggles Docker activation without discarding project target restrictions', async () => {
        writeFileSync(join(agentDir, 'sandbox.json'), JSON.stringify({ version: 2, machineId: localMachineId(), docker: { allowed: true, operations: ['logs'] } }), { mode: 0o600 });
        writeFileSync(join(cwd, '.pi', 'sandbox.json'), JSON.stringify({ docker: { enabled: true, targets: [{ selector: { type: 'container-name', name: 'api' }, operations: ['logs'] }] } }));
        await persistProjectDockerPreference(cwd, 'off', agentDir);
        await persistProjectDockerPreference(cwd, 'on', agentDir);
        expect(JSON.parse(readFileSync(join(cwd, '.pi', 'sandbox.json'), 'utf8')).docker).toEqual({ enabled: true, targets: [{ selector: { type: 'container-name', name: 'api' }, operations: ['logs'] }] });
    });
});

describe('renderSandboxWidget', () => {
    it('shows the selected mode separately from its custom policy and engine state', () => {
        const selected = { mode: 'sandbox' as const, profile: 'custom' as const };
        expect(renderSandboxWidget(fakeTheme(), 'on', undefined, selected)).toContain('sandbox · custom · ready');
        expect(renderSandboxWidget(fakeTheme(), 'reconfiguring', undefined, selected)).toContain('sandbox · custom · reconfiguring');
        expect(renderSandboxWidget(fakeTheme(), 'off', undefined, { mode: 'host', profile: 'host' })).toContain('host · unsandboxed');
    });
    it('always renders the off state with warning color and ⚠ glyph', () => {
        const rendered = renderSandboxWidget(fakeTheme(), 'off');
        expect(rendered).not.toBeNull();
        expect(rendered).toContain('⚠');
        expect(rendered).toContain('fg:warning:');
    });

    it('embeds the shield icon when on', () => {
        expect(renderSandboxWidget(fakeTheme(), 'on')).toContain('🛡️');
    });

    it('keeps the label dim', () => {
        expect(renderSandboxWidget(fakeTheme(), 'on')).toContain('fg:dim:');
    });

    it('colors only the on value accent', () => {
        expect(renderSandboxWidget(fakeTheme(), 'on')).toContain('fg:accent:on');
    });

    it('colors only the restricted value warning', () => {
        expect(renderSandboxWidget(fakeTheme(), 'restricted')).toContain(
            'fg:warning:restricted',
        );
    });

    it('colors only the error value danger', () => {
        expect(renderSandboxWidget(fakeTheme(), 'error')).toContain(
            'fg:error:error',
        );
    });

    it('shows Docker off, targeted, full, and unsafe states without target details', () => {
        expect(renderSandboxWidget(fakeTheme(), 'on')).toContain(
            'fg:dim:off',
        );
        const targeted = renderSandboxWidget(fakeTheme(), 'on', {
            mode: 'targeted',
            unsafe: false,
        });
        expect(targeted).toContain('fg:accent:targeted');
        const unsafe = renderSandboxWidget(fakeTheme(), 'on', {
            mode: 'targeted',
            unsafe: true,
        });
        expect(unsafe).toContain('fg:warning:targeted · host-access exception');
        const full = renderSandboxWidget(fakeTheme(), 'on', {
            mode: 'full',
            unsafe: true,
        });
        expect(full).toContain('fg:error:full · host control');
        expect(full).not.toContain('docker.sock');
    });
});

describe('renderSandboxStatusDetails', () => {
    function resolvedWithDocker(
        docker: LoadSandboxConfigResult['config']['docker'],
    ): LoadSandboxConfigResult {
        return {
            source: 'project-config',
            shell: { state: 'ready', requestedProfile: 'default', profile: 'default', projectRoot: '/project', authorityPath: '/authority', grants: emptyGrants(), requestedGrants: emptyGrants() },
            config: {
                enabled: true,
                network: {
                    allowedDomains: [],
                    allowedHostDomains: [],
                    deniedDomains: [],
                    allowLocalBinding: true,
                },
                filesystem: {
                    allowRead: [],
                    denyRead: [],
                    allowWrite: ['.'],
                    denyWrite: [],
                },
                environment: {
                    allowedVariables: [],
                    deniedVariables: [],
                    variables: {},
                    path: [],
                },
                docker,
            },
        };
    }

    it('does not describe the broker as active for a host shell', () => {
        const resolved = resolvedWithDocker({ mode: 'full', endpoint: 'unix:///hidden.sock' });
        resolved.shell.mode = 'host';
        resolved.shell.profile = 'host';
        const output = renderSandboxStatusDetails(resolved, true);
        expect(output).toContain('Sandbox: HOST (unsandboxed)');
        expect(output).toContain('Docker: off (shell mode is host)');
    });

    it('reports Docker off when the sandbox is disabled', () => {
        const output = renderSandboxStatusDetails(
            resolvedWithDocker({
                mode: 'full',
                endpoint: 'unix:///secret/docker.sock',
            }),
            false,
        );

        expect(output).toContain('Docker: off (sandbox disabled)');
        expect(output).not.toContain('/secret/docker.sock');
        expect(output).not.toContain('host control');
    });

    it('documents selected-profile and explicit Sandbox shell prefixes', () => {
        const output = renderSandboxStatusDetails(
            resolvedWithDocker({ mode: 'disabled' }),
            true,
        );

        expect(output).toContain('! <command> selected profile');
        expect(output).toContain('!! <command> selected profile outside model context');
        expect(output).toContain('!s <command> Sandbox');
        expect(output).toContain('!!s <command> Sandbox outside model context');
        expect(output).toContain('!s without a command fails closed');
    });

    it('warns for full Docker access without exposing the endpoint', () => {
        const output = renderSandboxStatusDetails(
            resolvedWithDocker({
                mode: 'full',
                endpoint: 'unix:///secret/docker.sock',
            }),
            true,
        );

        expect(output).toContain('Docker: full');
        expect(output).toContain('equivalent to host control');
        expect(output).not.toContain('/secret/docker.sock');
    });

    it('explains targeted exceptions with the target and operations, without exposing the endpoint', () => {
        const output = renderSandboxStatusDetails(
            resolvedWithDocker({
                mode: 'targeted',
                endpoint: 'unix:///secret/docker.sock',
                targets: [
                    {
                        selector: {
                            type: 'container-name',
                            name: 'secret-container',
                        },
                        operations: ['logs'],
                        allowUnsafeTarget: true,
                    },
                ],
            }),
            true,
        );

        expect(output).toContain('Docker: targeted');
        expect(output).toContain('host-access exception');
        expect(output).not.toContain('/secret/docker.sock');
        expect(output).toContain('container-name: secret-container');
        expect(output).toContain('Operations: logs');
    });
});

describe('loadSessionSandboxStatus', () => {
    let root: string;
    let sessionDir: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'sandbox-session-state-'));
        sessionDir = join(root, 'session');
        mkdirSync(sessionDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('derives a stable bounded key from the Pi session id', () => {
        const first = sessionStateFilename('../session-a');
        expect(first).toMatch(/^sandbox-state\.[a-f0-9]{64}\.json$/);
        expect(sessionStateFilename('../session-a')).toBe(first);
        expect(sessionStateFilename('session-b')).not.toBe(first);
        expect(first).not.toContain('/');
    });

    it('returns undefined when the state file is missing', () => {
        expect(loadSessionSandboxStatus(sessionDir, SESSION_ID)).toBeUndefined();
    });

    it('returns "enabled" for { enabled: true }', () => {
        writeFileSync(
            join(sessionDir, sessionStateFilename(SESSION_ID)),
            JSON.stringify({ enabled: true, updatedAt: '2026-01-01T00:00:00.000Z' }),
        );
        expect(loadSessionSandboxStatus(sessionDir, SESSION_ID)).toBe('enabled');
    });

    it('returns "disabled" for { enabled: false }', () => {
        writeFileSync(
            join(sessionDir, sessionStateFilename(SESSION_ID)),
            JSON.stringify({ enabled: false, updatedAt: '2026-01-01T00:00:00.000Z' }),
        );
        expect(loadSessionSandboxStatus(sessionDir, SESSION_ID)).toBe('disabled');
    });

    it('returns undefined for malformed JSON', () => {
        writeFileSync(join(sessionDir, sessionStateFilename(SESSION_ID)), '{ invalid');
        expect(loadSessionSandboxStatus(sessionDir, SESSION_ID)).toBeUndefined();
    });

    it('returns undefined when enabled field is missing', () => {
        writeFileSync(
            join(sessionDir, sessionStateFilename(SESSION_ID)),
            JSON.stringify({ updatedAt: '2026-01-01T00:00:00.000Z' }),
        );
        expect(loadSessionSandboxStatus(sessionDir, SESSION_ID)).toBeUndefined();
    });

    it('returns undefined when enabled is not boolean', () => {
        writeFileSync(
            join(sessionDir, sessionStateFilename(SESSION_ID)),
            JSON.stringify({ enabled: 'true' }),
        );
        expect(loadSessionSandboxStatus(sessionDir, SESSION_ID)).toBeUndefined();
    });

    it('returns undefined when sessionDir is empty or null', () => {
        expect(loadSessionSandboxStatus('', SESSION_ID)).toBeUndefined();
        expect(loadSessionSandboxStatus(sessionDir, '')).toBeUndefined();
    });

    it('returns undefined when sessionDir does not exist', () => {
        expect(
            loadSessionSandboxStatus(join(root, 'missing'), SESSION_ID),
        ).toBeUndefined();
    });

    it('ignores the ambiguous legacy directory-wide state file', () => {
        writeFileSync(
            join(sessionDir, 'sandbox-state.json'),
            JSON.stringify({ enabled: false }),
        );
        expect(loadSessionSandboxStatus(sessionDir, SESSION_ID)).toBeUndefined();
    });
});

describe('saveSessionSandboxStatus', () => {
    let root: string;
    let sessionDir: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'sandbox-session-state-save-'));
        sessionDir = join(root, 'session');
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('writes enabled status to a session-scoped state file', () => {
        saveSessionSandboxStatus(sessionDir, SESSION_ID, 'enabled');
        const file = join(sessionDir, sessionStateFilename(SESSION_ID));
        expect(existsSync(file)).toBe(true);
        const parsed = JSON.parse(readFileSync(file, 'utf-8'));
        expect(parsed.enabled).toBe(true);
        expect(typeof parsed.updatedAt).toBe('string');
        expect(() => new Date(parsed.updatedAt).toISOString()).not.toThrow();
    });

    it('writes disabled status to a session-scoped state file', () => {
        saveSessionSandboxStatus(sessionDir, SESSION_ID, 'disabled');
        const file = join(sessionDir, sessionStateFilename(SESSION_ID));
        const parsed = JSON.parse(readFileSync(file, 'utf-8'));
        expect(parsed.enabled).toBe(false);
    });

    it('overwrites an existing file atomically', () => {
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(
            join(sessionDir, sessionStateFilename(SESSION_ID)),
            JSON.stringify({ enabled: true, updatedAt: 'old' }),
        );
        saveSessionSandboxStatus(sessionDir, SESSION_ID, 'disabled');
        const parsed = JSON.parse(
            readFileSync(
                join(sessionDir, sessionStateFilename(SESSION_ID)),
                'utf-8',
            ),
        );
        expect(parsed.enabled).toBe(false);
        expect(parsed.updatedAt).not.toBe('old');
    });

    it('no-ops when sessionDir is empty', () => {
        expect(() =>
            saveSessionSandboxStatus('', SESSION_ID, 'enabled'),
        ).not.toThrow();
        expect(() =>
            saveSessionSandboxStatus(sessionDir, '', 'enabled'),
        ).not.toThrow();
    });

    it('no-ops when sessionDir is unwritable instead of throwing', () => {
        // Root path used as a file to make the dir creation fail.
        const blocker = join(root, 'blocker');
        writeFileSync(blocker, 'not a dir');
        expect(() =>
            saveSessionSandboxStatus(blocker, SESSION_ID, 'enabled'),
        ).not.toThrow();
    });
});

describe('envSandboxStatus', () => {
    afterEach(() => {
        delete process.env[ENV_OVERRIDE_KEY];
    });

    it('returns undefined when env var is unset', () => {
        delete process.env[ENV_OVERRIDE_KEY];
        expect(envSandboxStatus()).toBeUndefined();
    });

    it('returns "enabled" for "enabled"', () => {
        withEnv(ENV_OVERRIDE_KEY, 'enabled', () => {
            expect(envSandboxStatus()).toBe('enabled');
        });
    });

    it('returns "disabled" for "disabled"', () => {
        withEnv(ENV_OVERRIDE_KEY, 'disabled', () => {
            expect(envSandboxStatus()).toBe('disabled');
        });
    });

    it('is case-insensitive', () => {
        withEnv(ENV_OVERRIDE_KEY, 'ENABLED', () => {
            expect(envSandboxStatus()).toBe('enabled');
        });
        withEnv(ENV_OVERRIDE_KEY, 'Disabled', () => {
            expect(envSandboxStatus()).toBe('disabled');
        });
    });

    it('returns undefined for any other value', () => {
        withEnv(ENV_OVERRIDE_KEY, 'true', () => {
            expect(envSandboxStatus()).toBeUndefined();
        });
        withEnv(ENV_OVERRIDE_KEY, '', () => {
            expect(envSandboxStatus()).toBeUndefined();
        });
        withEnv(ENV_OVERRIDE_KEY, 'maybe', () => {
            expect(envSandboxStatus()).toBeUndefined();
        });
    });
});

describe('loadSandboxConfig resolution priority', () => {
    let root: string; let agentDir: string; let cwd: string;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'sandbox-config-resolution-')); agentDir = join(root, 'agent'); cwd = join(root, 'project'); mkdirSync(agentDir); mkdirSync(join(cwd, '.pi'), { recursive: true }); });
    afterEach(() => rmSync(root, { recursive: true, force: true }));
    it('resolves the versioned global file and project restriction without settings or a capabilities registry', () => {
        writeFileSync(join(agentDir, 'sandbox.json'), JSON.stringify({ version: 2, machineId: 'test-machine', mode: 'sandbox', network: { allowedDomains: ['example.com', 'api.example.com'] }, filesystem: { allowRead: [cwd, join(root, 'cache')] }, docker: { allowed: false } }), { mode: 0o600 });
        writeFileSync(join(cwd, '.pi', 'sandbox.json'), JSON.stringify({ network: { allowedDomains: ['api.example.com'], deniedDomains: ['api.example.com'] }, filesystem: { allowRead: ['src'] }, docker: { enabled: true } }));
        const result = loadSandboxConfig(cwd, { agentDir, machineId: 'test-machine' });
        expect(result.config.network.allowedDomains).toEqual([]); expect(result.config.filesystem.allowRead).toEqual([join(cwd, 'src')]); expect(result.config.docker).toEqual({ mode: 'disabled' }); expect(result.shell.mode).toBe('sandbox'); expect(result.shell.profile).toBe('custom');
    });
});

describe('explicitlyDisabled', () => {
    function result(
        source: LoadSandboxConfigResult['source'],
        enabled: boolean,
    ): LoadSandboxConfigResult {
        return {
            config: { enabled } as LoadSandboxConfigResult['config'],
            source,
            shell: { state: 'ready', requestedProfile: 'default', profile: 'default', projectRoot: '/project', authorityPath: '/authority', grants: emptyGrants(), requestedGrants: emptyGrants() },
        };
    }

    it('returns false when source is "default"', () => {
        expect(explicitlyDisabled(result('default', false))).toBe(false);
    });

    it('returns true when source is non-default and enabled is false', () => {
        expect(explicitlyDisabled(result('env', false))).toBe(true);
        expect(explicitlyDisabled(result('session-file', false))).toBe(true);
        expect(explicitlyDisabled(result('project-config', false))).toBe(true);
        expect(explicitlyDisabled(result('global-config', false))).toBe(true);
    });

    it('returns false when enabled is true', () => {
        expect(explicitlyDisabled(result('project-config', true))).toBe(false);
        expect(explicitlyDisabled(result('env', true))).toBe(false);
    });
});
