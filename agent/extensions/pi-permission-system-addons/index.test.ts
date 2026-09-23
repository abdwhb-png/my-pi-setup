import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    SessionManager,
    type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import type {
    AuthorizerLog,
    AuthorizerVerdict,
    PermissionQuery,
    PromptPermissionDetails,
} from '@gotgenes/pi-permission-system';

type AuthorizeFn = (
    details: PromptPermissionDetails,
    query: PermissionQuery,
    log: AuthorizerLog,
) => Promise<AuthorizerVerdict>;

const registerAuthorizer = mock(
    (_name: string, _authorize: AuthorizeFn) => () => {},
);

let permissionService:
    | {
          checkPermission?: () => {
              state: 'allow' | 'ask' | 'deny';
              matchedPattern: string | null;
              reason?: string;
          };
          registerAuthorizer?: typeof registerAuthorizer;
      }
    | undefined;

mock.module('@gotgenes/pi-permission-system', () => ({
    getPermissionsService: () => permissionService,
    PERMISSIONS_READY_CHANNEL: 'permissions:ready',
}));

mock.module('./config.ts', () => ({
    loadConfig: () => ({ inherit: { safe_bash: 'bash' } }),
}));

// Force the createWidget fallback path (ctx.ui.setWidget) in tests so the
// widget wiring is observable without pi-fancy-footer installed.
mock.module('pi-fancy-footer/api', () => ({
    contributeFancyFooterWidgets: () => {
        throw new Error('pi-fancy-footer not installed (test fallback)');
    },
    requestFancyFooterWidgetDiscovery: () => {},
    requestFancyFooterRefresh: () => {},
    getExtensionStatusesSnapshot: () => ({}),
    subscribeExtensionStatusesSnapshot: () => () => {},
    publishExtensionStatusesSnapshot: () => {},
    FANCY_FOOTER_EXTENSION_STATUSES_SNAPSHOT_EVENT:
        'fancy-footer:extension-statuses',
}));

mock.module('pi-fancy-footer/api/metrics', () => ({
    collectSessionUsageMetrics: () => ({}),
}));

const { default: extension } = await import('./index.ts');

type EventListener = (event: any, ctx: any) => Promise<any> | any;
type SessionEntry = { type: 'custom'; customType: string; data: unknown };
type SessionManagerFixture = {
    getSessionId(): string;
    getBranch(): Array<{ type: string; customType?: string; data?: unknown }>;
    appendCustomEntry?(customType: string, data: unknown): string;
};
type CommandContext = {
    ui: { notify(message: string, level: string): void };
    sessionManager: SessionManagerFixture;
    waitForIdle(): Promise<void>;
    reload(): Promise<void>;
};
type CommandDefinition = {
    handler(args: string, ctx: CommandContext): Promise<void>;
};

function setup(sessionManager?: SessionManagerFixture) {
    const entries: SessionEntry[] = [];
    const manager = sessionManager ?? {
        getSessionId: () => 'session-1',
        getBranch: () => entries,
    };
    const listeners = new Map<string, EventListener>();
    const eventListeners = new Map<string, (payload?: unknown) => void>();
    const flags: string[] = [];
    const commands: string[] = [];
    const commandDefinitions = new Map<string, CommandDefinition>();

    const pi = {
        appendEntry(customType: string, data: unknown) {
            if (manager.appendCustomEntry) {
                manager.appendCustomEntry(customType, data);
            } else {
                entries.push({ type: 'custom', customType, data });
            }
        },
        registerFlag(name: string) {
            flags.push(name);
        },
        registerCommand(name: string, definition: CommandDefinition) {
            commands.push(name);
            commandDefinitions.set(name, definition);
        },
        on(event: string, handler: EventListener) {
            listeners.set(event, handler);
        },
        events: {
            emit() {},
            on(channel: string, handler: (payload?: unknown) => void) {
                eventListeners.set(channel, handler);
                return () => {};
            },
        },
    };

    extension(pi as unknown as ExtensionAPI);

    return {
        listeners,
        eventListeners,
        flags,
        commands,
        commandDefinitions,
        sessionManager: manager,
        entries,
    };
}

beforeEach(() => {
    permissionService = undefined;
    registerAuthorizer.mockClear();
});

describe('extension entry point', () => {
    it('exports a default function', async () => {
        const mod = await import('./index.ts');
        expect(typeof mod.default).toBe('function');
    });

    it('registers yolo-permission command without a CLI flag', () => {
        const { flags, commands, listeners } = setup();

        expect(flags).toHaveLength(0);
        expect(commands).toEqual(['yolo-permission']);
        expect(listeners.has('session_start')).toBe(true);
        expect(listeners.has('session_shutdown')).toBe(true);
        expect(listeners.has('tool_call')).toBe(true);
    });

    it('enables session yolo immediately without reloading', async () => {
        const { commandDefinitions, sessionManager } = setup();
        const command = commandDefinitions.get('yolo-permission');
        const notifications: Array<[string, string]> = [];
        let reloads = 0;
        const ctx: CommandContext = {
            sessionManager,
            ui: {
                notify(message: string, level: string) {
                    notifications.push([message, level]);
                },
            },
            async waitForIdle() {},
            async reload() {
                reloads += 1;
            },
        };

        expect(command).toBeDefined();
        await command!.handler('on', ctx);
        await command!.handler('status', ctx);
        expect(notifications.at(-1)?.[0]).toContain('ON');

        await command!.handler('off', ctx);
        await command!.handler('status', ctx);

        expect(reloads).toBe(0);
        expect(notifications.at(-1)?.[0]).toContain('OFF');
    });

    it('allows main permission-system asks while session yolo is on', async () => {
        permissionService = { registerAuthorizer };
        const { commandDefinitions, eventListeners, listeners, sessionManager } = setup();
        const onPermissionsReady = eventListeners.get('permissions:ready');

        expect(onPermissionsReady).toBeDefined();
        onPermissionsReady!({ sessionId: 'test-session', adjudicatesLocally: true });
        expect(registerAuthorizer).toHaveBeenCalledTimes(1);

        const [, authorize] = registerAuthorizer.mock.calls[0] as unknown as [
            string,
            AuthorizeFn,
        ];
        const command = commandDefinitions.get('yolo-permission')!;
        const ctx: CommandContext = {
            sessionManager,
            ui: { notify() {} },
            async waitForIdle() {},
            async reload() {},
        };
        // Fixture predates the v33 PromptPayload contract; the authorizer
        // under test ignores `details`, so a full payload is ceremony.
        const details = {
            requestId: 'request-id',
            source: 'tool_call',
            agentName: null,
            message: 'Allow git worktree?',
            surface: 'bash',
            command: 'git worktree add /tmp/example',
            accessIntent: {
                surface: 'bash',
                matchValues: ['git worktree add /tmp/example'],
                boundaryValue: null,
            },
        } as unknown as PromptPermissionDetails;
        const query = {} as PermissionQuery;
        const log = { review() {}, debug() {} };

        expect(await authorize(details, query, log)).toEqual({ kind: 'defer' });
        await command.handler('on', ctx);
        await listeners.get('session_start')!({ reason: 'reload' }, { ...ctx, cwd: '/nonexistent' });
        expect(await authorize(details, query, log)).toEqual({ kind: 'allow' });
        await command.handler('off', ctx);
        expect(await authorize(details, query, log)).toEqual({ kind: 'defer' });
    });

    it('restores last explicit choice on reload and resume, but not new or fork', async () => {
        const { commandDefinitions, listeners, sessionManager, entries } = setup();
        const command = commandDefinitions.get('yolo-permission')!;
        const onSessionStart = listeners.get('session_start')!;
        const notifications: Array<[string, string]> = [];
        const ctx: CommandContext = {
            sessionManager,
            ui: {
                notify(message: string, level: string) {
                    notifications.push([message, level]);
                },
            },
            async waitForIdle() {},
            async reload() {},
        };

        await onSessionStart({ reason: 'startup' }, { ...ctx, cwd: '/nonexistent' });
        await command.handler('on', ctx);
        expect(entries).toEqual([
            {
                type: 'custom',
                customType: 'pi-permission-system-addons:yolo-session',
                data: { sessionId: 'session-1', enabled: true },
            },
        ]);
        await command.handler('on', ctx);
        expect(entries).toHaveLength(1);

        for (const reason of ['reload', 'resume', 'startup']) {
            await onSessionStart({ reason }, { ...ctx, cwd: '/nonexistent' });
            await command.handler('status', ctx);
            expect(notifications.at(-1)?.[0]).toContain('ON');
        }
        await command.handler('off', ctx);
        await command.handler('off', ctx);
        expect(entries).toHaveLength(2);
        await onSessionStart({ reason: 'reload' }, { ...ctx, cwd: '/nonexistent' });
        await command.handler('status', ctx);
        expect(notifications.at(-1)?.[0]).toContain('OFF');

        await command.handler('on', ctx);
        for (const reason of ['new', 'fork']) {
            await onSessionStart({ reason }, { ...ctx, cwd: '/nonexistent' });
            await command.handler('status', ctx);
            expect(notifications.at(-1)?.[0]).toContain('OFF');
        }
    });

    it('fails closed for an invalid latest entry or another session ID', async () => {
        const { commandDefinitions, listeners, sessionManager, entries } = setup();
        const command = commandDefinitions.get('yolo-permission')!;
        const start = listeners.get('session_start')!;
        const notices: string[] = [];
        const ctx: CommandContext = {
            sessionManager,
            ui: { notify(message) { notices.push(message); } },
            async waitForIdle() {},
            async reload() {},
        };

        entries.push({
            type: 'custom',
            customType: 'pi-permission-system-addons:yolo-session',
            data: { sessionId: 'other-session', enabled: true },
        });
        await start({ reason: 'startup' }, { ...ctx, cwd: '/nonexistent' });
        await command.handler('status', ctx);
        expect(notices.at(-1)).toContain('OFF');

        await command.handler('on', ctx);
        entries.push({
            type: 'custom',
            customType: 'pi-permission-system-addons:yolo-session',
            data: { sessionId: 'session-1', enabled: 'true' },
        });
        await start({ reason: 'reload' }, { ...ctx, cwd: '/nonexistent' });
        await command.handler('status', ctx);
        expect(notices.at(-1)).toContain('OFF');
    });

    it('tracks the active branch after session tree navigation', async () => {
        const { commandDefinitions, listeners, sessionManager, entries } = setup();
        const command = commandDefinitions.get('yolo-permission')!;
        const ctx: CommandContext = {
            sessionManager,
            ui: { notify() {} },
            async waitForIdle() {},
            async reload() {},
        };
        const tree = listeners.get('session_tree');
        expect(tree).toBeDefined();
        await command.handler('on', ctx);
        await command.handler('off', ctx);
        entries.pop(); // Navigate to the branch where ON was the last decision.
        await tree!({}, { ...ctx, cwd: '/nonexistent' });
        await command.handler('status', {
            ...ctx,
            ui: { notify(message) { expect(message).toContain('ON'); } },
        });
        entries.pop(); // Navigate before the first decision.
        await tree!({}, { ...ctx, cwd: '/nonexistent' });
        await command.handler('status', {
            ...ctx,
            ui: { notify(message) { expect(message).toContain('OFF'); } },
        });
    });

    it('restores only this session from a reopened Pi session file without adding LLM context', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'yolo-session-'));
        try {
            const firstManager = SessionManager.create(directory, directory);
            // Pi flushes a new session to disk only after an assistant message.
            firstManager.appendMessage({
                role: 'assistant',
                content: [{ type: 'text', text: 'Session persistence fixture.' }],
                api: 'openai-responses',
                provider: 'openai',
                model: 'test-model',
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        total: 0,
                    },
                },
                stopReason: 'stop',
                timestamp: Date.now(),
            });
            const first = setup(firstManager);
            const ctx = (sessionManager: SessionManager) => ({
                cwd: directory,
                sessionManager,
                ui: { notify() {} },
                async waitForIdle() {},
                async reload() {},
            });
            await first.listeners.get('session_start')!({ reason: 'startup' }, ctx(firstManager));
            await first.commandDefinitions.get('yolo-permission')!.handler('on', ctx(firstManager));
            const file = firstManager.getSessionFile();
            expect(file).toBeDefined();
            expect(firstManager.getBranch().some(
                (entry) => entry.type === 'custom' &&
                    entry.customType === 'pi-permission-system-addons:yolo-session',
            )).toBe(true);
            expect(JSON.stringify(firstManager.buildSessionContext())).not.toContain(
                'pi-permission-system-addons:yolo-session',
            );
            await first.listeners.get('session_shutdown')!({}, ctx(firstManager));

            const reopenedManager = SessionManager.open(file!, directory, directory);
            const reopened = setup(reopenedManager);
            const notices: string[] = [];
            const resumedCtx = {
                ...ctx(reopenedManager),
                ui: { notify(message: string) { notices.push(message); } },
            };
            await reopened.listeners.get('session_start')!({ reason: 'startup' }, resumedCtx);
            await reopened.commandDefinitions.get('yolo-permission')!.handler('status', resumedCtx);
            expect(notices.at(-1)).toContain('ON');
            await reopened.commandDefinitions.get('yolo-permission')!.handler('off', resumedCtx);

            const againManager = SessionManager.open(file!, directory, directory);
            const again = setup(againManager);
            const againCtx = {
                ...ctx(againManager),
                ui: { notify(message: string) { notices.push(message); } },
            };
            await again.listeners.get('session_start')!({ reason: 'resume' }, againCtx);
            await again.commandDefinitions.get('yolo-permission')!.handler('status', againCtx);
            expect(notices.at(-1)).toContain('OFF');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('applies session yolo to inherited asks only while enabled', async () => {
        permissionService = {
            checkPermission: () => ({
                state: 'ask',
                matchedPattern: 'rm -rf *',
            }),
        };
        const { commandDefinitions, listeners, sessionManager } = setup();
        const command = commandDefinitions.get('yolo-permission')!;
        const onSessionStart = listeners.get('session_start')!;
        const onToolCall = listeners.get('tool_call')!;
        const commandCtx: CommandContext = {
            sessionManager,
            ui: { notify() {} },
            async waitForIdle() {},
            async reload() {},
        };
        const toolCtx = { hasUI: false };

        await onSessionStart({ reason: 'startup' }, { cwd: '/nonexistent', sessionManager });
        await command.handler('on', commandCtx);
        expect(
            await onToolCall(
                { toolName: 'safe_bash', input: { command: 'rm -rf /tmp' } },
                toolCtx,
            ),
        ).toBeUndefined();

        await command.handler('off', commandCtx);
        expect(
            await onToolCall(
                { toolName: 'safe_bash', input: { command: 'rm -rf /tmp' } },
                toolCtx,
            ),
        ).toEqual({
            block: true,
            reason: expect.stringContaining('Permission required'),
        });
    });

    it("updates the yolo-permission widget through the session lifecycle", async () => {
        const { listeners, commandDefinitions, sessionManager } = setup();
        const command = commandDefinitions.get('yolo-permission')!;
        const onSessionStart = listeners.get('session_start')!;
        const onSessionShutdown = listeners.get('session_shutdown')!;
        const setWidget = mock((_id: string, _value?: string[]) => {});
        const ctx = {
            sessionManager,
            hasUI: true,
            ui: { notify() {}, theme: undefined, setWidget },
            async waitForIdle() {},
            async reload() {},
        };

        await onSessionStart({ reason: 'startup' }, { ...ctx, cwd: '/nonexistent' });
        expect(setWidget).toHaveBeenLastCalledWith('yolo-permission', [
            expect.stringContaining('yoloSession: off'),
        ]);

        await command.handler('on', ctx);
        await onSessionStart({ reason: 'reload' }, { ...ctx, cwd: '/nonexistent' });
        expect(setWidget).toHaveBeenLastCalledWith('yolo-permission', [
            expect.stringContaining('yoloSession: on'),
        ]);

        await command.handler('off', ctx);
        expect(setWidget).toHaveBeenLastCalledWith('yolo-permission', [
            expect.stringContaining('yoloSession: off'),
        ]);

        onSessionShutdown({}, ctx);
        expect(setWidget).toHaveBeenLastCalledWith(
            'yolo-permission',
            undefined,
        );
    });
});
