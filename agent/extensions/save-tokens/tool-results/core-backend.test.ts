import { describe, expect, it } from 'bun:test';
import type { ToolResultEvent } from '@earendil-works/pi-coding-agent';
import type {
    CompressionBackendRequest,
    CompressionBackendResult,
    CompressionObservation,
} from './types';
import {
    createToolResultHandler,
    classifyBackendReason,
    normalizeFailedReason,
} from './core';

// ---------------------------------------------------------------------------
// Backend reason classification — benign no-ops vs real failures
// ---------------------------------------------------------------------------

describe('classifyBackendReason', () => {
    it.each<[string | undefined, 'failed' | 'skipped']>([
        // Native Headroom adapter benign no-ops must not count as failures.
        ['no_change', 'skipped'],
        ['not_shorter', 'skipped'],
        // Established benign reasons from the other adapters.
        ['no_output', 'skipped'],
        ['unsupported_tool', 'skipped'],
        // Absent reason is a benign no-op.
        [undefined, 'skipped'],
        // Real failures stay failures.
        ['service_error', 'failed'],
        ['timeout', 'failed'],
        ['invalid_response', 'failed'],
        ['http_503', 'failed'],
    ])('classifies %s as %s', (reason, expected) => {
        expect(classifyBackendReason(reason)).toBe(expected);
    });
});

// ---------------------------------------------------------------------------
// normalizeFailedReason — safe mapping into CompressionFailedReason
// ---------------------------------------------------------------------------

describe('normalizeFailedReason', () => {
    const cases: Array<[
        string | undefined,
        ReturnType<typeof normalizeFailedReason>,
    ]> = [
        ['service_error', 'service_error'],
        ['timeout', 'timeout'],
        ['aborted', 'aborted'],
        ['http_error', 'http_error'],
        ['invalid_response', 'invalid_response'],
        ['invalid_json', 'invalid_json'],
        ['http_503', 'http_503'],
    ];

    it.each(cases)('preserves the exact supported reason %s', (reason, expected) => {
        expect(normalizeFailedReason(reason)).toBe(expected);
    });

    it('normalizes arbitrary or invalid reason strings to service_error', () => {
        expect(normalizeFailedReason('backend exploded')).toBe('service_error');
        expect(normalizeFailedReason('http_error_503')).toBe('service_error');
        expect(normalizeFailedReason(undefined)).toBe('service_error');
    });
});

// ---------------------------------------------------------------------------
// Tool result handler tests — model propagation, backend usage
// ---------------------------------------------------------------------------

describe('createToolResultHandler with backend', () => {
    it('should pass model info from ctx.model to backend.compress()', async () => {
        const capturedRequests: CompressionBackendRequest[] = [];

        const mockBackend = {
            id: 'headroom' as const,
            compress: async (req: CompressionBackendRequest) => {
                capturedRequests.push(req);
                return { output: 'compressed text' };
            },
        };

        const handler = createToolResultHandler({
            backend: mockBackend,
            minTokensByGroup: { shell: 0, read: 0, search: 0 },
            enabled: true,
            excludeTools: [],
            archiveOriginal: undefined,
            aggregates: false,
            capErrors: false,
        });

        const event: ToolResultEvent = {
            type: 'tool_result',
            toolCallId: 'tc_1',
            toolName: 'read',
            content: [{ type: 'text' as const, text: 'original output text' }],
            isError: false,
            input: { path: '/etc/hosts' },
            details: undefined,
        };

        // Simulate ctx.model passed at handler call time
        const mockModel = {
            provider: 'anthropic',
            id: 'claude-sonnet-4-6',
            contextWindow: 200000,
        };

        await handler(event, mockModel, undefined);

        // Verify model was passed to backend
        expect(capturedRequests.length).toBe(1);
        const req = capturedRequests[0];
        expect(req.model.provider).toBe('anthropic');
        expect(req.model.id).toBe('claude-sonnet-4-6');
        expect(req.model.contextWindow).toBe(200000);
    });

    it('should fail open to original when backend returns null', async () => {
        const mockBackend = {
            id: 'headroom' as const,
            compress: async () => ({ output: null, reason: 'service_error' }),
        };

        const handler = createToolResultHandler({
            backend: mockBackend,
            minTokensByGroup: { shell: 0, read: 0, search: 0 },
            enabled: true,
            excludeTools: [],
            archiveOriginal: undefined,
            aggregates: false,
            capErrors: false,
        });

        const event: ToolResultEvent = {
            type: 'tool_result',
            toolCallId: 'tc_2',
            toolName: 'grep',
            content: [{ type: 'text' as const, text: 'search results' }],
            isError: false,
            input: { pattern: 'test' },
            details: undefined,
        };

        const mockModel = { provider: 'anthropic', id: 'claude-sonnet-4-6', contextWindow: 200000 };

        const result = await handler(event, mockModel, undefined);

        // Should return undefined (no modification) on backend failure
        expect(result).toBeUndefined();
    });

    it('should skip compression when backend is null (invalid config)', async () => {
        // When backend is null, compression should be skipped entirely
        const handler = createToolResultHandler({
            backend: null,
            minTokensByGroup: { shell: 0, read: 0, search: 0 },
            enabled: true,
            excludeTools: [],
            archiveOriginal: undefined,
            aggregates: false,
            capErrors: false,
        });

        const event: ToolResultEvent = {
            type: 'tool_result',
            toolCallId: 'tc_3',
            toolName: 'read',
            content: [{ type: 'text' as const, text: 'output' }],
            isError: false,
            input: {},
            details: undefined,
        };

        const mockModel = { provider: 'anthropic', id: 'claude-sonnet-4-6', contextWindow: 200000 };

        const result = await handler(event, mockModel, undefined);

        // Should return undefined (no compression attempted)
        expect(result).toBeUndefined();
    });

    it('should handle backend errors gracefully without escaping', async () => {
        const mockBackend = {
            id: 'edgee' as const,
            compress: async () => {
                throw new Error('Network error');
            },
        };

        const handler = createToolResultHandler({
            backend: mockBackend,
            minTokensByGroup: { shell: 0, read: 0, search: 0 },
            enabled: true,
            excludeTools: [],
            archiveOriginal: undefined,
            aggregates: false,
            capErrors: false,
        });

        const event: ToolResultEvent = {
            type: 'tool_result',
            toolCallId: 'tc_4',
            toolName: 'bash',
            content: [{ type: 'text' as const, text: 'command output' }],
            isError: false,
            input: { command: 'ls' },
            details: undefined,
        };

        const mockModel = { provider: 'anthropic', id: 'claude-sonnet-4-6', contextWindow: 200000 };

        const result = await handler(event, mockModel, undefined);

        // Should return undefined without throwing
        expect(result).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Backend reason classification — failure vs benign no-op
// ---------------------------------------------------------------------------

const CLASSIFY_MODEL = {
    provider: 'anthropic',
    id: 'claude-sonnet-4-6',
    contextWindow: 200000,
};

function classifyEvent(toolCallId: string): ToolResultEvent {
    return {
        type: 'tool_result',
        toolCallId,
        toolName: 'grep',
        content: [{ type: 'text' as const, text: 'search results text' }],
        isError: false,
        input: { pattern: 'x', path: 'src' },
        details: undefined,
    };
}

function classifyHandler(
    result: CompressionBackendResult,
    observations: CompressionObservation[],
) {
    return createToolResultHandler({
        backend: {
            id: 'headroom' as const,
            compress: () => Promise.resolve(result),
        },
        minTokensByGroup: { shell: 0, read: 0, search: 0 },
        enabled: true,
        excludeTools: [],
        aggregates: false,
        capErrors: false,
        onObservation: (event) => observations.push(event),
    });
}

describe('backend reason classification', () => {
    const failureReasons = [
        'service_error',
        'http_error',
        'http_503',
        'invalid_response',
        'timeout',
        'aborted',
    ] as const;

    for (const reason of failureReasons) {
        it(`classifies "${reason}" as a failed observation with the exact reason`, async () => {
            const observations: CompressionObservation[] = [];
            const handler = classifyHandler({ output: null, reason }, observations);

            const result = await handler(
                classifyEvent(`fail-${reason}`),
                CLASSIFY_MODEL,
                undefined,
            );

            expect(result).toBeUndefined();
            expect(observations).toEqual([
                expect.objectContaining({
                    kind: 'failed',
                    toolCallId: `fail-${reason}`,
                    toolName: 'grep',
                    originalLength: 'search results text'.length,
                    compressedLength: 0,
                    // Exact supported backend reason is preserved.
                    reason,
                    subject: 'src',
                    backend: 'headroom',
                    latencyMs: expect.any(Number),
                }),
            ]);
        });
    }

    it('normalizes an arbitrary backend failure reason instead of preserving it', async () => {
        const observations: CompressionObservation[] = [];
        const handler = classifyHandler(
            { output: null, reason: 'backend exploded' },
            observations,
        );

        await handler(
            classifyEvent('arb-1'),
            CLASSIFY_MODEL,
            undefined,
        );

        expect(observations).toEqual([
            expect.objectContaining({
                kind: 'failed',
                toolCallId: 'arb-1',
                reason: 'service_error',
                backend: 'headroom',
                latencyMs: expect.any(Number),
            }),
        ]);
    });

    const benignReasons = ['unsupported_tool', 'no_output'] as const;

    for (const reason of benignReasons) {
        it(`classifies "${reason}" as a skipped observation preserving the exact reason`, async () => {
            const observations: CompressionObservation[] = [];
            const handler = classifyHandler({ output: null, reason }, observations);

            const result = await handler(
                classifyEvent(`skip-${reason}`),
                CLASSIFY_MODEL,
                undefined,
            );

            expect(result).toBeUndefined();
            expect(observations).toEqual([
                expect.objectContaining({
                    kind: 'skipped',
                    toolCallId: `skip-${reason}`,
                    toolName: 'grep',
                    originalLength: 'search results text'.length,
                    compressedLength: 0,
                    // Exact benign reason is preserved, not collapsed.
                    reason,
                    subject: 'src',
                    backend: 'headroom',
                    latencyMs: expect.any(Number),
                }),
            ]);
        });
    }

    it('classifies a null output with no reason as skipped', async () => {
        const observations: CompressionObservation[] = [];
        const handler = classifyHandler({ output: null }, observations);

        await handler(classifyEvent('skip-none'), CLASSIFY_MODEL, undefined);

        expect(observations).toEqual([
            expect.objectContaining({
                kind: 'skipped',
                toolCallId: 'skip-none',
                toolName: 'grep',
                originalLength: 'search results text'.length,
                compressedLength: 0,
                reason: 'no_change',
                subject: 'src',
                backend: 'headroom',
                latencyMs: expect.any(Number),
            }),
        ]);
    });

    it('keeps the backend failure canonical when archived cap fallback succeeds', async () => {
        const observations: CompressionObservation[] = [];
        const longText = Array.from({ length: 200 }, (_, i) => `line-${i}`).join(
            '\n',
        );
        const handler = createToolResultHandler({
            backend: {
                id: 'headroom' as const,
                compress: () =>
                    Promise.resolve({ output: null, reason: 'timeout' }),
            },
            minTokensByGroup: { shell: 0, read: 0, search: 0 },
            capFallbackTokens: 100,
            archiveOriginal: () => Promise.resolve('/tmp/archive/cap.txt'),
            aggregates: false,
            capErrors: false,
            onObservation: (event) => observations.push(event),
        });

        const result = await handler(
            {
                type: 'tool_result',
                toolCallId: 'cap-over-fail',
                toolName: 'grep',
                content: [{ type: 'text' as const, text: longText }],
                isError: false,
                input: { pattern: 'x', path: 'src' },
                details: undefined,
            },
            CLASSIFY_MODEL,
            undefined,
        );

        expect(result?.content[0]?.text).toContain(
            'run read /tmp/archive/cap.txt for full output',
        );
        expect(observations).toEqual([
            expect.objectContaining({
                kind: 'failed',
                toolCallId: 'cap-over-fail',
                reason: 'timeout',
                backend: 'headroom',
                latencyMs: expect.any(Number),
            }),
        ]);
    });

    it('reports final returned size after aggregate prefix and archive note', async () => {
        const observations: CompressionObservation[] = [];
        const text = Array.from(
            { length: 120 },
            (_, index) => `src/file-${index}.ts:${index + 1}: repeated match`,
        ).join('\n');
        const handler = createToolResultHandler({
            backend: {
                id: 'headroom' as const,
                compress: () => Promise.resolve({ output: 'trimmed result' }),
            },
            minTokensByGroup: { shell: 0, read: 0, search: 0 },
            archiveOriginal: () =>
                Promise.resolve('/tmp/archive/final-size.txt'),
            aggregates: true,
            capErrors: false,
            onObservation: (event) => observations.push(event),
        });

        const result = await handler(
            {
                type: 'tool_result',
                toolCallId: 'final-size',
                toolName: 'grep',
                content: [{ type: 'text' as const, text }],
                isError: false,
                input: { pattern: 'match', path: 'src' },
                details: undefined,
            },
            CLASSIFY_MODEL,
            undefined,
        );

        const outputText = result?.content[0]?.text;
        expect(outputText).toBeDefined();
        if (outputText === undefined) throw new Error('expected compressed output text');
        const compression = result?.details?.compression;
        expect(compression?.compressedLength).toBe(outputText.length);
        expect(compression?.savedBytes).toBe(text.length - outputText.length);
        expect(observations).toEqual([
            expect.objectContaining({
                kind: 'compressed',
                compressedLength: outputText.length,
            }),
        ]);
    });
});

// ---------------------------------------------------------------------------
// resolveModel() — Pi ExtensionContext.model type behavior
// ---------------------------------------------------------------------------

describe('resolveModel', () => {
    it('extracts provider, id, contextWindow from an active model', async () => {
        const { resolveModel } = await import(
            '../local-tool-result-compressor'
        );

        const ctx = {
            model: {
                provider: 'anthropic',
                id: 'claude-sonnet-4-6',
                contextWindow: 200000,
            },
        };

        const result = resolveModel(ctx as Parameters<typeof resolveModel>[0]);
        expect(result.provider).toBe('anthropic');
        expect(result.id).toBe('claude-sonnet-4-6');
        expect(result.contextWindow).toBe(200000);
    });

    it('returns UNKNOWN_MODEL when ctx.model is undefined', async () => {
        const { resolveModel } = await import(
            '../local-tool-result-compressor'
        );

        const ctx = { model: undefined };
        const result = resolveModel(ctx as Parameters<typeof resolveModel>[0]);
        expect(result.provider).toBe('unknown');
        expect(result.id).toBe('unknown');
        expect(result.contextWindow).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Hook-level model propagation — model resolved per tool_result, not stale
// ---------------------------------------------------------------------------

describe('model propagation per tool_result', () => {
    it('backend receives the current model at each call, not a stale capture', async () => {
        const capturedModels: Array<{ provider: string; id: string; contextWindow: number }> = [];

        const mockBackend = {
            id: 'headroom' as const,
            compress: async (req: CompressionBackendRequest) => {
                capturedModels.push({ ...req.model });
                return { output: 'compressed' };
            },
        };

        const handler = createToolResultHandler({
            backend: mockBackend,
            minTokensByGroup: { shell: 0, read: 0, search: 0 },
            enabled: true,
            excludeTools: [],
            aggregates: false,
            capErrors: false,
        });

        const event: ToolResultEvent = {
            type: 'tool_result',
            toolCallId: 'tc_model_1',
            toolName: 'read',
            content: [{ type: 'text' as const, text: 'file contents here' }],
            isError: false,
            input: { path: '/tmp/a.txt' },
            details: undefined,
        };

        const modelA = {
            provider: 'anthropic',
            id: 'claude-sonnet-4-6',
            contextWindow: 200000,
        };

        const modelB = {
            provider: 'google',
            id: 'gemini-2.5-pro',
            contextWindow: 1000000,
        };

        await handler(event, modelA, undefined);
        await handler(
            { ...event, toolCallId: 'tc_model_2' },
            modelB,
            undefined,
        );

        expect(capturedModels).toHaveLength(2);
        expect(capturedModels[0].provider).toBe('anthropic');
        expect(capturedModels[0].id).toBe('claude-sonnet-4-6');
        expect(capturedModels[1].provider).toBe('google');
        expect(capturedModels[1].id).toBe('gemini-2.5-pro');
        expect(capturedModels[1].contextWindow).toBe(1000000);
    });

    it('one selected backend handles the request with no alternate invoked', async () => {
        let headroomCalls = 0;
        let edgeeCalls = 0;

        const headroomBackend = {
            id: 'headroom' as const,
            compress: async (req: CompressionBackendRequest) => {
                headroomCalls++;
                return { output: `compressed by headroom: ${req.toolName}` };
            },
        };

        const handler = createToolResultHandler({
            backend: headroomBackend,
            minTokensByGroup: { shell: 0, read: 0, search: 0 },
            enabled: true,
            excludeTools: [],
            aggregates: false,
            capErrors: false,
        });

        const event: ToolResultEvent = {
            type: 'tool_result',
            toolCallId: 'tc_single',
            toolName: 'grep',
            content: [{ type: 'text' as const, text: 'match results text here' }],
            isError: false,
            input: { pattern: 'foo', path: 'src' },
            details: undefined,
        };

        await handler(event, CLASSIFY_MODEL, undefined);

        expect(headroomCalls).toBe(1);
        expect(edgeeCalls).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// minTokensByGroup — token-based input threshold across scripts
// ---------------------------------------------------------------------------

describe('minTokensByGroup token threshold', () => {
    function recordingHandler(minTokensByGroup: {
        shell: number;
        read: number;
        search: number;
    }) {
        let calls = 0;
        const backend = {
            id: 'headroom' as const,
            compress: async () => {
                calls += 1;
                return { output: 'short' };
            },
        };
        const handler = createToolResultHandler({
            backend,
            minTokensByGroup,
            aggregates: false,
            capErrors: false,
        });
        return { handler, callCount: () => calls };
    }

    const event = (toolName: string, text: string): ToolResultEvent => ({
        type: 'tool_result',
        toolCallId: `t-${toolName}`,
        toolName,
        content: [{ type: 'text' as const, text }],
        isError: false,
        input: {},
        details: undefined,
    });

    const MODEL = {
        provider: 'anthropic',
        id: 'claude-sonnet-4-6',
        contextWindow: 200000,
    };

    it('gates ASCII output by estimated tokens', async () => {
        const { handler, callCount } = recordingHandler({
            shell: 4,
            read: 4,
            search: 4,
        });
        // "hello world" = 11 ordinary code points → ceil(11/3) = 4 → eligible
        await handler(event('bash', 'hello world'), MODEL);
        // "abc" = 3 code points → 1 token → below threshold
        await handler(event('bash', 'abc'), MODEL);
        expect(callCount()).toBe(1);
    });

    it('gates dense CJK by the same token budget, not byte length', async () => {
        const { handler, callCount } = recordingHandler({
            shell: 4,
            read: 4,
            search: 4,
        });
        // 4 CJK code points → ceil(4 / 0.8) = 5 → eligible (5 ≥ 4)
        await handler(event('bash', '你好世界'), MODEL);
        // 2 CJK code points → ceil(2 / 0.8) = 3 → below threshold (3 < 4)
        await handler(event('bash', '你好'), MODEL);
        expect(callCount()).toBe(1);
    });

    it('gates astral emoji without splitting surrogate pairs', async () => {
        const { handler, callCount } = recordingHandler({
            shell: 3,
            read: 3,
            search: 3,
        });
        // 2 emoji → 4 tokens → eligible (4 ≥ 3)
        await handler(event('bash', '😀😀'), MODEL);
        // 1 emoji → 2 tokens → below threshold (2 < 3)
        await handler(event('bash', '😀'), MODEL);
        expect(callCount()).toBe(1);
    });

    it('gates latin accented text as ordinary code points', async () => {
        const { handler, callCount } = recordingHandler({
            shell: 2,
            read: 2,
            search: 2,
        });
        // "café" = 4 ordinary code points → ceil(4/3) = 2 → eligible
        await handler(event('bash', 'café'), MODEL);
        // "caf" = 3 code points → 1 token → below threshold
        await handler(event('bash', 'caf'), MODEL);
        expect(callCount()).toBe(1);
    });

    it('uses the group threshold for the tool, not a global value', async () => {
        const { handler, callCount } = recordingHandler({
            shell: 2,
            read: 3,
            search: 3,
        });
        // "aaaaaa" = 6 chars → 2 tokens: eligible for shell (2 ≥ 2), below read (2 < 3)
        await handler(event('bash', 'aaaaaa'), MODEL);
        await handler(event('read', 'aaaaaa'), MODEL);
        expect(callCount()).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// cap overhead — fail open when the fixed overhead alone exceeds the budget
// ---------------------------------------------------------------------------

describe('cap overhead fail-open', () => {
    const MODEL = {
        provider: 'anthropic',
        id: 'claude-sonnet-4-6',
        contextWindow: 200000,
    };

    it('fails open instead of emitting a cap whose fixed overhead exceeds the budget', async () => {
        const handler = createToolResultHandler({
            backend: null,
            archiveOriginal: async () => '/tmp/archive/tiny.txt',
            capFallbackTokens: 10,
            aggregates: false,
            capErrors: false,
        });

        const text = Array.from({ length: 200 }, (_, i) => `line-${i}`).join(
            '\n',
        );
        const event: ToolResultEvent = {
            type: 'tool_result',
            toolCallId: 'tiny-cap',
            toolName: 'find',
            content: [{ type: 'text' as const, text }],
            isError: false,
            input: { path: '/repo' },
            details: undefined,
        };

        const result = await handler(event, MODEL, undefined);
        // The escape-hatch note + omission marker alone exceed 10 tokens, so
        // the cap cannot satisfy its budget — the original is preserved.
        expect(result).toBeUndefined();
    });

    it('still caps when the overhead fits the budget', async () => {
        const handler = createToolResultHandler({
            backend: null,
            archiveOriginal: async () => '/tmp/archive/ok.txt',
            capFallbackTokens: 200,
            aggregates: false,
            capErrors: false,
        });

        const text = Array.from({ length: 400 }, (_, i) => `line-${i}`).join(
            '\n',
        );
        const event: ToolResultEvent = {
            type: 'tool_result',
            toolCallId: 'ok-cap',
            toolName: 'find',
            content: [{ type: 'text' as const, text }],
            isError: false,
            input: { path: '/repo' },
            details: undefined,
        };

        const result = await handler(event, MODEL, undefined);
        expect(result).toBeDefined();
        expect(result?.content[0]?.text).toContain('omitted by head/tail cap');
    });
});

// ---------------------------------------------------------------------------
// minSavingsPct — post-compression savings floor
// ---------------------------------------------------------------------------

describe('minSavingsPct savings floor', () => {
    const MODEL = {
        provider: 'anthropic',
        id: 'claude-sonnet-4-6',
        contextWindow: 200000,
    };

    function floorHandler(
        output: string,
        minSavingsPct: number | undefined,
        observations: CompressionObservation[],
    ) {
        return createToolResultHandler({
            backend: {
                id: 'headroom' as const,
                compress: () => Promise.resolve({ output }),
            },
            minTokensByGroup: { shell: 0, read: 0, search: 0 },
            minSavingsPct,
            enabled: true,
            excludeTools: [],
            aggregates: false,
            capErrors: false,
            archiveOriginal: undefined,
            onObservation: (event) => observations.push(event),
        });
    }

    const event = (text: string): ToolResultEvent => ({
        type: 'tool_result',
        toolCallId: 'floor-1',
        toolName: 'bash',
        content: [{ type: 'text' as const, text }],
        isError: false,
        input: {},
        details: undefined,
    });

    it('accepts a compressed result when no floor is configured', async () => {
        const observations: CompressionObservation[] = [];
        const handler = floorHandler('shorter', undefined, observations);
        // 12 -> 7 chars: 41% smaller; no floor -> compressed/kept.
        const result = await handler(event('longlonglong'), MODEL, undefined);
        expect(observations[0].kind).toBe('compressed');
        expect(result?.content[0]?.text).toBe('shorter');
    });

    it('accepts a compressed result when the floor is 0', async () => {
        const observations: CompressionObservation[] = [];
        const handler = floorHandler('shorter', 0, observations);
        const result = await handler(event('longlonglong'), MODEL, undefined);
        expect(observations[0].kind).toBe('compressed');
        expect(result?.content[0]?.text).toBe('shorter');
    });

    it('accepts when savings meets the floor exactly', async () => {
        const observations: CompressionObservation[] = [];
        const handler = floorHandler('ab', 50, observations);
        // 'abcd' -> 'ab': 50% saved -> meets floor 50 -> kept.
        const result = await handler(event('abcd'), MODEL, undefined);
        expect(observations[0].kind).toBe('compressed');
        expect(result?.content[0]?.text).toBe('ab');
    });

    it('skips the compressed result when savings falls below the floor', async () => {
        const observations: CompressionObservation[] = [];
        const handler = floorHandler('abcd', 30, observations);
        // 'abcdef' -> 'abcd': 33% saved -> below 30? No, 33>=30. Use a
        // smaller reduction instead: 'abcde' -> 'abcd' = 20%.
        const result = await handler(event('abcde'), MODEL, undefined);
        expect(result).toBeUndefined();
        expect(observations[0]).toEqual(
            expect.objectContaining({
                kind: 'skipped',
                toolCallId: 'floor-1',
                toolName: 'bash',
                originalLength: 5,
                compressedLength: 0,
                reason: 'below_min_savings',
                subject: undefined,
                backend: 'headroom',
                latencyMs: expect.any(Number),
            }),
        );
    });

    it('keeps the original result intact when below the floor', async () => {
        const observations: CompressionObservation[] = [];
        const handler = floorHandler('abcd', 50, observations);
        // 'abcde' -> 'abcd': 20% saved < 50 -> original returned unchanged.
        const result = await handler(event('abcde'), MODEL, undefined);
        expect(result).toBeUndefined();
        expect(observations[0].kind).toBe('skipped');
        expect(observations[0].reason).toBe('below_min_savings');
    });
});

// ---------------------------------------------------------------------------
// truncationEnabled — deterministic cap toggle, decoupled from archiveOriginal
// ---------------------------------------------------------------------------

describe('truncationEnabled cap toggle', () => {
    const MODEL = {
        provider: 'anthropic',
        id: 'claude-sonnet-4-6',
        contextWindow: 200000,
    };

    const longText = Array.from({ length: 400 }, (_, i) => `line-${i}`).join(
        '\n',
    );

    it('caps (with archive) by default when a budget is set', async () => {
        let archived = false;
        const handler = createToolResultHandler({
            backend: null,
            archiveOriginal: async () => {
                archived = true;
                return '/tmp/archive/decouple-a.txt';
            },
            capFallbackTokens: 200,
            aggregates: false,
            capErrors: false,
        });
        const event: ToolResultEvent = {
            type: 'tool_result',
            toolCallId: 'cap-default',
            toolName: 'find',
            content: [{ type: 'text' as const, text: longText }],
            isError: false,
            input: { path: '/repo' },
            details: undefined,
        };
        const result = await handler(event, MODEL, undefined);
        expect(result).toBeDefined();
        expect(result?.content[0]?.text).toContain('omitted by head/tail cap');
        expect(archived).toBe(true);
    });

    it('caps without archiving when truncationEnabled is explicit and archive is off', async () => {
        const handler = createToolResultHandler({
            backend: null,
            // archiveOriginal undefined = no archive callback from the caller.
            archiveOriginal: undefined,
            capFallbackTokens: 200,
            aggregates: false,
            capErrors: false,
            truncationEnabled: true,
        });
        const event: ToolResultEvent = {
            type: 'tool_result',
            toolCallId: 'trun-noarch',
            toolName: 'find',
            content: [{ type: 'text' as const, text: longText }],
            isError: false,
            input: { path: '/repo' },
            details: undefined,
        };
        const result = await handler(event, MODEL, undefined);
        expect(result).toBeDefined();
        expect(result?.content[0]?.text).toContain('omitted by head/tail cap');
        expect(result?.content[0]?.text).not.toContain('run read /tmp/archive');
    });

    it('keeps current behavior when no archive callback and no explicit truncation flag', async () => {
        // Today missing archiveOriginal means the cap never runs. That must
        // stay true when truncationEnabled is absent (undefined).
        const handler = createToolResultHandler({
            backend: null,
            archiveOriginal: undefined,
            capFallbackTokens: 200,
            aggregates: false,
            capErrors: false,
        });
        const event: ToolResultEvent = {
            type: 'tool_result',
            toolCallId: 'cap-noarch-undef',
            toolName: 'find',
            content: [{ type: 'text' as const, text: longText }],
            isError: false,
            input: { path: '/repo' },
            details: undefined,
        };
        const result = await handler(event, MODEL, undefined);
        expect(result).toBeUndefined();
    });

    it('skips the cap entirely when truncationEnabled is false', async () => {
        let archived = false;
        const handler = createToolResultHandler({
            backend: null,
            archiveOriginal: async () => {
                archived = true;
                return '/tmp/archive/trunc-off.txt';
            },
            capFallbackTokens: 200,
            aggregates: false,
            capErrors: false,
            truncationEnabled: false,
        });
        const event: ToolResultEvent = {
            type: 'tool_result',
            toolCallId: 'cap-disabled',
            toolName: 'find',
            content: [{ type: 'text' as const, text: longText }],
            isError: false,
            input: { path: '/repo' },
            details: undefined,
        };
        const result = await handler(event, MODEL, undefined);
        expect(result).toBeUndefined();
        expect(archived).toBe(false);
    });
});
