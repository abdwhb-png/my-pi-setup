import { describe, expect, it } from 'bun:test';
import type { ResolvedCompressorConfig } from '../config-runtime';

// ---------------------------------------------------------------------------
// Registry tests — backend selection, identity, fail-open, no inter-engine fallback
// ---------------------------------------------------------------------------

describe('CompressionBackendRegistry', () => {
    it('should be created from ResolvedCompressorConfig', async () => {
        // Import after the impl exists
        const { CompressionBackendRegistry } = await import('./registry');
        const config: ResolvedCompressorConfig = {
            backend: 'headroom',
            backendConfig: {
                baseUrl: 'http://127.0.0.1:8787',
                timeoutMs: 1000,
            },
            valid: true,
            diagnostics: [],
            showStatus: false,
            showWidget: true,
            archiveOriginal: true,
            summaryGranularity: 'all',
            enabled: true,
            excludeTools: [],
            minBytesByGroup: { shell: 0, read: 0, search: 0 },
            archiveRetention: { maxAgeDays: 30, maxBytes: 1_000_000 },
            aggregates: false,
            capErrors: false,
        };

        const registry = new CompressionBackendRegistry(config);
        expect(registry).toBeDefined();
    });

    it('selected headroom backend has the matching id', async () => {
        const { CompressionBackendRegistry } = await import('./registry');
        const config: ResolvedCompressorConfig = {
            backend: 'headroom',
            backendConfig: {
                baseUrl: 'http://127.0.0.1:8787',
                timeoutMs: 1000,
            },
            valid: true,
            diagnostics: [],
            showStatus: false,
            showWidget: true,
            archiveOriginal: true,
            summaryGranularity: 'all',
            enabled: true,
            excludeTools: [],
            minBytesByGroup: { shell: 0, read: 0, search: 0 },
            archiveRetention: { maxAgeDays: 30, maxBytes: 1_000_000 },
            aggregates: false,
            capErrors: false,
        };

        const registry = new CompressionBackendRegistry(config);
        const backend = registry.getBackend();
        expect(backend).not.toBeNull();
        if (!backend) throw new Error('unreachable');
        expect(backend.id).toBe('headroom');
        expect(typeof backend.compress).toBe('function');
    });

    it('selected edgee backend has the matching id and no headroom fallback', async () => {
        const { CompressionBackendRegistry } = await import('./registry');
        const config: ResolvedCompressorConfig = {
            backend: 'edgee',
            backendConfig: {
                baseUrl: 'http://127.0.0.1:8320',
                timeoutMs: 800,
            },
            valid: true,
            diagnostics: [],
            showStatus: false,
            showWidget: true,
            archiveOriginal: true,
            summaryGranularity: 'all',
            enabled: true,
            excludeTools: [],
            minBytesByGroup: { shell: 0, read: 0, search: 0 },
            archiveRetention: { maxAgeDays: 30, maxBytes: 1_000_000 },
            aggregates: false,
            capErrors: false,
        };

        const registry = new CompressionBackendRegistry(config);
        const backend = registry.getBackend();
        expect(backend).not.toBeNull();
        if (!backend) throw new Error('unreachable');
        expect(backend.id).toBe('edgee');
        expect(backend.id).not.toBe('headroom');
    });

    it('invalid config preserves diagnostics and yields null backend', async () => {
        const { CompressionBackendRegistry } = await import('./registry');
        const diagnostics = [
            { id: 'invalid_backend' as const, message: 'Unknown compression backend "gzip"' },
        ];
        const config: ResolvedCompressorConfig = {
            backend: 'headroom',
            backendConfig: {
                baseUrl: 'http://127.0.0.1:8787',
                timeoutMs: 1000,
            },
            valid: false,
            diagnostics,
            showStatus: false,
            showWidget: true,
            archiveOriginal: true,
            summaryGranularity: 'all',
            enabled: true,
            excludeTools: [],
            minBytesByGroup: { shell: 0, read: 0, search: 0 },
            archiveRetention: { maxAgeDays: 30, maxBytes: 1_000_000 },
            aggregates: false,
            capErrors: false,
        };

        const registry = new CompressionBackendRegistry(config);
        expect(registry.getBackend()).toBeNull();
        expect(registry.getConfig().diagnostics).toEqual(diagnostics);
        expect(registry.getConfig().valid).toBe(false);
    });

    it('selects the native Headroom adapter and correlates native responses through the public API', async () => {
        const { CompressionBackendRegistry } = await import('./registry');
        const config: ResolvedCompressorConfig = {
            backend: 'headroom',
            backendConfig: {
                baseUrl: 'http://127.0.0.1:8787',
                timeoutMs: 1000,
            },
            valid: true,
            diagnostics: [],
            showStatus: false,
            showWidget: true,
            archiveOriginal: true,
            summaryGranularity: 'all',
            enabled: true,
            excludeTools: [],
            minBytesByGroup: { shell: 0, read: 0, search: 0 },
            archiveRetention: { maxAgeDays: 30, maxBytes: 1_000_000 },
            aggregates: false,
            capErrors: false,
        };

        // Capture the raw request the selected backend issues. Both the native
        // adapter (via defaultFetch) and the legacy duplicate route through
        // globalThis.fetch, so stubbing it is the smallest shared seam.
        const calls: Array<{ url: string; body: unknown }> = [];
        const originalFetch = globalThis.fetch;
        globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({
                url: String(input),
                body: await new Request(input, init).json(),
            });
            return new Response(
                JSON.stringify({
                    messages: [
                        { role: 'tool', tool_call_id: 'call_1', content: 'short output' },
                    ],
                    tokens_before: 40,
                    tokens_after: 12,
                    tokens_saved: 28,
                    compression_ratio: 0.3,
                    transforms_applied: ['json:compact'],
                    ccr_hashes: ['abc123'],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            );
        }, { preconnect: originalFetch.preconnect });
        try {
            const registry = new CompressionBackendRegistry(config);
            const backend = registry.getBackend();
            expect(backend).not.toBeNull();
            if (!backend) throw new Error('unreachable');

            const result = await backend.compress({
                toolCallId: 'call_1',
                toolName: 'read',
                arguments: { path: 'src/auth.ts' },
                output: 'original tool output',
                model: {
                    provider: 'openai',
                    id: 'gpt-4o-mini-2024-07-18',
                    contextWindow: 128000,
                },
            });

            // Native transport contract: single OpenAI tool message, mapped
            // model, protect_recent disabled for isolated tool results.
            expect(calls).toHaveLength(1);
            expect(calls[0].url).toBe('http://127.0.0.1:8787/v1/compress');
            expect(calls[0].body).toEqual({
                messages: [
                    {
                        role: 'tool',
                        tool_call_id: 'call_1',
                        content: 'original tool output',
                    },
                ],
                model: 'gpt-4o-mini',
                config: { protect_recent: 0 },
            });

            // Native response normalization: correlated tool message output
            // plus native metrics — no compressed_output dependency.
            expect(result).toEqual({
                output: 'short output',
                metrics: {
                    tokensBefore: 40,
                    tokensAfter: 12,
                    tokensSaved: 28,
                    compressionRatio: 0.3,
                    transforms: ['json:compact'],
                    ccrHashes: ['abc123'],
                },
            });
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
