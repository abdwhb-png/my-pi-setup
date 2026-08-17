import { describe, expect, it } from 'bun:test';
import type {
    CompressionBackendRequest,
    FetchLike,
} from '../types';
import { EdgeeBackend } from './edgee';

const request: CompressionBackendRequest = {
    toolCallId: 'call-1',
    toolName: 'read',
    arguments: { path: 'src/main.ts', limit: 20 },
    output: 'long output',
    model: {
        provider: 'anthropic',
        id: 'claude-sonnet-4-6',
        contextWindow: 200000,
    },
};

function jsonFetch(body: unknown, status = 200): FetchLike {
    return async () => Response.json(body, { status });
}

function bodyOf(init?: RequestInit): Record<string, unknown> {
    return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe('EdgeeBackend', () => {
    it.each(['bash', 'read', 'grep'])(
        'sends canonical tool name %s unchanged',
        async (toolName) => {
            let seen: Record<string, unknown> | undefined;
            const fetchImpl: FetchLike = async (_input, init) => {
                seen = bodyOf(init);
                return Response.json({ compressed_output: 'short' });
            };

            const result = await new EdgeeBackend(
                { baseUrl: 'http://edgee.test/', timeoutMs: 100 },
                fetchImpl,
            ).compress({ ...request, toolName });

            expect(result).toEqual({ output: 'short' });
            expect(seen?.tool_name).toBe(toolName);
        },
    );

    it.each(['ls', 'find'])(
        'does not send unsupported tool %s or make a network request',
        async (toolName) => {
            let calls = 0;
            const fetchImpl: FetchLike = async () => {
                calls += 1;
                return Response.json({ compressed_output: 'should not be used' });
            };

            const result = await new EdgeeBackend(
                { baseUrl: 'http://edgee.test/', timeoutMs: 100 },
                fetchImpl,
            ).compress({ ...request, toolName });

            expect(calls).toBe(0);
            expect(result).toEqual({ output: null, reason: 'unsupported_tool' });
        },
    );

    it('maps safe_bash to bash without changing the original request', async () => {
        let seen: Record<string, unknown> | undefined;
        const fetchImpl: FetchLike = async (_input, init) => {
            seen = bodyOf(init);
            return Response.json({ compressed_output: 'short' });
        };

        await new EdgeeBackend(
            { baseUrl: 'http://edgee.test', timeoutMs: 100 },
            fetchImpl,
        ).compress({ ...request, toolName: 'safe_bash' });

        expect(seen?.tool_name).toBe('bash');
    });

    it('does not send unsupported tools under a guessed alias', async () => {
        let calls = 0;
        const fetchImpl: FetchLike = async () => {
            calls += 1;
            return Response.json({ compressed_output: 'should not be used' });
        };

        const result = await new EdgeeBackend(
            { baseUrl: 'http://edgee.test', timeoutMs: 100 },
            fetchImpl,
        ).compress({ ...request, toolName: 'write' });

        expect(calls).toBe(0);
        expect(result).toEqual({ output: null, reason: 'unsupported_tool' });
    });

    it('posts to /compress with JSON-encoded arguments and configured agent', async () => {
        let input: string | URL | Request | undefined;
        let init: RequestInit | undefined;
        const fetchImpl: FetchLike = async (requestInput, requestInit) => {
            input = requestInput;
            init = requestInit;
            return Response.json({ compressed_output: 'short' });
        };

        await new EdgeeBackend(
            { baseUrl: 'http://edgee.test/', timeoutMs: 100, agent: 'claude' },
            fetchImpl,
        ).compress(request);

        expect(input).toBe('http://edgee.test/compress');
        expect(init?.method).toBe('POST');
        expect(init?.headers).toEqual({ 'content-type': 'application/json' });
        expect(bodyOf(init)).toEqual({
            tool_name: 'read',
            arguments: JSON.stringify(request.arguments),
            output: request.output,
            agent: 'claude',
        });
    });

    it('normalizes valid output and service metrics', async () => {
        const result = await new EdgeeBackend(
            { baseUrl: 'http://edgee.test', timeoutMs: 100 },
            jsonFetch({
                compressed_output: 'short',
                details: {
                    tokens_before: 100,
                    tokens_after: 40,
                    tokens_saved: 60,
                    transforms: ['segments'],
                },
            }),
        ).compress(request);

        expect(result).toEqual({
            output: 'short',
            metrics: {
                tokensBefore: 100,
                tokensAfter: 40,
                tokensSaved: 60,
                transforms: ['segments'],
            },
        });
    });

    it.each([
        ['empty output', { compressed_output: '' }, 'no_output'],
        ['null output', { compressed_output: null }, 'no_output'],
        ['missing output', {}, 'invalid_response'],
        ['numeric output', { compressed_output: 42 }, 'invalid_response'],
        ['object output', { compressed_output: { value: 'short' } }, 'invalid_response'],
        ['boolean output', { compressed_output: true }, 'invalid_response'],
        ['array output', { compressed_output: ['short'] }, 'invalid_response'],
    ])('normalizes %s', async (_label, body, reason) => {
        await expect(
            new EdgeeBackend(
                { baseUrl: 'http://edgee.test', timeoutMs: 100 },
                jsonFetch(body),
            ).compress(request),
        ).resolves.toEqual({ output: null, reason });
    });

    it('normalizes non-2xx responses without throwing', async () => {
        await expect(
            new EdgeeBackend(
                { baseUrl: 'http://edgee.test', timeoutMs: 100 },
                jsonFetch({}, 503),
            ).compress(request),
        ).resolves.toEqual({ output: null, reason: 'http_error' });
    });

    it('normalizes invalid JSON without throwing', async () => {
        const fetchImpl: FetchLike = async () =>
            new Response('{not-json', {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });

        await expect(
            new EdgeeBackend(
                { baseUrl: 'http://edgee.test', timeoutMs: 100 },
                fetchImpl,
            ).compress(request),
        ).resolves.toEqual({ output: null, reason: 'invalid_response' });
    });

    it('passes the caller AbortSignal and normalizes aborts', async () => {
        let receivedSignal: AbortSignal | undefined;
        const fetchImpl: FetchLike = async (_input, init) => {
            receivedSignal = init?.signal as AbortSignal;
            return new Promise<Response>((_, reject) => {
                receivedSignal?.addEventListener('abort', () =>
                    reject(new DOMException('Aborted', 'AbortError')),
                );
            });
        };
        const controller = new AbortController();
        const promise = new EdgeeBackend(
            { baseUrl: 'http://edgee.test', timeoutMs: 1000 },
            fetchImpl,
        ).compress(request, controller.signal);
        controller.abort();

        await expect(promise).resolves.toEqual({
            output: null,
            reason: 'aborted',
        });
        expect(receivedSignal?.aborted).toBe(true);
    });

    it('normalizes timeout without throwing', async () => {
        const fetchImpl: FetchLike = async (_input, init) =>
            new Promise<Response>((_, reject) => {
                init?.signal?.addEventListener('abort', () =>
                    reject(new DOMException('Aborted', 'AbortError')),
                );
            });

        await expect(
            new EdgeeBackend(
                { baseUrl: 'http://edgee.test', timeoutMs: 1 },
                fetchImpl,
            ).compress(request),
        ).resolves.toEqual({ output: null, reason: 'timeout' });
    });
});