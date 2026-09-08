import { describe, expect, it, mock } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

let permissionService:
    | {
          checkPermission: () => {
              state: 'allow' | 'ask' | 'deny';
              matchedPattern: string | null;
              reason?: string;
          };
      }
    | undefined;

mock.module('@gotgenes/pi-permission-system', () => ({
    getPermissionsService: () => permissionService,
}));

mock.module('./config.ts', () => ({
    loadConfig: () => ({ inherit: { safe_bash: 'bash' } }),
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
            on() {
                return () => {};
            },
        },
    };

    extension(pi as unknown as ExtensionAPI);

    return { listeners, flags, commands, commandDefinitions };
}

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

    it('bypasses tool_call when tool is not in inherit map', async () => {
        const { listeners } = setup();
        const onStart = listeners.get('session_start')!;
        const onToolCall = listeners.get('tool_call')!;

        await onStart({}, { cwd: '/nonexistent' });
        const result = await onToolCall(
            { toolName: 'unmapped_tool', input: {} },
            { cwd: '/nonexistent' },
        );

        expect(result).toBeUndefined();
    });
});
