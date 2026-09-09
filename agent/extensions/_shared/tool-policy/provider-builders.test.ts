import { expect, test, mock } from 'bun:test';
import { zstdDecompressSync } from 'node:zlib';
import { Type, type Api, type Model, type StreamOptions } from '@earendil-works/pi-ai';
import { injectProviderToolsCatalog } from './provider-catalog.ts';

let transported: unknown;
const google = await import('@google/genai');
mock.module('@google/genai', () => ({ ...google, GoogleGenAI: class {
    models = { generateContentStream: async (payload: unknown) => {
        transported = payload;
        return (async function* () {})();
    } };
} }));
const bedrock = await import('@aws-sdk/client-bedrock-runtime');
mock.module('@aws-sdk/client-bedrock-runtime', () => ({ ...bedrock, BedrockRuntimeClient: class {
    middlewareStack = { add() {} };
    async send(command: { input: unknown }) {
        transported = command.input;
        return { stream: (async function* () {})(), $metadata: {} };
    }
} }));

const apis = ['openai-completions', 'openai-responses', 'azure-openai-responses', 'openai-codex-responses',
    'anthropic-messages', 'google-generative-ai', 'google-vertex', 'bedrock-converse-stream',
    'mistral-conversations', 'pi-messages'] as const;

for (const api of apis) test(`${api}: real request builder reaches only the simulated transport with the final catalog`, async () => {
    transported = undefined;
    const model: Model<Api> = { api, id: 'fixture', name: 'fixture', provider: 'fixture',
        baseUrl: 'https://fixture.invalid', reasoning: false, input: ['text'],
        contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const jwt = `fixture.${btoa(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } }))}.fixture`;
    let transformed: unknown;
    const fetch: typeof globalThis.fetch = Object.assign(async (_url: unknown, init?: RequestInit) => {
        const body = new Headers(init?.headers).get('content-encoding') === 'zstd'
            ? zstdDecompressSync(init!.body as Uint8Array).toString('utf8') : String(init?.body);
        transported = JSON.parse(body);
        return new Response('fixture transport stop', { status: 400 });
    }, { preconnect() {} });
    const options: StreamOptions = { apiKey: api === 'openai-codex-responses' ? jwt : 'fixture-not-a-secret',
        transport: 'sse', maxRetries: 0,
        env: { GOOGLE_CLOUD_PROJECT: 'fixture', GOOGLE_CLOUD_LOCATION: 'us-central1', AWS_REGION: 'us-east-1', AZURE_OPENAI_API_VERSION: '2025-04-01-preview' },
        ...(!['google-generative-ai', 'google-vertex', 'bedrock-converse-stream'].includes(api) ? { fetch } : {}),
        onPayload(payload) {
            const result = injectProviderToolsCatalog(api, payload);
            expect(result.supported).toBe(true);
            if (!result.supported) throw new Error(result.reason);
            expect(result.tools.map(t => t.name)).toEqual(['edit', 'safe_bash']);
            transformed = result.payload;
            return transformed;
        },
    };
    const { stream } = await import(`@earendil-works/pi-ai/api/${api}`);
    const result = await stream(model, { systemPrompt: 'Custom SYSTEM', messages: [{ role: 'user', content: 'fixture', timestamp: 0 }],
        tools: ['edit', 'safe_bash'].map(name => ({ name, description: `${name} description`, parameters: Type.Object({}) })) }, options).result();
    expect(transformed, result.errorMessage).toBeDefined();
    expect(transported, result.errorMessage).toEqual(transformed);
    expect(JSON.stringify(transported)).toContain('<pi-runtime-tools>');
});
