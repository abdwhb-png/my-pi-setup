import { describe, expect, test } from 'bun:test';
import type { CompressionBackendRequest, FetchLike } from './types';
import { HeadroomBackend } from './headroom';

const request: CompressionBackendRequest = {
    toolCallId: 'call_123',
    toolName: 'read',
    arguments: { path: 'src/auth.ts' },
    output: 'original tool output',
    model: { provider: 'openai', id: 'gpt-4o-mini-2024-07-18', contextWindow: 128000 },
};

function response(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function fetchWith(body: unknown, status = 200): { fetch: FetchLike; calls: Request[] } {
    const calls: Request[] = [];
    return {
        calls,
        fetch: async (input, init) => {
            calls.push(new Request(input, init));
            return response(body, status);
        },
    };
}

describe('HeadroomBackend', () => {
    test('sends the exact single-tool payload and normalizes native metrics', async () => {
        const fixture = fetchWith({
            messages: [{ role: 'tool', tool_call_id: 'call_123', content: 'short output' }],
            tokens_before: 40,
            tokens_after: 12,
            tokens_saved: 28,
            compression_ratio: 0.3,
            transforms_applied: ['json:compact'],
            ccr_hashes: ['abc123'],
        });
        const backend = new HeadroomBackend({ baseUrl: 'http://127.0.0.1:8787', fetchImpl: fixture.fetch });

        const result = await backend.compress(request);
        expect(fixture.calls).toHaveLength(1);
        expect(fixture.calls[0].url).toBe('http://127.0.0.1:8787/v1/compress');
        expect(fixture.calls[0].method).toBe('POST');
        expect(await fixture.calls[0].json()).toEqual({
            messages: [{ role: 'tool', tool_call_id: 'call_123', content: 'original tool output' }],
            model: 'gpt-4o-mini',
            config: { protect_recent: 0 },
        });
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
    });

    test('passes an unknown model ID through and treats unchanged output as a no-op', async () => {
        const fixture = fetchWith({
            messages: [{ role: 'tool', tool_call_id: 'call_123', content: request.output }],
            tokens_before: 4,
            tokens_after: 4,
            tokens_saved: 0,
            compression_ratio: 1,
            transforms_applied: [],
            ccr_hashes: [],
        });
        const backend = new HeadroomBackend({ fetchImpl: fixture.fetch });

        const result = await backend.compress({
            ...request,
            model: { ...request.model, id: 'ocg/go-unknown-model' },
        });
        expect((await fixture.calls[0].json()).model).toBe('ocg/go-unknown-model');
        expect(result).toEqual({
            output: null,
            reason: 'no_change',
            metrics: {
                tokensBefore: 4,
                tokensAfter: 4,
                tokensSaved: 0,
                compressionRatio: 1,
                transforms: [],
                ccrHashes: [],
            },
        });
    });

    test('fails safely when the response is longer than the original output', async () => {
        const fixture = fetchWith({
            messages: [{ role: 'tool', tool_call_id: 'call_123', content: `${request.output} plus more` }],
            tokens_before: 4,
            tokens_after: 5,
            tokens_saved: 0,
            compression_ratio: 1.25,
            transforms_applied: ['inspect'],
            ccr_hashes: ['longer'],
        });
        const backend = new HeadroomBackend({ fetchImpl: fixture.fetch });

        await expect(backend.compress(request)).resolves.toEqual({
            output: null,
            reason: 'not_shorter',
            metrics: {
                tokensBefore: 4,
                tokensAfter: 5,
                tokensSaved: 0,
                compressionRatio: 1.25,
                transforms: ['inspect'],
                ccrHashes: ['longer'],
            },
        });
    });

    test.each([
        ['non-2xx', async () => fetchWith({}, 503)],
        ['invalid JSON', async () => ({ fetch: (async () => new Response('{')) as FetchLike, calls: [] as Request[] })],
        ['empty messages', async () => fetchWith({ messages: [] })],
        ['multiple messages', async () => fetchWith({ messages: [
            { role: 'tool', tool_call_id: 'call_123', content: 'one' },
            { role: 'tool', tool_call_id: 'call_123', content: 'two' },
        ] })],
        ['wrong role', async () => fetchWith({ messages: [{ role: 'assistant', tool_call_id: 'call_123', content: 'x' }] })],
        ['wrong correlation', async () => fetchWith({ messages: [{ role: 'tool', tool_call_id: 'other', content: 'x' }] })],
        ['non-text content', async () => fetchWith({ messages: [{ role: 'tool', tool_call_id: 'call_123', content: [{ type: 'text', text: 'x' }] }] })],
        ['empty content', async () => fetchWith({ messages: [{ role: 'tool', tool_call_id: 'call_123', content: '' }] })],
    ])('fails safely for %s', async (_name, makeFetch) => {
        const fixture = await makeFetch();
        const result = await new HeadroomBackend({ fetchImpl: fixture.fetch }).compress(request);
        expect(result.output).toBeNull();
        expect(result.reason).toBeTruthy();
    });

    test('fails safely on abort/timeout', async () => {
        const fetchImpl: FetchLike = async (_input, init) => await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
        const backend = new HeadroomBackend({ fetchImpl, timeoutMs: 1 });
        const result = await backend.compress(request);
        expect(result.output).toBeNull();
        expect(result.reason).toBe('timeout');
    });

    test('fails safely on connection rejection', async () => {
        const fetchImpl: FetchLike = async () => {
            throw new Error('connection refused');
        };
        const backend = new HeadroomBackend({ fetchImpl });

        await expect(backend.compress(request)).resolves.toEqual({
            output: null,
            reason: 'service_error',
        });
    });

    test('fails safely when the response body cannot be read', async () => {
        const fetchImpl: FetchLike = async () => {
            const response = new Response('', { status: 200 });
            response.text = async () => {
                throw new Error('body read failed');
            };
            return response;
        };
        const backend = new HeadroomBackend({ fetchImpl });

        await expect(backend.compress(request)).resolves.toEqual({
            output: null,
            reason: 'service_error',
        });
    });

    test('does not fetch when the caller is already aborted', async () => {
        let calls = 0;
        const fetchImpl: FetchLike = async () => {
            calls += 1;
            return response({
                messages: [{ role: 'tool', tool_call_id: 'call_123', content: 'short output' }],
            });
        };
        const controller = new AbortController();
        controller.abort();
        const backend = new HeadroomBackend({ fetchImpl });

        await expect(backend.compress(request, controller.signal)).resolves.toEqual({
            output: null,
            reason: 'aborted',
        });
        expect(calls).toBe(0);
    });

    test('fails safely when the caller aborts', async () => {
        const fetchImpl: FetchLike = async (_input, init) => await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
        const controller = new AbortController();
        const backend = new HeadroomBackend({ fetchImpl, timeoutMs: 1_000 });
        const promise = backend.compress(request, controller.signal);
        controller.abort();
        const result = await promise;
        expect(result.output).toBeNull();
        expect(result.reason).toBe('aborted');
    });

    // Health probe: reachability only. Any HTTP response (even a 4xx from the
    // relay rejecting non-compress paths) proves the service is up.
    describe('ping', () => {
        test('reports up for any HTTP response, including a 4xx rejection path', async () => {
            const fixture = fetchWith({}, 404);
            const backend = new HeadroomBackend({ baseUrl: 'http://127.0.0.1:8787/', fetchImpl: fixture.fetch });

            await expect(backend.ping()).resolves.toBe(true);
            expect(fixture.calls).toHaveLength(1);
            expect(fixture.calls[0].url).toBe('http://127.0.0.1:8787/');
            expect(fixture.calls[0].method).toBe('GET');
        });

        test('reports up when a 2xx response arrives', async () => {
            const fixture = fetchWith({}, 200);
            const backend = new HeadroomBackend({ fetchImpl: fixture.fetch });

            await expect(backend.ping()).resolves.toBe(true);
        });

        test('reports down on connection rejection', async () => {
            const fetchImpl: FetchLike = async () => {
                throw new Error('connection refused');
            };
            const backend = new HeadroomBackend({ fetchImpl });

            await expect(backend.ping()).resolves.toBe(false);
        });

        test('reports down on timeout', async () => {
            const fetchImpl: FetchLike = async (_input, init) => await new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
            });
            const backend = new HeadroomBackend({ fetchImpl, timeoutMs: 1 });

            await expect(backend.ping()).resolves.toBe(false);
        });
    });
});