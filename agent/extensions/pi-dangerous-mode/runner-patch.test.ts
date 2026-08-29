import { afterEach, describe, expect, it, mock } from 'bun:test';
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
const { DEFAULT_AUTOPILOT } = await import('./config.ts');
const { getRuntimeStatus, startRuntimeSession } =
    await import('./runtime-state.ts');

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

function toolCall(toolName: string, input: Record<string, unknown>): ToolCallEvent {
    return {
        type: 'tool_call',
        toolCallId: 'tool-call-id',
        toolName,
        input,
    };
}

function bashCall(): ToolCallEvent {
    return toolCall('bash', { command: 'echo ok' });
}

function startAutopilot(): void {
    startRuntimeSession({
        isReload: false,
        dangerousFlag: false,
        autopilotFlag: true,
        config: {
            protectedTools: [],
            protectedExtensions: [],
            autopilot: {
                ...DEFAULT_AUTOPILOT,
                guardedTools: [...DEFAULT_AUTOPILOT.guardedTools],
                guardedCommands: [...DEFAULT_AUTOPILOT.guardedCommands],
            },
        },
        now: 1_000,
    });
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

    it('blocks ask_user_question before extension handlers under Autopilot', async () => {
        const handler = mock(async () => ({ block: false }));
        const telemetry = mock(() => undefined);
        const onPromptBlocked = mock(() => undefined);
        const runner = createRunner([
            createFixtureExtension('ask-user.ts', handler),
        ]);
        installRunnerPatch(undefined, { telemetry, onPromptBlocked });
        startAutopilot();

        const result = await runner.emitToolCall(
            toolCall('ask_user_question', { questions: [] }),
        );

        expect(result).toEqual({
            block: true,
            reason: '[AUTOPILOT_PROMPT_BLOCKED] Human question blocked and suppressed. Choose the safest non-interactive path from current context without calling ask_user_question again. If no safe path exists, finish with autopilot_complete outcome=blocked.',
        });
        expect(handler).toHaveBeenCalledTimes(0);
        expect(onPromptBlocked).toHaveBeenCalledTimes(1);
        expect(telemetry).toHaveBeenCalledWith({
            event: 'prompt_blocked',
            kind: 'ask_user_question',
            agentActive: true,
        });
    });

    it('blocks guarded tools before Dangerous bypass and ends Autopilot', async () => {
        const handler = mock(async () => ({ block: false }));
        const telemetry = mock(() => undefined);
        const runner = createRunner([
            createFixtureExtension('deploy.ts', handler),
        ]);
        installRunnerPatch(undefined, { telemetry });
        startAutopilot();

        const result = await runner.emitToolCall(
            toolCall('deploy_service', { environment: 'production' }),
        );

        expect(result).toEqual({
            block: true,
            reason: '[AUTOPILOT_GUARD_BLOCKED] Autopilot guard blocked deploy via deploy_service. Finish with autopilot_complete outcome=blocked or choose a safe reversible path.',
        });
        expect(handler).toHaveBeenCalledTimes(0);
        expect(getRuntimeStatus().autopilot.phase).toBe('blocked');
        expect(telemetry).toHaveBeenCalledWith({
            event: 'guard_blocked',
            category: 'deploy',
            toolName: 'deploy_service',
        });
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
