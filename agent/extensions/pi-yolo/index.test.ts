import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { default: extension } = await import('./index.ts');
const { isYoloEnabled } = await import('./runner-patch.ts');

type Command = {
    handler: (args: string, ctx: CommandContext) => Promise<void>;
    getArgumentCompletions?: (
        prefix: string,
    ) => Array<{ value: string; label: string }> | null;
};

type CommandContext = {
    cwd: string;
    ui: {
        notify: (message: string, level: 'info' | 'warning' | 'error') => void;
    };
};

const temporaryDirectories: string[] = [];

afterEach(() => {
    isYoloEnabled();
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function setup(flagEnabled = false): {
    command: Command;
    sessionStart: (event: { reason: 'startup' | 'reload' | 'new' }, ctx: CommandContext) => void;
    flags: string[];
} {
    let command: Command | undefined;
    let sessionStart:
        | ((event: { reason: 'startup' | 'reload' | 'new' }, ctx: CommandContext) => void)
        | undefined;
    const flags: string[] = [];

    extension({
        registerFlag(name: string) {
            flags.push(name);
        },
        registerCommand(name: string, definition: Command) {
            if (name === 'yolo') command = definition;
        },
        getFlag(name: string) {
            return name === 'yolo' ? flagEnabled : undefined;
        },
        on(event: string, handler: typeof sessionStart) {
            if (event === 'session_start') sessionStart = handler;
        },
    } as never);

    if (!command || !sessionStart) throw new Error('pi-yolo did not register');
    return { command, sessionStart, flags };
}

function createContext(): {
    ctx: CommandContext;
    notifications: Array<[string, string]>;
} {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-yolo-index-'));
    temporaryDirectories.push(cwd);
    const notifications: Array<[string, string]> = [];
    return {
        ctx: {
            cwd,
            ui: {
                notify(message, level) {
                    notifications.push([message, level]);
                },
            },
        },
        notifications,
    };
}

describe('pi-yolo extension', () => {
    it('registers only the yolo flag and command', () => {
        const fixture = setup();

        expect(fixture.flags).toEqual(['yolo']);
        expect(fixture.command.getArgumentCompletions?.('')).toEqual([
            { value: 'on', label: 'on' },
            { value: 'off', label: 'off' },
            { value: 'status', label: 'status' },
        ]);
    });

    it('enables, disables, and reports yolo without reload', async () => {
        const fixture = setup();
        const { ctx, notifications } = createContext();
        fixture.sessionStart({ reason: 'startup' }, ctx);

        await fixture.command.handler('on', ctx);
        expect(isYoloEnabled()).toBe(true);

        await fixture.command.handler('off', ctx);
        expect(isYoloEnabled()).toBe(false);

        await fixture.command.handler('status', ctx);
        expect(notifications.at(-1)?.[0]).toContain('OFF');
    });

    it('keeps yolo disabled and reports invalid configuration', async () => {
        const fixture = setup(true);
        const { ctx, notifications } = createContext();
        mkdirSync(join(ctx.cwd, '.pi'), { recursive: true });
        writeFileSync(
            join(ctx.cwd, '.pi', 'pi-yolo.json'),
            JSON.stringify({ protectedExtensions: 'brainstorm-forcer' }),
        );

        expect(() => fixture.sessionStart({ reason: 'startup' }, ctx)).not.toThrow();
        expect(isYoloEnabled()).toBe(false);
        expect(notifications.at(-1)).toEqual([
            expect.stringContaining('Invalid YOLO configuration'),
            'error',
        ]);

        await fixture.command.handler('on', ctx);
        expect(isYoloEnabled()).toBe(false);
    });

    it('rejects enable after invalid config without persisting it through reload', async () => {
        const fixture = setup();
        const { ctx, notifications } = createContext();
        const configPath = join(ctx.cwd, '.pi', 'pi-yolo.json');
        mkdirSync(join(ctx.cwd, '.pi'), { recursive: true });
        writeFileSync(
            configPath,
            JSON.stringify({ protectedExtensions: 'brainstorm-forcer' }),
        );
        fixture.sessionStart({ reason: 'startup' }, ctx);

        await fixture.command.handler('on', ctx);
        expect(notifications.at(-1)).toEqual([
            expect.stringContaining('cannot be enabled'),
            'error',
        ]);

        writeFileSync(configPath, JSON.stringify({}));
        fixture.sessionStart({ reason: 'reload' }, ctx);

        expect(isYoloEnabled()).toBe(false);
    });

    it('reports resolved protected tools and extensions', async () => {
        const fixture = setup();
        const { ctx, notifications } = createContext();
        mkdirSync(join(ctx.cwd, '.pi'), { recursive: true });
        writeFileSync(
            join(ctx.cwd, '.pi', 'pi-yolo.json'),
            JSON.stringify({
                protectedTools: ['bash'],
                protectedExtensions: ['brainstorm-forcer'],
            }),
        );
        fixture.sessionStart({ reason: 'startup' }, ctx);

        await fixture.command.handler('status', ctx);

        expect(notifications.at(-1)?.[0]).toContain('bash');
        expect(notifications.at(-1)?.[0]).toContain('brainstorm-forcer');
    });

    it('rejects empty, toggle, and unknown command arguments', async () => {
        const fixture = setup();
        const { ctx, notifications } = createContext();
        fixture.sessionStart({ reason: 'startup' }, ctx);

        await fixture.command.handler('', ctx);
        await fixture.command.handler('toggle', ctx);
        await fixture.command.handler('unexpected', ctx);

        expect(isYoloEnabled()).toBe(false);
        expect(notifications).toHaveLength(3);
        expect(notifications.every(([message]) => message.includes('Usage: /yolo'))).toBe(true);
    });

    it('activates from the CLI flag at session start', () => {
        const fixture = setup(true);
        const { ctx } = createContext();

        fixture.sessionStart({ reason: 'startup' }, ctx);

        expect(isYoloEnabled()).toBe(true);
    });

    it('keeps an explicit off override through reload but resets it for a new session', async () => {
        const fixture = setup(true);
        const { ctx } = createContext();
        fixture.sessionStart({ reason: 'startup' }, ctx);
        await fixture.command.handler('off', ctx);

        fixture.sessionStart({ reason: 'reload' }, ctx);
        expect(isYoloEnabled()).toBe(false);

        fixture.sessionStart({ reason: 'new' }, ctx);
        expect(isYoloEnabled()).toBe(true);
    });

});
