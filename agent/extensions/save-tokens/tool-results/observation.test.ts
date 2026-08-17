import { describe, expect, expectTypeOf, it } from 'bun:test';
import type { ToolResultEvent } from '@earendil-works/pi-coding-agent';
import { createToolResultHandler } from './core';
import type {
    CompressionBackend,
    CompressorModel,
    CompressionObservation,
    CompressionBackendResult,
} from './types';

// ---------------------------------------------------------------------------
// Task 10 — per-call protocol/telemetry observations from the policy layer.
// Every canonical observation must carry exact kind union, plus optional
// backend, backend version, latency, reason, sizes, native metrics and
// tokenizer (when factual).
// ---------------------------------------------------------------------------

const HEADROOM_PIN = '322425c43bffde1ed0b64fecf3cf5951565dd82b';

const TEST_MODEL: CompressorModel = {
    provider: 'anthropic',
    id: 'claude-sonnet-4-20250514',
    contextWindow: 200000,
};

function toolResultEvent(overrides: {
    toolName: string;
    toolCallId: string;
    text?: string;
    input?: object;
    isError?: boolean;
}): ToolResultEvent {
    return {
        toolName: overrides.toolName,
        toolCallId: overrides.toolCallId,
        input: overrides.input ?? { path: 'src/main.ts' },
        content: [
            {
                type: 'text',
                text: overrides.text ?? 'a very long original tool output',
            },
        ],
        isError: overrides.isError ?? false,
        details: undefined,
    } as ToolResultEvent;
}

function handlerFor(
    backend: CompressionBackend,
    observations: CompressionObservation[],
    options?: { backendVersion?: string },
) {
    return createToolResultHandler({
        backend,
        backendVersion: options?.backendVersion,
        minBytesByGroup: { shell: 0, read: 0, search: 0 },
        enabled: true,
        excludeTools: [],
        aggregates: false,
        capErrors: false,
        onObservation: (event) => observations.push(event),
    });
}

function headroomBackend(
    respond: CompressionBackendResult | (() => Promise<CompressionBackendResult>),
): CompressionBackend {
    return {
        id: 'headroom',
        compress: async () =>
            typeof respond === 'function'
                ? respond()
                : respond,
    };
}

function edgeeBackend(
    respond: CompressionBackendResult,
): CompressionBackend {
    return {
        id: 'edgee',
        compress: async () => respond,
    };
}

describe('Task 10 observation protocol', () => {
    it('kind union is exactly compressed | skipped | failed', () => {
        expectTypeOf<CompressionObservation['kind']>().toEqualTypeOf<
            'compressed' | 'skipped' | 'failed'
        >();
    });

    it('compressed observation carries backend, version, latency and native metrics', async () => {
        const observations: CompressionObservation[] = [];
        const handler = handlerFor(
            headroomBackend({
                output: 'shorter',
                metrics: {
                    tokensBefore: 100,
                    tokensAfter: 40,
                    compressionRatio: 0.6,
                    transforms: ['dedup'],
                },
            }),
            observations,
            { backendVersion: HEADROOM_PIN },
        );

        const result = await handler(
            toolResultEvent({ toolName: 'read', toolCallId: 'c1' }),
            TEST_MODEL,
        );

        expect(result).toBeDefined();
        expect(observations).toHaveLength(1);
        const obs = observations[0];
        expect(obs.kind).toBe('compressed');
        expect(obs.backend).toBe('headroom');
        expect(obs.backendVersion).toBe(HEADROOM_PIN);
        expect(obs.latencyMs).toBeGreaterThanOrEqual(0);
        expect(obs.nativeMetrics).toEqual({
            tokensBefore: 100,
            tokensAfter: 40,
            compressionRatio: 0.6,
            transforms: ['dedup'],
        });
        expect(obs.tokenizer).toBeUndefined();
    });

    it('failed observation carries the exact backend reason and latency, and fails open', async () => {
        const observations: CompressionObservation[] = [];
        const handler = handlerFor(
            headroomBackend({ output: null, reason: 'timeout' }),
            observations,
            { backendVersion: HEADROOM_PIN },
        );

        const result = await handler(
            toolResultEvent({ toolName: 'grep', toolCallId: 'f1' }),
            TEST_MODEL,
        );

        // Fail-open: the original tool result is returned untouched.
        expect(result).toBeUndefined();
        expect(observations).toHaveLength(1);
        const obs = observations[0];
        expect(obs.kind).toBe('failed');
        expect(obs.reason).toBe('timeout');
        expect(obs.backend).toBe('headroom');
        expect(obs.backendVersion).toBe(HEADROOM_PIN);
        expect(obs.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('skipped observation preserves the benign backend reason', async () => {
        const observations: CompressionObservation[] = [];
        const handler = handlerFor(
            edgeeBackend({ output: null, reason: 'unsupported_tool' }),
            observations,
            { backendVersion: '0.1.3' },
        );

        await handler(
            toolResultEvent({ toolName: 'ls', toolCallId: 's1' }),
            TEST_MODEL,
        );

        expect(observations).toHaveLength(1);
        const obs = observations[0];
        expect(obs.kind).toBe('skipped');
        expect(obs.reason).toBe('unsupported_tool');
        expect(obs.backend).toBe('edgee');
        expect(obs.backendVersion).toBe('0.1.3');
    });

    it('edgee observations carry version but no tokenizer fact', async () => {
        const observations: CompressionObservation[] = [];
        const handler = handlerFor(
            edgeeBackend({ output: 'trimmed' }),
            observations,
            { backendVersion: '0.1.3' },
        );

        await handler(
            toolResultEvent({ toolName: 'read', toolCallId: 'e1' }),
            TEST_MODEL,
        );

        expect(observations).toHaveLength(1);
        const obs = observations[0];
        expect(obs.kind).toBe('compressed');
        expect(obs.backend).toBe('edgee');
        expect(obs.backendVersion).toBe('0.1.3');
        expect(obs.tokenizer).toBeUndefined();
    });

    it('does not guess Headroom tokenizer when the response omits it', async () => {
        const observations: CompressionObservation[] = [];
        await handlerFor(headroomBackend({ output: 'shorter' }), observations)(
            toolResultEvent({ toolName: 'read', toolCallId: 'tok-unknown' }),
            { provider: 'custom', id: 'ocg/go-unknown-model', contextWindow: 128000 },
        );

        expect(observations[0]?.tokenizer).toBeUndefined();
    });

    it('emits a failed invalid_backend observation while preserving fail-open', async () => {
        const observations: CompressionObservation[] = [];
        const handler = createToolResultHandler({
            backend: null,
            backendFailureReason: 'invalid_backend',
            minBytesByGroup: { shell: 0, read: 0, search: 0 },
            onObservation: (event) => observations.push(event),
        });

        const result = await handler(
            toolResultEvent({ toolName: 'read', toolCallId: 'invalid-1' }),
            TEST_MODEL,
        );

        expect(result).toBeUndefined();
        expect(observations).toEqual([
            expect.objectContaining({
                kind: 'failed',
                reason: 'invalid_backend',
                toolCallId: 'invalid-1',
            }),
        ]);
    });

    it('does not report invalid_backend for output below the compression threshold', async () => {
        const observations: CompressionObservation[] = [];
        const handler = createToolResultHandler({
            backend: null,
            backendFailureReason: 'invalid_backend',
            minBytesByGroup: { shell: 1024, read: 1024, search: 1024 },
            onObservation: (event) => observations.push(event),
        });

        await handler(
            toolResultEvent({ toolName: 'read', toolCallId: 'invalid-small', text: 'small' }),
            TEST_MODEL,
        );

        expect(observations).toEqual([]);
    });

    it('measures latency around the selected backend call', async () => {
        const observations: CompressionObservation[] = [];
        const handler = handlerFor(
            headroomBackend(async () => {
                await new Promise((resolve) => setTimeout(resolve, 15));
                return { output: 'x' };
            }),
            observations,
        );

        await handler(
            toolResultEvent({
                toolName: 'read',
                toolCallId: 'lat1',
                text: 'a sufficiently long output for compression',
            }),
            TEST_MODEL,
        );

        expect(observations).toHaveLength(1);
        expect(observations[0]?.latencyMs).toBeGreaterThanOrEqual(15);
    });

    it('backend throw produces a failed observation and never escapes', async () => {
        const observations: CompressionObservation[] = [];
        const backend: CompressionBackend = {
            id: 'headroom',
            compress: async () => {
                throw new Error('offline');
            },
        };
        const handler = handlerFor(backend, observations, {
            backendVersion: HEADROOM_PIN,
        });

        const result = await handler(
            toolResultEvent({ toolName: 'bash', toolCallId: 't1' }),
            TEST_MODEL,
        );

        expect(result).toBeUndefined();
        expect(observations).toHaveLength(1);
        const obs = observations[0];
        expect(obs.kind).toBe('failed');
        expect(obs.reason).toBe('service_error');
        expect(obs.backend).toBe('headroom');
        expect(obs.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('policy cap/archive observations carry the selected backend but no call facts', async () => {
        const observations: CompressionObservation[] = [];
        let backendCalled = false;
        const handler = createToolResultHandler({
            backend: {
                id: 'headroom',
                compress: async () => {
                    backendCalled = true;
                    return { output: 'should not be used' };
                },
            },
            backendVersion: HEADROOM_PIN,
            minBytesByGroup: { shell: 0, read: 0, search: 0 },
            enabled: true,
            excludeTools: [],
            aggregates: false,
            capErrors: false,
            routingStrategy: 'benchmark',
            capFallbackTokens: 21,
            archiveOriginal: async () => '/tmp/archive/cap-only.txt',
            onObservation: (event) => observations.push(event),
        });

        const longText = Array.from({ length: 80 }, (_, i) => `line-${i}`).join(
            '\n',
        );
        const result = await handler(
            toolResultEvent({
                toolName: 'grep',
                toolCallId: 'cap1',
                text: longText,
            }),
            TEST_MODEL,
        );

        expect(result).toBeDefined();
        expect(backendCalled).toBe(false);
        expect(observations).toHaveLength(1);
        const obs = observations[0];
        if (!obs) throw new Error('expected one compression observation');
        expect(obs.kind).toBe('compressed');
        // Selected backend id/version are config facts — still reported.
        expect(obs.backend).toBe('headroom');
        expect(obs.backendVersion).toBe(HEADROOM_PIN);
        // Call-only facts are absent: the Headroom engine never ran.
        expect(obs.tokenizer).toBeUndefined();
        expect(obs.latencyMs).toBeUndefined();
        expect(obs.nativeMetrics).toBeUndefined();
    });

    it('failed observation preserves native metrics when the backend supplies them', async () => {
        const observations: CompressionObservation[] = [];
        const handler = handlerFor(
            headroomBackend({
                output: null,
                reason: 'timeout',
                metrics: {
                    tokensBefore: 200,
                    tokensAfter: 0,
                    compressionRatio: 0,
                },
            }),
            observations,
            { backendVersion: HEADROOM_PIN },
        );

        await handler(
            toolResultEvent({ toolName: 'grep', toolCallId: 'fm1' }),
            TEST_MODEL,
        );

        expect(observations).toHaveLength(1);
        const obs = observations[0];
        if (!obs) throw new Error('expected one failed observation');
        expect(obs.kind).toBe('failed');
        expect(obs.reason).toBe('timeout');
        expect(obs.nativeMetrics).toEqual({
            tokensBefore: 200,
            tokensAfter: 0,
            compressionRatio: 0,
        });
    });
});
