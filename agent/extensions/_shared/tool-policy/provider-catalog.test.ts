import { expect, test } from 'bun:test';
import { injectProviderToolsCatalog, appendToolsListPrompt, CATALOG_START } from './provider-catalog.ts';

const fn = { name: 'edit', description: 'Edit a file', parameters: { type: 'object' } };
const cases: Array<[string, Record<string, unknown>]> = [
    ['openai-completions', { messages: [{ role: 'system', content: 'Custom' }], tools: [{ type: 'function', function: fn }] }],
    ['mistral-conversations', { messages: [{ role: 'system', content: 'Custom' }], tools: [{ type: 'function', function: fn }] }],
    ['openai-responses', { input: [{ role: 'developer', content: 'Custom' }], tools: [{ type: 'function', ...fn }] }],
    ['azure-openai-responses', { input: [], instructions: 'Custom', tools: [{ type: 'function', ...fn }] }],
    ['openai-codex-responses', { input: [], instructions: 'Custom', tools: [{ type: 'function', ...fn }] }],
    ['anthropic-messages', { messages: [], system: [{ type: 'text', text: 'Custom', cache_control: { type: 'ephemeral' } }], tools: [{ ...fn, input_schema: {} }] }],
    ['google-generative-ai', { contents: [], config: { systemInstruction: 'Custom', tools: [{ functionDeclarations: [fn] }] } }],
    ['google-vertex', { contents: [], config: { systemInstruction: { parts: [{ text: 'Custom' }] }, tools: [{ functionDeclarations: [fn] }] } }],
    ['bedrock-converse-stream', { messages: [], system: [{ text: 'Custom' }, { cachePoint: { type: 'default' } }], toolConfig: { tools: [{ toolSpec: { ...fn, inputSchema: { json: {} } } }] } }],
    ['pi-messages', { context: { systemPrompt: 'Custom', messages: [], tools: [fn] } }],
];
for (const [api, payload] of cases) {
    test(`${api}: injects exactly the request tools and preserves the original payload`, () => {
        const original = structuredClone(payload);
        const result = injectProviderToolsCatalog(api, payload);
        expect(result.supported).toBe(true);
        if (!result.supported) throw new Error(result.reason);
        expect(result.tools.map(t => t.name)).toEqual(['edit']);
        expect(JSON.stringify(result.payload)).toContain('- edit: Edit a file');
        expect(payload).toEqual(original);
        const repeated = injectProviderToolsCatalog(api, result.payload);
        expect(repeated).toEqual(result);
    });
}
test('replaces stale lists while retaining unrelated headings and descriptions without text', () => {
    const prompt = 'User explanation of Available tools:\nKeep this text.';
    const first = appendToolsListPrompt(prompt, [{ name: 'read' }]);
    const second = appendToolsListPrompt(first, [{ name: 'edit' }]);
    expect(second).toContain(prompt);
    expect(second).toContain('- edit');
    expect(second).not.toContain('- read');
    expect(second.split(CATALOG_START)).toHaveLength(2);
});
test('separates deferred schemas and ignores provider-native tools', () => {
    const payload = { input: [{ type: 'additional_tools', role: 'developer', tools: [{ type: 'function', ...fn }] }], tools: [{ type: 'web_search_preview' }, { type: 'function', name: 'read', parameters: {} }] };
    const result = injectProviderToolsCatalog('openai-responses', payload);
    expect(result.supported).toBe(true);
    if (!result.supported) throw new Error(result.reason);
    expect(result.tools).toEqual([{ name: 'read', description: undefined, deferred: false }, { name: 'edit', description: 'Edit a file', deferred: true }]);
    expect(result.block).toContain('Deferred tools');
    expect((result.payload as typeof payload).input).toContainEqual(payload.input[0]);
});
test('reports an explicit empty catalog', () => {
    const result = injectProviderToolsCatalog('openai-completions', { messages: [{ role: 'system', content: 'Custom' }] });
    expect(result.supported && result.block).toContain('(no immediate function tools)');
});
test('keeps valid empty system block shapes for Google and Bedrock', () => {
    const google = injectProviderToolsCatalog('google-vertex', { contents: [], config: { systemInstruction: { parts: [] }, tools: [] } });
    const bedrock = injectProviderToolsCatalog('bedrock-converse-stream', { messages: [], system: [] });
    expect(google.supported && google.payload).toMatchObject({ config: { systemInstruction: { parts: [{ text: expect.any(String) }] } } });
    expect(JSON.stringify(google.supported && google.payload)).not.toContain('"type":"text"');
    expect(JSON.stringify(bedrock.supported && bedrock.payload)).not.toContain('"type":"text"');
    const optionalParts = injectProviderToolsCatalog('google-vertex', { contents: [], config: { systemInstruction: { role: 'user' }, tools: [] } });
    expect(optionalParts.supported && optionalParts.payload).toMatchObject({ config: { systemInstruction: { role: 'user', parts: [{ text: expect.any(String) }] } } });
});
test('rejects unknown API and malformed schema rather than using live or cached tools', () => {
    expect(injectProviderToolsCatalog('future-api', {}).supported).toBe(false);
    expect(injectProviderToolsCatalog('openai-completions', { messages: [], tools: [{}] }).supported).toBe(false);
    expect(injectProviderToolsCatalog('google-vertex', { messages: [], tools: [] }).supported).toBe(false);
});
