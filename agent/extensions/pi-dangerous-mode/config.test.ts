import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { loadConfig, matchesExtension, matchesTool } =
    await import('./config.ts');

const DEFAULT_AUTOPILOT = {
    maxTurns: 8,
    maxRetries: 2,
    maxDurationMs: 600_000,
    guardedTools: [
        '*deploy*',
        '*publish*',
        '*purchase*',
        '*payment*',
        '*delete*',
        '*destroy*',
    ],
    guardedCommands: [
        '*git push*',
        '*gh pr create*',
        '*gh release create*',
        '*npm publish*',
        '*bun publish*',
        '*pnpm publish*',
        '*docker push*',
        '*kubectl apply*',
        '*kubectl delete*',
        '*helm install*',
        '*helm upgrade*',
        '*terraform apply*',
        '*terraform destroy*',
    ],
};

const paths: string[] = [];

afterEach(() => {
    for (const path of paths.splice(0)) {
        rmSync(path, { recursive: true, force: true });
    }
});

function createDir(prefix: string): string {
    const path = mkdtempSync(join(tmpdir(), prefix));
    paths.push(path);
    return path;
}

function writeJson(path: string, value: unknown): void {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(value), 'utf8');
}

function writeRaw(path: string, value: string): void {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, value, 'utf8');
}

describe('pi-dangerous-mode configuration', () => {
    it('uses empty protected lists when configuration is absent', () => {
        const agentDir = createDir('pi-dangerous-mode-agent-');
        const cwd = createDir('pi-dangerous-mode-cwd-');

        expect(loadConfig(cwd, agentDir)).toEqual({
            protectedTools: [],
            protectedExtensions: [],
            autopilot: DEFAULT_AUTOPILOT,
        });
    });

    it('keeps an undeclared global list when project config overrides the other list', () => {
        const agentDir = createDir('pi-dangerous-mode-agent-');
        const cwd = createDir('pi-dangerous-mode-cwd-');
        writeJson(join(agentDir, 'pi-dangerous-mode.json'), {
            protectedTools: ['safe_bash'],
            protectedExtensions: ['brainstorm-forcer'],
        });
        writeJson(join(cwd, '.pi', 'pi-dangerous-mode.json'), {
            protectedTools: ['mcp:*'],
        });

        expect(loadConfig(cwd, agentDir)).toEqual({
            protectedTools: ['mcp:*'],
            protectedExtensions: ['brainstorm-forcer'],
            autopilot: DEFAULT_AUTOPILOT,
        });
    });

    it('replaces each declared global list with its project list', () => {
        const agentDir = createDir('pi-dangerous-mode-agent-');
        const cwd = createDir('pi-dangerous-mode-cwd-');
        writeJson(join(agentDir, 'pi-dangerous-mode.json'), {
            protectedTools: ['safe_bash'],
            protectedExtensions: ['brainstorm-forcer'],
        });
        writeJson(join(cwd, '.pi', 'pi-dangerous-mode.json'), {
            protectedTools: ['bash'],
            protectedExtensions: ['*pi-permission-system*'],
        });

        expect(loadConfig(cwd, agentDir)).toEqual({
            protectedTools: ['bash'],
            protectedExtensions: ['*pi-permission-system*'],
            autopilot: DEFAULT_AUTOPILOT,
        });
    });

    it('deep-merges Autopilot fields while replacing declared lists', () => {
        const agentDir = createDir('pi-dangerous-mode-agent-');
        const cwd = createDir('pi-dangerous-mode-cwd-');
        writeJson(join(agentDir, 'pi-dangerous-mode.json'), {
            autopilot: {
                maxTurns: 12,
                guardedTools: ['global-guard-*'],
                guardedCommands: ['*global command*'],
            },
        });
        writeJson(join(cwd, '.pi', 'pi-dangerous-mode.json'), {
            autopilot: {
                maxRetries: 1,
                guardedTools: ['project-guard-*'],
            },
        });

        expect(loadConfig(cwd, agentDir).autopilot).toEqual({
            maxTurns: 12,
            maxRetries: 1,
            maxDurationMs: 600_000,
            guardedTools: ['project-guard-*'],
            guardedCommands: ['*global command*'],
        });
    });

    it('replaces default guard lists when global config declares them', () => {
        const agentDir = createDir('pi-dangerous-mode-agent-');
        const cwd = createDir('pi-dangerous-mode-cwd-');
        writeJson(join(agentDir, 'pi-dangerous-mode.json'), {
            autopilot: {
                guardedTools: ['custom-tool'],
                guardedCommands: ['*custom command*'],
            },
        });

        expect(loadConfig(cwd, agentDir).autopilot).toEqual({
            ...DEFAULT_AUTOPILOT,
            guardedTools: ['custom-tool'],
            guardedCommands: ['*custom command*'],
        });
    });

    it('rejects malformed declared Autopilot fields', () => {
        const invalidValues = [
            { maxTurns: 0 },
            { maxRetries: -1 },
            { maxDurationMs: 1.5 },
            { guardedTools: ['valid', 42] },
            { guardedCommands: 'not-a-list' },
        ];

        for (const autopilot of invalidValues) {
            const agentDir = createDir('pi-dangerous-mode-agent-');
            const cwd = createDir('pi-dangerous-mode-cwd-');
            writeJson(join(agentDir, 'pi-dangerous-mode.json'), { autopilot });

            expect(() => loadConfig(cwd, agentDir)).toThrow(
                'Invalid configuration',
            );
        }
    });

    it('rejects a non-object declared Autopilot config', () => {
        const agentDir = createDir('pi-dangerous-mode-agent-');
        const cwd = createDir('pi-dangerous-mode-cwd-');
        writeJson(join(agentDir, 'pi-dangerous-mode.json'), {
            autopilot: [],
        });

        expect(() => loadConfig(cwd, agentDir)).toThrow(
            'Invalid configuration',
        );
    });

    it('rejects malformed global JSON', () => {
        const agentDir = createDir('pi-dangerous-mode-agent-');
        const cwd = createDir('pi-dangerous-mode-cwd-');
        writeRaw(join(agentDir, 'pi-dangerous-mode.json'), '{');

        expect(() => loadConfig(cwd, agentDir)).toThrow(
            'Invalid configuration: cannot parse',
        );
    });

    it('rejects a non-object project configuration', () => {
        const agentDir = createDir('pi-dangerous-mode-agent-');
        const cwd = createDir('pi-dangerous-mode-cwd-');
        writeJson(join(cwd, '.pi', 'pi-dangerous-mode.json'), []);

        expect(() => loadConfig(cwd, agentDir)).toThrow(
            'Invalid configuration',
        );
    });

    it('rejects a declared protection list containing invalid entries', () => {
        const agentDir = createDir('pi-dangerous-mode-agent-');
        const cwd = createDir('pi-dangerous-mode-cwd-');
        writeJson(join(agentDir, 'pi-dangerous-mode.json'), {
            protectedTools: ['bash', 42],
        });

        expect(() => loadConfig(cwd, agentDir)).toThrow(
            'Invalid configuration',
        );
    });
});

describe('pi-dangerous-mode matchers', () => {
    it('matches exact tool names and star globs', () => {
        expect(matchesTool('bash', ['bash'])).toBe(true);
        expect(matchesTool('mcp:github/search', ['mcp:*'])).toBe(true);
        expect(matchesTool('safe_bash', ['bash'])).toBe(false);
    });

    it('matches extension path segments and complete path globs', () => {
        expect(
            matchesExtension(
                '/home/user/.pi/agent/extensions/brainstorm-forcer/index.ts',
                ['brainstorm-forcer'],
            ),
        ).toBe(true);
        expect(
            matchesExtension(
                '/home/user/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system/index.ts',
                ['*pi-permission-system*'],
            ),
        ).toBe(true);
        expect(
            matchesExtension(
                '/home/user/.pi/agent/extensions/safe-bash/index.ts',
                ['brainstorm-forcer'],
            ),
        ).toBe(false);
    });
});
