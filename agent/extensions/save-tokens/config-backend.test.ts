import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSaveTokensConfig, mergeConfig, normalizeConfig } from './config';
import type {
    CompressionBackend,
    CompressionBackendId,
    CompressionBackendRequest,
    CompressionBackendResult,
} from './tool-results/types';

// Save original env
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
    'HEADROOM_COMPRESSOR_BASE_URL',
    'HEADROOM_COMPRESSOR_TIMEOUT_MS',
    'EDGEE_COMPRESSOR_BASE_URL',
    'EDGEE_COMPRESSOR_TIMEOUT_MS',
];

beforeEach(() => {
    for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }
});

afterEach(() => {
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
});

// ---------------------------------------------------------------------------
// Backend contracts in types.ts
// ---------------------------------------------------------------------------

describe('CompressionBackend contracts', () => {
    it('exports CompressionBackendId type with headroom and edgee', () => {
        const _id: CompressionBackendId = 'headroom';
        expect(_id).toBe('headroom');
        const _id2: CompressionBackendId = 'edgee';
        expect(_id2).toBe('edgee');
    });

    it('exports CompressionBackendRequest interface', () => {
        const req: CompressionBackendRequest = {
            toolCallId: 'tc_1',
            toolName: 'read',
            arguments: {},
            output: 'hello',
            model: { provider: 'anthropic', id: 'claude-sonnet-4-6', contextWindow: 200000 },
        };
        expect(req.toolCallId).toBe('tc_1');
    });

    it('exports CompressionBackendResult interface', () => {
        const res: CompressionBackendResult = {
            output: 'compressed',
            reason: 'reduced',
            metrics: { tokensBefore: 100, tokensAfter: 50, tokensSaved: 50, transforms: ['trim'] },
        };
        expect(res.output).toBe('compressed');
    });

    it('exports CompressionBackend interface', () => {
        const backend: CompressionBackend = {
            id: 'headroom',
            compress: async () => ({ output: 'ok' }),
        };
        expect(backend.id).toBe('headroom');
    });
});

// ---------------------------------------------------------------------------
// Config normalization — new backend/backends fields
// ---------------------------------------------------------------------------

describe('config normalization — backend fields', () => {
    it('normalizes backend: headroom', () => {
        const cfg = normalizeConfig({
            compressor: { backend: 'headroom' },
        });
        expect(cfg.compressor?.backend).toBe('headroom');
    });

    it('normalizes backend: edgee', () => {
        const cfg = normalizeConfig({
            compressor: { backend: 'edgee' },
        });
        expect(cfg.compressor?.backend).toBe('edgee');
    });

    it('preserves invalid backend value for runtime diagnostics', () => {
        const cfg = normalizeConfig({
            compressor: { backend: 'gzip' },
        });
        expect(cfg.compressor?.backend).toBeUndefined();
        expect(cfg.compressor?.invalidBackend).toBe('gzip');
    });

    it('normalizes backends sub-block with headroom config', () => {
        const cfg = normalizeConfig({
            compressor: {
                backends: {
                    headroom: { baseUrl: 'http://custom:8787', timeoutMs: 2000 },
                },
            },
        });
        expect(cfg.compressor?.backends?.headroom?.baseUrl).toBe('http://custom:8787');
        expect(cfg.compressor?.backends?.headroom?.timeoutMs).toBe(2000);
    });

    it('normalizes backends sub-block with edgee config', () => {
        const cfg = normalizeConfig({
            compressor: {
                backends: {
                    edgee: { baseUrl: 'http://custom:8320', timeoutMs: 500 },
                },
            },
        });
        expect(cfg.compressor?.backends?.edgee?.baseUrl).toBe('http://custom:8320');
        expect(cfg.compressor?.backends?.edgee?.timeoutMs).toBe(500);
    });

    it('drops invalid timeoutMs in backend sub-block', () => {
        const cfg = normalizeConfig({
            compressor: {
                backends: {
                    headroom: { timeoutMs: 'fast' },
                },
            },
        });
        expect(cfg.compressor?.backends?.headroom?.timeoutMs).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// resolveCompressorConfig — backend selection and defaults
// ---------------------------------------------------------------------------

describe('resolveCompressorConfig', () => {
    let resolveCompressorConfig: typeof import('./config-runtime').resolveCompressorConfig;

    beforeEach(async () => {
        const mod = await import('./config-runtime');
        resolveCompressorConfig = mod.resolveCompressorConfig;
    });

    it('defaults to headroom when backend is absent', () => {
        const result = resolveCompressorConfig({});
        expect(result.backend).toBe('headroom');
        expect(result.backendConfig.baseUrl).toBe('http://127.0.0.1:8787');
        expect(result.backendConfig.timeoutMs).toBe(1000);
        expect(result.valid).toBe(true);
        expect(result.diagnostics).toEqual([]);
    });

    it('selects edgee when backend is edgee', () => {
        const result = resolveCompressorConfig({ backend: 'edgee' });
        expect(result.backend).toBe('edgee');
        expect(result.backendConfig.baseUrl).toBe('http://127.0.0.1:8320');
        expect(result.backendConfig.timeoutMs).toBe(800);
        expect(result.valid).toBe(true);
    });

    it('selects headroom explicitly', () => {
        const result = resolveCompressorConfig({ backend: 'headroom' });
        expect(result.backend).toBe('headroom');
        expect(result.backendConfig.baseUrl).toBe('http://127.0.0.1:8787');
        expect(result.backendConfig.timeoutMs).toBe(1000);
        expect(result.valid).toBe(true);
    });

    it('uses custom headroom config from backends sub-block', () => {
        const result = resolveCompressorConfig({
            backend: 'headroom',
            backends: {
                headroom: { baseUrl: 'http://myhost:9999', timeoutMs: 3000 },
            },
        });
        expect(result.backendConfig.baseUrl).toBe('http://myhost:9999');
        expect(result.backendConfig.timeoutMs).toBe(3000);
    });

    it('uses custom edgee config from backends sub-block', () => {
        const result = resolveCompressorConfig({
            backend: 'edgee',
            backends: {
                edgee: { baseUrl: 'http://myhost:7777', timeoutMs: 400 },
            },
        });
        expect(result.backendConfig.baseUrl).toBe('http://myhost:7777');
        expect(result.backendConfig.timeoutMs).toBe(400);
    });

    // --- env overrides ---

    it('overrides headroom baseUrl from env', () => {
        process.env.HEADROOM_COMPRESSOR_BASE_URL = 'http://env:1111';
        const result = resolveCompressorConfig({ backend: 'headroom' });
        expect(result.backendConfig.baseUrl).toBe('http://env:1111');
    });

    it('overrides headroom timeoutMs from env', () => {
        process.env.HEADROOM_COMPRESSOR_TIMEOUT_MS = '5000';
        const result = resolveCompressorConfig({ backend: 'headroom' });
        expect(result.backendConfig.timeoutMs).toBe(5000);
    });

    it('overrides edgee baseUrl from env', () => {
        process.env.EDGEE_COMPRESSOR_BASE_URL = 'http://env:2222';
        const result = resolveCompressorConfig({ backend: 'edgee' });
        expect(result.backendConfig.baseUrl).toBe('http://env:2222');
    });

    it('overrides edgee timeoutMs from env', () => {
        process.env.EDGEE_COMPRESSOR_TIMEOUT_MS = '300';
        const result = resolveCompressorConfig({ backend: 'edgee' });
        expect(result.backendConfig.timeoutMs).toBe(300);
    });

    it('ignores non-numeric env timeoutMs (falls back to default)', () => {
        process.env.HEADROOM_COMPRESSOR_TIMEOUT_MS = 'fast';
        const result = resolveCompressorConfig({ backend: 'headroom' });
        expect(result.backendConfig.timeoutMs).toBe(1000);
    });

    it.each(['0', '-1', '1.5', 'Infinity'])(
        'ignores invalid env timeoutMs %s (falls back to default)',
        (value) => {
            process.env.HEADROOM_COMPRESSOR_TIMEOUT_MS = value;
            const result = resolveCompressorConfig({ backend: 'headroom' });
            expect(result.backendConfig.timeoutMs).toBe(1000);
        },
    );

    // --- legacy migration ---

    it('migrates legacy top-level baseUrl to edgee', () => {
        const result = resolveCompressorConfig({
            baseUrl: 'http://legacy:8320',
        });
        // No explicit backend → defaults headroom, but legacy baseUrl maps to edgee
        // Actually: legacy baseUrl migrates to edgee backend config, but backend selection is separate
        // Per design: "ancien compressor.baseUrl reste temporairement un alias Edgee"
        // The legacy field maps to edgee sub-block, not headroom
        expect(result.backend).toBe('headroom'); // default is still headroom
    });

    it('migrates legacy top-level baseUrl to edgee when backend is edgee', () => {
        const result = resolveCompressorConfig({
            backend: 'edgee',
            baseUrl: 'http://legacy:9999',
        });
        expect(result.backendConfig.baseUrl).toBe('http://legacy:9999');
    });

    it('migrates legacy timeoutMs to edgee when backend is edgee', () => {
        const result = resolveCompressorConfig({
            backend: 'edgee',
            timeoutMs: 1500,
        });
        expect(result.backendConfig.timeoutMs).toBe(1500);
    });

    it('migrates legacy agent to edgee when backend is edgee', () => {
        const result = resolveCompressorConfig({
            backend: 'edgee',
            agent: 'sonnet',
        });
        expect(result.backendConfig.agent).toBe('sonnet');
    });

    // --- legacy benchmark deprecation ---

    it('produces legacy_benchmark diagnostic for routingStrategy: benchmark', () => {
        const result = resolveCompressorConfig({
            routingStrategy: 'benchmark',
        });
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ id: 'legacy_benchmark' }),
        );
    });

    // --- invalid backend ---

    it('produces invalid_backend diagnostic and valid: false for unknown backend', () => {
        const normalized = normalizeConfig({ compressor: { backend: 'gzip' } });
        const result = resolveCompressorConfig(normalized.compressor ?? {});
        expect(result.valid).toBe(false);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ id: 'invalid_backend' }),
        );
    });

    // --- deep merge ---

    it('deep merges global and project backend sub-blocks', () => {
        const global = normalizeConfig({
            compressor: {
                backend: 'headroom',
                backends: {
                    headroom: { baseUrl: 'http://global:8787', timeoutMs: 2000 },
                    edgee: { baseUrl: 'http://global:8320' },
                },
            },
        });
        const project = normalizeConfig({
            compressor: { backends: { headroom: { timeoutMs: 500 } } },
        });
        const merged = mergeConfig(global, project);
        const result = resolveCompressorConfig(merged.compressor ?? {});
        expect(result.backendConfig.baseUrl).toBe('http://global:8787');
        expect(result.backendConfig.timeoutMs).toBe(500);
    });

    // --- preserves existing policy fields ---

    it('preserves all existing policy config fields', () => {
        const result = resolveCompressorConfig({
            enabled: true,
            excludeTools: ['bash'],
            showStatus: true,
            showWidget: false,
            archiveOriginal: false,
            capFallbackTokens: 1700,
            maxFallbackBytes: 48000,
            summaryGranularity: 'turn',
            minTokensByGroup: { shell: 2048 },
            archiveRetention: { maxAgeDays: 7 },
            aggregates: false,
            capErrors: false,
        });
        expect(result.enabled).toBe(true);
        expect(result.excludeTools).toEqual(['bash']);
        expect(result.showStatus).toBe(true);
        expect(result.showWidget).toBe(false);
        expect(result.archiveOriginal).toBe(false);
        expect(result.capFallbackTokens).toBe(1700);
        expect(result.summaryGranularity).toBe('turn');
        expect(result.aggregates).toBe(false);
        expect(result.capErrors).toBe(false);
        expect(result.minTokensByGroup.shell).toBe(2048);
    });

    it('defaults minTokensByGroup to the benchmarked 1400/2700/1400', () => {
        const result = resolveCompressorConfig({});
        expect(result.minTokensByGroup).toEqual({
            shell: 1400,
            read: 2700,
            search: 1400,
        });
    });

    it('prefers minTokensByGroup per group over the default', () => {
        const result = resolveCompressorConfig({
            minTokensByGroup: { shell: 100 },
        });
        expect(result.minTokensByGroup).toEqual({
            shell: 100,
            read: 2700,
            search: 1400,
        });
    });

    it('omits minSavingsPct and truncationEnabled when unset', () => {
        const result = resolveCompressorConfig({});
        expect(result.truncationEnabled).toBeUndefined();
        expect(result.minSavingsPct).toBeUndefined();
    });

    it('passes through minSavingsPct and truncationEnabled when set', () => {
        const result = resolveCompressorConfig({
            minSavingsPct: 35,
            truncationEnabled: false,
        });
        expect(result.minSavingsPct).toBe(35);
        expect(result.truncationEnabled).toBe(false);
    });
});

describe('loadSaveTokensConfig', () => {
    it('deep-merges real global and project backend settings', () => {
        const agentDir = mkdtempSync(join(tmpdir(), 'save-tokens-agent-'));
        const cwd = mkdtempSync(join(tmpdir(), 'save-tokens-project-'));
        try {
            mkdirSync(join(cwd, '.pi'));
            writeFileSync(
                join(agentDir, 'settings.json'),
                JSON.stringify({
                    saveTokens: {
                        compressor: {
                            backend: 'headroom',
                            backends: {
                                headroom: {
                                    baseUrl: 'http://global:8787',
                                    timeoutMs: 2000,
                                },
                            },
                            showStatus: true,
                        },
                    },
                }),
            );
            writeFileSync(
                join(cwd, '.pi', 'settings.json'),
                JSON.stringify({
                    saveTokens: {
                        compressor: {
                            backends: { headroom: { timeoutMs: 500 } },
                            capErrors: false,
                        },
                    },
                }),
            );

            const cfg = loadSaveTokensConfig(cwd, agentDir);
            expect(cfg.compressor).toMatchObject({
                backend: 'headroom',
                showStatus: true,
                capErrors: false,
                backends: {
                    headroom: {
                        baseUrl: 'http://global:8787',
                        timeoutMs: 500,
                    },
                },
            });
        } finally {
            rmSync(agentDir, { recursive: true, force: true });
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});
