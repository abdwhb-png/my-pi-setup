import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let agentDir = '';

mock.module('@earendil-works/pi-coding-agent', () => ({
    getAgentDir: () => agentDir,
}));

const { default: extension } = await import('./index.ts');

afterEach(() => {
    if (agentDir) rmSync(agentDir, { recursive: true, force: true });
    agentDir = '';
});

function setup(initialYolo = false) {
    agentDir = mkdtempSync(join(tmpdir(), 'perm-addon-command-'));
    const configDir = join(agentDir, 'extensions', 'pi-permission-system');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
        join(configDir, 'config.json'),
        JSON.stringify({
            yoloMode: initialYolo,
            permission: { bash: { '*': 'allow' } },
        }),
    );

    let command:
        | {
              handler: (args: string, ctx: any) => Promise<void>;
          }
        | undefined;
    const pi = {
        registerFlag() {},
        registerCommand(name: string, definition: typeof command) {
            if (name === 'yolo') command = definition;
        },
        on() {},
        events: {},
    };
    extension(pi as any);

    const notifications: Array<[string, string]> = [];
    let reloads = 0;
    const ctx = {
        ui: {
            notify(message: string, level: string) {
                notifications.push([message, level]);
            },
        },
        async reload() {
            reloads += 1;
        },
    };

    return {
        command: command!,
        ctx,
        notifications,
        get reloads() {
            return reloads;
        },
        configPath: join(configDir, 'config.json'),
    };
}

describe('extension entry point', () => {
    it('exports a default function', async () => {
        const mod = await import('./index.ts');
        expect(typeof mod.default).toBe('function');
    });

    it('registers /yolo and toggles yolo mode by default', async () => {
        const fixture = setup(false);

        await fixture.command.handler('', fixture.ctx);

        expect(JSON.parse(readFileSync(fixture.configPath, 'utf-8'))).toEqual({
            yoloMode: true,
            permission: { bash: { '*': 'allow' } },
        });
        expect(fixture.notifications.at(-1)?.[0]).toContain('ON');
        expect(fixture.reloads).toBe(1);
    });

    it('supports explicit off without losing policy', async () => {
        const fixture = setup(true);

        await fixture.command.handler('off', fixture.ctx);

        expect(JSON.parse(readFileSync(fixture.configPath, 'utf-8'))).toEqual({
            yoloMode: false,
            permission: { bash: { '*': 'allow' } },
        });
        expect(fixture.reloads).toBe(1);
    });

    it('supports explicit on', async () => {
        const fixture = setup(false);

        await fixture.command.handler('on', fixture.ctx);

        expect(JSON.parse(readFileSync(fixture.configPath, 'utf-8'))).toEqual({
            yoloMode: true,
            permission: { bash: { '*': 'allow' } },
        });
        expect(fixture.reloads).toBe(1);
    });

    it('reports status without reloading', async () => {
        const fixture = setup(true);

        await fixture.command.handler('status', fixture.ctx);

        expect(fixture.notifications.at(-1)?.[0]).toContain('ON');
        expect(fixture.reloads).toBe(0);
    });
});
