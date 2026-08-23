import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { loadConfig, matchesExtension, matchesTool } =
    await import('./config.ts');

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
        });
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
