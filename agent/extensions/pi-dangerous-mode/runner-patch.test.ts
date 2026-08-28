import { afterEach, describe, expect, it } from 'bun:test';
import {
    createExtensionRuntime,
    ExtensionRunner,
    type Extension,
    type ToolCallEvent,
} from '@earendil-works/pi-coding-agent';

const {
    getStatus,
    installRunnerPatch,
    isDangerousEnabled,
    setDangerousRuntimeState,
    setSessionOverride,
    startDangerousSession,
} = await import('./runner-patch.ts');

function createFixtureExtension(
    path: string,
    handler: () => Promise<{ block?: boolean; reason?: string } | undefined>,
): Extension {
    return {
        path,
        resolvedPath: path,
        sourceInfo: {} as never,
        handlers: new Map([['tool_call', [handler]]]),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
    } as Extension;
}

function createRunner(extensions: Extension[]): ExtensionRunner {
    return new ExtensionRunner(
        extensions,
        createExtensionRuntime(),
        '/tmp/pi-dangerous-mode-test',
        {} as never,
        {} as never,
    );
}

function bashCall(): ToolCallEvent {
    return {
        type: 'tool_call',
        toolCallId: 'tool-call-id',
        toolName: 'bash',
        input: { command: 'echo ok' },
    };
}

afterEach(() => {
    setDangerousRuntimeState({
        enabled: false,
        config: { protectedTools: [], protectedExtensions: [] },
    });
});

describe('pi-dangerous-mode runner patch', () => {
    it('fails closed when ExtensionRunner constructor is unavailable', () => {
        expect(installRunnerPatch(null)).toBe(false);
        expect(isDangerousEnabled()).toBe(false);
    });

    it('fails closed when ExtensionRunner lacks required methods', () => {
        class IncompleteRunner {}

        expect(installRunnerPatch(IncompleteRunner)).toBe(false);
        expect(isDangerousEnabled()).toBe(false);
    });

    it('preserves normal first-block dispatch while dangerous mode is disabled', async () => {
        const calls: string[] = [];
        const runner = createRunner([
            createFixtureExtension('blocker.ts', async () => {
                calls.push('blocker');
                return { block: true, reason: 'blocked' };
            }),
        ]);

        installRunnerPatch();
        setDangerousRuntimeState({
            enabled: false,
            config: { protectedTools: [], protectedExtensions: [] },
        });

        const result = await runner.emitToolCall(bashCall());

        expect(result).toEqual({ block: true, reason: 'blocked' });
        expect(calls).toEqual(['blocker']);
    });

    it('skips unprotected tool-call handlers while dangerous mode is enabled', async () => {
        const calls: string[] = [];
        const runner = createRunner([
            createFixtureExtension('blocker.ts', async () => {
                calls.push('blocker');
                return { block: true, reason: 'blocked' };
            }),
        ]);

        installRunnerPatch();
        setDangerousRuntimeState({
            enabled: true,
            config: { protectedTools: [], protectedExtensions: [] },
        });

        const result = await runner.emitToolCall(bashCall());

        expect(result).toBeUndefined();
        expect(calls).toEqual([]);
    });

    it('keeps a protected extension active under dangerous mode', async () => {
        const calls: string[] = [];
        const runner = createRunner([
            createFixtureExtension('/fixtures/blocker.ts', async () => {
                calls.push('blocker');
                return { block: true, reason: 'blocked' };
            }),
        ]);

        installRunnerPatch();
        setDangerousRuntimeState({
            enabled: true,
            config: {
                protectedTools: [],
                protectedExtensions: ['blocker.ts'],
            },
        });

        const result = await runner.emitToolCall(bashCall());

        expect(result).toEqual({ block: true, reason: 'blocked' });
        expect(calls).toEqual(['blocker']);
    });

    it('runs all handlers normally for a protected tool', async () => {
        const calls: string[] = [];
        const runner = createRunner([
            createFixtureExtension('observer.ts', async () => {
                calls.push('observer');
                return undefined;
            }),
            createFixtureExtension('blocker.ts', async () => {
                calls.push('blocker');
                return { block: true, reason: 'blocked' };
            }),
        ]);

        installRunnerPatch();
        setDangerousRuntimeState({
            enabled: true,
            config: { protectedTools: ['bash'], protectedExtensions: [] },
        });

        const result = await runner.emitToolCall(bashCall());

        expect(result).toEqual({ block: true, reason: 'blocked' });
        expect(calls).toEqual(['observer', 'blocker']);
    });

    it('preserves an explicit off override through reload', () => {
        startDangerousSession({
            isReload: false,
            flagEnabled: true,
            config: { protectedTools: ['bash'], protectedExtensions: [] },
        });
        expect(setSessionOverride(false)).toBe(true);
        expect(isDangerousEnabled()).toBe(false);

        startDangerousSession({
            isReload: true,
            flagEnabled: true,
            config: { protectedTools: ['read'], protectedExtensions: [] },
        });

        expect(isDangerousEnabled()).toBe(false);
        expect(getStatus().config.protectedTools).toEqual(['read']);
    });

    it('restores flag state for a new session after an explicit off override', () => {
        startDangerousSession({
            isReload: false,
            flagEnabled: true,
            config: { protectedTools: [], protectedExtensions: [] },
        });
        expect(setSessionOverride(false)).toBe(true);
        expect(isDangerousEnabled()).toBe(false);

        startDangerousSession({
            isReload: false,
            flagEnabled: true,
            config: { protectedTools: [], protectedExtensions: [] },
        });

        expect(isDangerousEnabled()).toBe(true);
    });

    it('fails closed and reports once when runner internals are incompatible', async () => {
        const invalid = createFixtureExtension('broken.ts', async () => undefined);
        invalid.handlers.set('tool_call', [{} as never]);
        const runner = createRunner([invalid]);
        const errors: string[] = [];
        runner.onError((error) => errors.push(error.error));

        installRunnerPatch();
        setDangerousRuntimeState({
            enabled: true,
            config: { protectedTools: [], protectedExtensions: [] },
        });

        let rejection: unknown;
        try {
            await runner.emitToolCall(bashCall());
            rejection = new Error('Expected incompatible runner to reject.');
        } catch (error) {
            rejection = error;
        }

        expect(rejection).toBeInstanceOf(Error);
        expect(isDangerousEnabled()).toBe(false);
        expect(errors).toEqual([
            'Dangerous mode disabled: incompatible ExtensionRunner (extension collection shape changed).',
        ]);
    });

    it('installs only one wrapper', () => {
        installRunnerPatch();
        const installed = ExtensionRunner.prototype.emitToolCall;

        installRunnerPatch();

        expect(ExtensionRunner.prototype.emitToolCall).toBe(installed);
    });
});
