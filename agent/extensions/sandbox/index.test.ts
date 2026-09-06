import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Theme } from '@earendil-works/pi-coding-agent';
import {
    envSandboxStatus,
    explicitlyDisabled,
    loadSandboxConfig,
    loadSessionSandboxStatus,
    renderSandboxStatusDetails,
    renderSandboxWidget,
    saveSessionSandboxStatus,
    sessionStateFilename,
    type LoadSandboxConfigResult,
} from './index';

const ENV_OVERRIDE_KEY = 'PI_SANDBOX_SESSION_STATUS';
const SESSION_ID = 'session-a';

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

describe('loadSandboxConfig', () => {
    let root: string;
    let agentDir: string;
    let cwd: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'sandbox-config-test-'));
        agentDir = join(root, 'agent');
        cwd = join(root, 'project');
        mkdirSync(agentDir, { recursive: true });
        mkdirSync(cwd, { recursive: true });
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('throws for malformed global legacy config', () => {
        writeFileSync(join(agentDir, 'sandbox.json'), '{ invalid');

        expect(() =>
            loadSandboxConfig(cwd, { agentDir, settingsManager: emptySettingsManager }),
        ).toThrow('Could not parse sandbox config');
    });

    it('throws for malformed project legacy config', () => {
        mkdirSync(join(cwd, '.pi'), { recursive: true });
        writeFileSync(join(cwd, '.pi', 'sandbox.json'), '{ invalid');

        expect(() =>
            loadSandboxConfig(cwd, { agentDir, settingsManager: emptySettingsManager }),
        ).toThrow('Could not parse sandbox config');
    });

    it('throws for malformed global and project settings values', () => {
        expect(() =>
            loadSandboxConfig(cwd, {
                agentDir,
                settingsManager: {
                    getGlobalSettings: () => ({ sandbox: 'invalid' }),
                    getProjectSettings: () => ({}),
                },
            }),
        ).toThrow('Invalid global sandbox settings');

        expect(() =>
            loadSandboxConfig(cwd, {
                agentDir,
                settingsManager: {
                    getGlobalSettings: () => ({}),
                    getProjectSettings: () => ({ sandbox: [] }),
                },
            }),
        ).toThrow('Invalid project sandbox settings');
    });

    it('throws when settings loading fails', () => {
        expect(() =>
            loadSandboxConfig(cwd, {
                agentDir,
                settingsManager: {
                    getGlobalSettings: () => {
                        throw new Error('settings unavailable');
                    },
                    getProjectSettings: () => ({}),
                },
            }),
        ).toThrow('Could not load sandbox settings: settings unavailable');
    });
});

describe('renderSandboxWidget', () => {
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
        expect(unsafe).toContain('fg:warning:targeted!');
        const full = renderSandboxWidget(fakeTheme(), 'on', {
            mode: 'full',
            unsafe: true,
        });
        expect(full).toContain('fg:error:full!');
        expect(full).not.toContain('docker.sock');
    });
});

describe('renderSandboxStatusDetails', () => {
    function resolvedWithDocker(
        docker: LoadSandboxConfigResult['config']['docker'],
    ): LoadSandboxConfigResult {
        return {
            source: 'project-config',
            config: {
                enabled: true,
                network: { allowedDomains: [], deniedDomains: [] },
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
                },
                docker,
            },
        };
    }

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

    it('warns for a targeted unsafe exception without exposing targets', () => {
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
        expect(output).toContain('unsafe-target exception');
        expect(output).not.toContain('/secret/docker.sock');
        expect(output).not.toContain('secret-container');
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
    let root: string;
    let agentDir: string;
    let cwd: string;
    let sessionDir: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'sandbox-config-resolution-'));
        agentDir = join(root, 'agent');
        cwd = join(root, 'project');
        sessionDir = join(root, 'sessions', 'abc');
        mkdirSync(agentDir, { recursive: true });
        mkdirSync(cwd, { recursive: true });
        mkdirSync(sessionDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
        delete process.env[ENV_OVERRIDE_KEY];
    });

    function load(opts: Parameters<typeof loadSandboxConfig>[1] = {}) {
        return loadSandboxConfig(cwd, {
            agentDir,
            settingsManager: emptySettingsManager,
            ...opts,
        });
    }

    it('returns source "default" with enabled=false when nothing overrides', () => {
        const result = load();
        expect(result.source).toBe('default');
        expect(result.config.enabled).toBe(false);
    });

    it('global enabled=true wins over default with source "global-config"', () => {
        writeFileSync(
            join(agentDir, 'sandbox.json'),
            JSON.stringify({ enabled: true }),
        );
        const result = load();
        expect(result.source).toBe('global-config');
        expect(result.config.enabled).toBe(true);
    });

    it('project enabled=false wins over global enabled=true with source "project-config"', () => {
        writeFileSync(
            join(agentDir, 'sandbox.json'),
            JSON.stringify({ enabled: true }),
        );
        mkdirSync(join(cwd, '.pi'));
        writeFileSync(
            join(cwd, '.pi', 'sandbox.json'),
            JSON.stringify({ enabled: false }),
        );
        const result = load();
        expect(result.source).toBe('project-config');
        expect(result.config.enabled).toBe(false);
    });

    it('session file enabled=true wins over project enabled=false with source "session-file"', () => {
        mkdirSync(join(cwd, '.pi'));
        writeFileSync(
            join(cwd, '.pi', 'sandbox.json'),
            JSON.stringify({ enabled: false }),
        );
        saveSessionSandboxStatus(sessionDir, SESSION_ID, 'enabled');
        const result = load({ sessionDir, sessionId: SESSION_ID });
        expect(result.source).toBe('session-file');
        expect(result.config.enabled).toBe(true);
    });

    it('env "disabled" wins over session file "enabled" with source "env"', () => {
        saveSessionSandboxStatus(sessionDir, SESSION_ID, 'enabled');
        const result = load({
            sessionDir,
            sessionId: SESSION_ID,
            envOverride: envSandboxStatus(),
        });
        withEnv(ENV_OVERRIDE_KEY, 'disabled', () => {
            const overridden = load({
                sessionDir,
                sessionId: SESSION_ID,
                envOverride: envSandboxStatus(),
            });
            expect(overridden.source).toBe('env');
            expect(overridden.config.enabled).toBe(false);
        });
        expect(result.source).toBe('session-file');
    });

    it('does not override network or filesystem fields with session/env overrides', () => {
        mkdirSync(join(cwd, '.pi'));
        writeFileSync(
            join(cwd, '.pi', 'sandbox.json'),
            JSON.stringify({
                enabled: true,
                network: { allowedDomains: ['example.com'] },
                filesystem: { denyRead: ['.secret'] },
            }),
        );
        saveSessionSandboxStatus(sessionDir, SESSION_ID, 'disabled');
        const result = load({ sessionDir, sessionId: SESSION_ID });
        expect(result.config.enabled).toBe(false);
        expect(result.config.network?.allowedDomains).toContain('example.com');
        expect(result.config.filesystem?.denyRead).toContain('.secret');
    });

    it('loads global Docker authority and applies only project narrowing', () => {
        writeFileSync(
            join(agentDir, 'sandbox.global.json'),
            JSON.stringify({
                docker: {
                    grants: [
                        {
                            projectRoot: cwd,
                            mode: 'targeted',
                            targets: [
                                {
                                    selector: {
                                        type: 'container-name',
                                        name: 'api',
                                    },
                                    operations: ['logs', 'inspect'],
                                    allowUnsafeTarget: true,
                                },
                            ],
                        },
                    ],
                },
            }),
            { mode: 0o600 },
        );
        mkdirSync(join(cwd, '.pi'));
        writeFileSync(
            join(cwd, '.pi', 'sandbox.json'),
            JSON.stringify({
                enabled: true,
                docker: {
                    mode: 'targeted',
                    targets: [
                        {
                            selector: {
                                type: 'container-name',
                                name: 'api',
                            },
                            operations: ['logs'],
                            allowUnsafeTarget: false,
                        },
                    ],
                },
            }),
        );

        expect(load().config.docker).toEqual({
            mode: 'targeted',
            endpoint: 'unix:///var/run/docker.sock',
            targets: [
                {
                    selector: { type: 'container-name', name: 'api' },
                    operations: ['logs'],
                    allowUnsafeTarget: false,
                },
            ],
        });
    });

    it('rejects Docker authority from ordinary global sandbox settings', () => {
        expect(() =>
            load({
                settingsManager: {
                    getGlobalSettings: () => ({
                        sandbox: { docker: { mode: 'full' } },
                    }),
                    getProjectSettings: () => ({}),
                },
            }),
        ).toThrow();
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
