import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
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
type CommandContext = {
    ui: { notify(message: string, level: string): void };
    waitForIdle(): Promise<void>;
    reload(): Promise<void>;
};
type CommandDefinition = {
    handler(args: string, ctx: CommandContext): Promise<void>;
};

function setup() {
    const listeners = new Map<string, EventListener>();
    const eventListeners = new Map<string, (payload?: unknown) => void>();
    const flags: string[] = [];
    const commands: string[] = [];
    const commandDefinitions = new Map<string, CommandDefinition>();

    const pi = {
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
        const { commandDefinitions } = setup();
        const command = commandDefinitions.get('yolo-permission');
        const notifications: Array<[string, string]> = [];
        let reloads = 0;
        const ctx: CommandContext = {
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
        const { commandDefinitions, eventListeners } = setup();
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
        expect(await authorize(details, query, log)).toEqual({ kind: 'allow' });
        await command.handler('off', ctx);
        expect(await authorize(details, query, log)).toEqual({ kind: 'defer' });
    });

    it('resets session yolo when a session starts', async () => {
        const { commandDefinitions, listeners } = setup();
        const command = commandDefinitions.get('yolo-permission')!;
        const onSessionStart = listeners.get('session_start')!;
        const notifications: Array<[string, string]> = [];
        const ctx: CommandContext = {
            ui: {
                notify(message: string, level: string) {
                    notifications.push([message, level]);
                },
            },
            async waitForIdle() {},
            async reload() {},
        };

        await command.handler('on', ctx);
        await onSessionStart({}, { cwd: '/nonexistent' });
        await command.handler('status', ctx);

        expect(notifications.at(-1)?.[0]).toContain('OFF');
    });

    it('applies session yolo to inherited asks only while enabled', async () => {
        permissionService = {
            checkPermission: () => ({
                state: 'ask',
                matchedPattern: 'rm -rf *',
            }),
        };
        const { commandDefinitions, listeners } = setup();
        const command = commandDefinitions.get('yolo-permission')!;
        const onSessionStart = listeners.get('session_start')!;
        const onToolCall = listeners.get('tool_call')!;
        const commandCtx: CommandContext = {
            ui: { notify() {} },
            async waitForIdle() {},
            async reload() {},
        };
        const toolCtx = { hasUI: false };

        await onSessionStart({}, { cwd: '/nonexistent' });
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
        const { listeners, commandDefinitions } = setup();
        const command = commandDefinitions.get('yolo-permission')!;
        const onSessionStart = listeners.get('session_start')!;
        const onSessionShutdown = listeners.get('session_shutdown')!;
        const setWidget = mock((_id: string, _value?: string[]) => {});
        const ctx = {
            hasUI: true,
            ui: { notify() {}, theme: undefined, setWidget },
            async waitForIdle() {},
            async reload() {},
        };

        await onSessionStart({}, ctx);
        expect(setWidget).toHaveBeenLastCalledWith('yolo-permission', [
            expect.stringContaining('yoloSession: off'),
        ]);

        await command.handler('on', ctx);
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
