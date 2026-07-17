import { describe, it, expect } from 'bun:test';
import {
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { loadConfig, readUpstreamYoloMode, writeUpstreamYoloMode } =
    await import('./config.ts');

function withAgentConfig(
    configData: unknown | null,
    fn: (agentDir: string) => void,
) {
    const agentDir = mkdtempSync(join(tmpdir(), 'perm-addon-test-'));
    if (configData !== null) {
        writeFileSync(
            join(agentDir, 'pi-permission-system-addons.json'),
            JSON.stringify(configData),
        );
    }
    try {
        fn(agentDir);
    } finally {
        rmSync(agentDir, { recursive: true, force: true });
    }
}

describe('loadConfig', () => {
    it('returns empty inherit map when config file missing', () => {
        const agentDir = mkdtempSync(join(tmpdir(), 'perm-addon-test-'));
        try {
            expect(loadConfig(agentDir, agentDir)).toEqual({
                inherit: {},
            });
        } finally {
            rmSync(agentDir, { recursive: true, force: true });
        }
    });

    it('loads valid inherit map', () => {
        withAgentConfig(
            { inherit: { safe_bash: 'bash', hypa_shell: 'bash' } },
            (agentDir) => {
                const cfg = loadConfig(agentDir, agentDir);
                expect(cfg.inherit).toEqual({
                    safe_bash: 'bash',
                    hypa_shell: 'bash',
                });
            },
        );
    });

    it('skips non-string target surface values', () => {
        withAgentConfig({ inherit: { t: 42 } }, (agentDir) => {
            expect(loadConfig(agentDir, agentDir)).toEqual({
                inherit: {},
            });
        });
    });

    it('handles non-object root', () => {
        withAgentConfig('bad', (agentDir) => {
            expect(loadConfig(agentDir, agentDir)).toEqual({
                inherit: {},
            });
        });
    });

    it('returns empty inherit when inherit key omitted', () => {
        withAgentConfig({}, (agentDir) => {
            expect(loadConfig(agentDir, agentDir)).toEqual({
                inherit: {},
            });
        });
    });

    it('skips array inherit value', () => {
        withAgentConfig({ inherit: ['bash'] }, (agentDir) => {
            expect(loadConfig(agentDir, agentDir)).toEqual({
                inherit: {},
            });
        });
    });

    it('ignores legacy addon yolo because upstream yoloMode is authoritative', () => {
        withAgentConfig({ yolo: true, inherit: {} }, (agentDir) => {
            expect(loadConfig(agentDir, agentDir)).toEqual({
                inherit: {},
            });
        });
    });
});

describe('upstream yolo config', () => {
    it('reads yoloMode from pi-permission-system config', () => {
        const agentDir = mkdtempSync(join(tmpdir(), 'perm-addon-test-'));
        const configDir = join(agentDir, 'extensions', 'pi-permission-system');
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
            join(configDir, 'config.json'),
            JSON.stringify({ yoloMode: true }),
        );

        try {
            expect(readUpstreamYoloMode(agentDir)).toBe(true);
        } finally {
            rmSync(agentDir, { recursive: true, force: true });
        }
    });

    it('writes yoloMode without changing existing permission policy', () => {
        const agentDir = mkdtempSync(join(tmpdir(), 'perm-addon-test-'));
        const configDir = join(agentDir, 'extensions', 'pi-permission-system');
        const configPath = join(configDir, 'config.json');
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
            configPath,
            JSON.stringify({
                yoloMode: false,
                permission: { bash: { '*': 'allow', 'sudo *': 'ask' } },
            }),
        );

        try {
            writeUpstreamYoloMode(agentDir, true);
            expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual({
                yoloMode: true,
                permission: { bash: { '*': 'allow', 'sudo *': 'ask' } },
            });
            expect(existsSync(`${configPath}.tmp`)).toBe(false);
        } finally {
            rmSync(agentDir, { recursive: true, force: true });
        }
    });
});
